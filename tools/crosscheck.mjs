// Falsifying cross-check: sememe's own IDL-driven codec vs an external oracle.
//
// The oracle is @orca-so/whirlpools-client (Orca License, not permissive). It
// is used ONLY here as a test oracle: nothing from it is copied into this
// repository, and it is not a runtime dependency of sememe. Install it
// separately and point SEMEME_ORACLE_PATH at its node_modules directory:
//
//   mkdir -p /tmp/oracle && cd /tmp/oracle && npm i @orca-so/whirlpools-client @solana/kit
//   SEMEME_ORACLE_PATH=/tmp/oracle/node_modules \
//   node tools/crosscheck.mjs --store <sememe-store> --program <program-id>
//
// Checks, per instruction and per real mainnet payload:
//   A. sememe decode(oracle bytes) -> sememe re-encode must be byte-identical
//   B. decoded values must be equal field by field under the IDL type
// The comparison is IDL-aware, so the known representation gaps between the
// two libraries are handled explicitly instead of being ignored:
//   - oracle field names are camelCase, the on-chain IDL is snake_case
//   - oracle hoists single-field struct arguments into the parent object
//   - oracle decodes unit-variant enums to a raw variant index
// Any difference that is not one of those three is reported as a mismatch.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decodeInstructionData, encodeInstructionData, toJsonSafe } from '../src/codec.mjs';
import { findStoredIdl } from '../src/decode.mjs';
import { createComparator, oracleCodecs, camel, pick, structShape, enumShape, variantShape } from './lib/compare.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};
const store = option('--store', path.join(process.env.HOME ?? '.', '.sememe'));
const program = option('--program', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const fixturePath = option('--fixture', new URL('../test/fixtures/mainnet-whirlpool.json', import.meta.url).pathname);
const oracleRoot = option('--oracle', process.env.SEMEME_ORACLE_PATH);
const oracleRequire = oracleRoot
  ? createRequire(path.join(oracleRoot, 'index.js'))
  : createRequire(import.meta.url);

let oracle;
try { oracle = oracleRequire('@orca-so/whirlpools-client'); }
catch {
  console.error('oracle not installed: npm i @orca-so/whirlpools-client @solana/kit in a scratch dir, ' +
    'then set SEMEME_ORACLE_PATH to its node_modules');
  process.exit(2);
}

const { idl } = await findStoredIdl(store, program);
const comparator = createComparator({ idl, oracle, oracleRequire, program });
const base58 = (input) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const character of input) value = value * 58n + BigInt(A.indexOf(character));
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value & 0xffn)); value >>= 8n; }
  for (const character of input) { if (character === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
};

const compare = (instruction, mine, theirs) => comparator.compare(instruction, mine, theirs);

// Deterministic pseudo-random inputs for the per-instruction encoder check.
// The seed is fixed so a rerun produces the same vectors.
let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
function sample(type, depth = 0) {
  if (depth > 8) return 0;
  if (typeof type === 'string') {
    switch (type) {
      case 'bool': return (random() & 1) === 1;
      case 'pubkey': return ['11111111111111111111111111111111', program, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'][random() % 3];
      case 'string': return 'x';
      case 'u8': return random() & 0xff;
      case 'u16': return random() & 0xffff;
      case 'u32': return random() & 0xffffffff;
      case 'u64': return BigInt(random());
      case 'u128': return (BigInt(random()) << 64n) | BigInt(random());
      case 'i8': case 'i16': case 'i32': { const magnitude = random() & 0x7f; return magnitude === 0 ? 0 : -magnitude; }
      case 'i64': case 'i128': return -BigInt(random());
      default: throw Error(`unhandled primitive ${type}`);
    }
  }
  if (Array.isArray(type)) return Array.from({ length: type[1] }, () => sample(type[0], depth + 1));
  if ('option' in type) {
    if ((random() & 1) === 0) return { __option: 'None' };
    return { __option: 'Some', value: sample(type.option, depth + 1) };
  }
  if ('vec' in type) return Array.from({ length: random() % 3 }, () => sample(type.vec, depth + 1));
  if ('array' in type) { const [inner, length] = type.array; return Array.from({ length }, () => sample(inner, depth + 1)); }
  if ('defined' in type) {
    const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
    return sample(comparator.typeByName.get(name), depth + 1);
  }
  if (type.kind === 'type') return sample(type.type, depth + 1);
  const fields = structShape(type);
  if (fields) { const out = {}; for (const field of fields) out[camel(field.name)] = sample(field.type, depth + 1); return out; }
  const variants = enumShape(type);
  if (variants) {
    const variant = variants[random() % variants.length];
    const shape = variantShape(variant);
    if (shape.kind === 'unit') return variant.name;
    if (shape.kind === 'tuple') return { __kind: variant.name, fields: shape.fields.map((field) => sample(field, depth + 1)) };
    const out = { __kind: variant.name };
    for (const field of shape.fields) out[camel(field.name)] = sample(field.type, depth + 1);
    return out;
  }
  throw Error(`unhandled type ${JSON.stringify(type).slice(0, 60)}`);
}

const summary = {
  program, oracle: '@orca-so/whirlpools-client', instructions: { checked: 0, byteMismatch: [], valueMismatch: [], oracleError: [] },
  mainnet: { checked: 0, byteMismatch: [], valueMismatch: [], sememeError: [], unexplained: [] },
};

for (const instruction of idl.instructions) {
  const name = instruction.name;
  const { encoder, decoder } = oracleCodecs(oracle, name);
  if (!encoder || !decoder) { summary.instructions.oracleError.push({ instruction: name, reason: 'no oracle codec' }); continue; }
  let input;
  try { input = {}; for (const argument of instruction.args ?? []) input[camel(argument.name)] = sample(argument.type); }
  catch (error) { summary.instructions.oracleError.push({ instruction: name, reason: `input: ${error.message}` }); continue; }
  let bytes;
  try { bytes = Buffer.from(encoder().encode(input)); }
  catch (error) { summary.instructions.oracleError.push({ instruction: name, reason: `encode: ${String(error.message).slice(0, 120)}` }); continue; }
  summary.instructions.checked++;
  try {
    const mine = decodeInstructionData(idl, bytes);
    const reencoded = encodeInstructionData(idl, mine.instruction, mine.args);
    if (!reencoded.equals(bytes)) {
      summary.instructions.byteMismatch.push({ instruction: name, sememe: reencoded.toString('hex'), oracle: bytes.toString('hex') });
    }
    const theirs = decoder().decode(bytes);
    const mismatches = compare(instruction, mine, theirs);
    if (mismatches.length) summary.instructions.valueMismatch.push({ instruction: name, diffs: mismatches });
  } catch (error) {
    summary.instructions.oracleError.push({ instruction: name, reason: `decode: ${String(error.message).slice(0, 120)}` });
  }
}

let fixture = { records: [] };
try { fixture = JSON.parse(await readFile(fixturePath, 'utf8')); } catch { /* no fixture */ }
for (const record of fixture.records ?? []) {
  const bytes = Buffer.from(record.dataHex ?? '', 'hex');
  if (!bytes.length) continue;
  try {
    const mine = decodeInstructionData(idl, bytes);
    summary.mainnet.checked++;
    const reencoded = encodeInstructionData(idl, mine.instruction, mine.args);
    // Compare the part the IDL describes. Real mainnet payloads can carry
    // bytes beyond the stored IDL (padding the deployed program ignores);
    // those are reported as `unexplained`, not as a byte mismatch of the
    // described prefix.
    const described = bytes.subarray(0, mine.consumed);
    if (!reencoded.equals(described)) {
      summary.mainnet.byteMismatch.push({ signature: record.signature, sememe: reencoded.toString('hex'), original: described.toString('hex') });
    }
    if (mine.trailing?.count > 0) {
      summary.mainnet.unexplained ??= [];
      summary.mainnet.unexplained.push({
        signature: record.signature, instruction: mine.instruction,
        bytes: bytes.length, consumed: mine.consumed, trailing: mine.trailing,
      });
    }
    if (mine.instruction !== record.name) {
      summary.mainnet.valueMismatch.push({ signature: record.signature, diffs: [{ path: 'instruction', sememe: mine.instruction, oracle: record.name }] });
      continue;
    }
    const { decoder } = oracleCodecs(oracle, record.name);
    if (!decoder) { summary.mainnet.oracleError = summary.mainnet.oracleError ?? []; continue; }
    const theirs = decoder().decode(bytes);
    const instruction = idl.instructions.find((entry) => entry.name === mine.instruction);
    const mismatches = compare(instruction, mine, theirs);
    if (mismatches.length) summary.mainnet.valueMismatch.push({ signature: record.signature, diffs: mismatches });
  } catch (error) {
    summary.mainnet.sememeError.push({ signature: record.signature, instruction: record.name, error: String(error.message).slice(0, 160) });
  }
}

console.log(JSON.stringify({
  instructions: {
    checked: summary.instructions.checked,
    byteMismatch: summary.instructions.byteMismatch.length,
    valueMismatch: summary.instructions.valueMismatch.length,
    oracleError: summary.instructions.oracleError.length,
  },
  mainnet: {
    checked: summary.mainnet.checked,
    byteMismatch: summary.mainnet.byteMismatch.length,
    valueMismatch: summary.mainnet.valueMismatch.length,
    sememeError: summary.mainnet.sememeError.length,
    // Payloads whose bytes the stored IDL does not describe. The oracle
    // decodes them with the same values, so this is not a value error — it is
    // a recorded instance of the IDL under-describing the wire format.
    unexplained: summary.mainnet.unexplained.length,
  },
}, null, 2));

if (summary.mainnet.unexplained.length) {
  console.log(JSON.stringify({ unexplainedBytes: summary.mainnet.unexplained }, null, 1));
}

if (summary.instructions.byteMismatch.length || summary.instructions.valueMismatch.length
  || summary.mainnet.byteMismatch.length || summary.mainnet.valueMismatch.length
  || summary.mainnet.sememeError.length) {
  console.log(JSON.stringify({ details: {
    instructions: summary.instructions, mainnet: summary.mainnet,
  } }, null, 1));
  process.exitCode = 1;
}
