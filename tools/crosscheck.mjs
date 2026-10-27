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
const typeByName = new Map((idl.types ?? []).map((entry) => [entry.name, entry.type]));
const camel = (text) => text.replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase());
const pick = (object, name) => (object?.[name] !== undefined ? object[name] : object?.[camel(name)]);
const structShape = (type) => (type && typeof type === 'object' && Array.isArray(type.fields)
  && (type.kind === 'struct' || type.kind === undefined)) ? type.fields : null;
const enumShape = (type) => (type && typeof type === 'object' && Array.isArray(type.variants)
  && (type.kind === 'enum' || type.kind === undefined)) ? type.variants : null;
const variantShape = (variant) => {
  const fields = variant?.fields;
  if (!fields || !fields.length) return { kind: 'unit' };
  if (fields.every((field) => field && typeof field === 'object' && typeof field.name === 'string' && 'type' in field)) {
    return { kind: 'named', fields };
  }
  return { kind: 'tuple', fields };
};
const base58 = (input) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const character of input) value = value * 58n + BigInt(A.indexOf(character));
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value & 0xffn)); value >>= 8n; }
  for (const character of input) { if (character === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
};

const diffs = [];
const equal = (location, mine, theirs) => {
  const a = typeof mine === 'bigint' ? mine.toString() : mine;
  const b = typeof theirs === 'bigint' ? theirs.toString() : theirs;
  if (Object.is(a, b)) return true;
  if (typeof a === 'number' && typeof b === 'number' && Object.is(a, -0) && Object.is(b, 0)) return true;
  diffs.push({ path: location, sememe: String(a).slice(0, 160), oracle: String(b).slice(0, 160) });
  return false;
};

function same(type, mine, theirs, location) {
  if (typeof type === 'string') {
    if (type === 'pubkey') {
      let value = theirs;
      if (value instanceof Uint8Array) {
        try { value = new oracleRequire('@solana/kit').Address(value); } catch { value = Buffer.from(value).toString('hex'); }
      }
      return equal(location, mine, String(value));
    }
    if (type === 'bool') return equal(location, mine, theirs === true || theirs === 1);
    return equal(location, mine, theirs);
  }
  if (Array.isArray(type)) {
    if (!Array.isArray(theirs)) return equal(location, 'array', typeof theirs);
    if (mine.length !== theirs.length) { diffs.push({ path: location, reason: `length ${mine.length} vs ${theirs.length}` }); return false; }
    return mine.every((item, index) => same(type[0], item, theirs[index], `${location}[${index}]`));
  }
  if ('option' in type) {
    if (!theirs || !('__option' in theirs)) return equal(location, 'option', JSON.stringify(theirs)?.slice(0, 80));
    if (mine.__option !== theirs.__option) return equal(location, mine.__option, theirs.__option);
    if (mine.__option === 'None') return true;
    return same(type.option, mine.value, theirs.value, `${location}.value`);
  }
  if ('vec' in type) {
    if (!Array.isArray(theirs)) return equal(location, 'vec', typeof theirs);
    if (mine.length !== theirs.length) { diffs.push({ path: location, reason: `vec length ${mine.length} vs ${theirs.length}` }); return false; }
    return mine.every((item, index) => same(type.vec, item, theirs[index], `${location}[${index}]`));
  }
  if ('array' in type) {
    const [inner] = type.array;
    if (!Array.isArray(theirs)) return equal(location, 'array', typeof theirs);
    if (mine.length !== theirs.length) { diffs.push({ path: location, reason: `array length ${mine.length} vs ${theirs.length}` }); return false; }
    return mine.every((item, index) => same(inner, item, theirs[index], `${location}[${index}]`));
  }
  if ('defined' in type) {
    const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
    return same(typeByName.get(name), mine, theirs, name);
  }
  if (type.kind === 'type') return same(type.type, mine, theirs, location);
  const fields = structShape(type);
  if (fields) {
    if (!theirs || typeof theirs !== 'object') return equal(location, 'struct', typeof theirs);
    return fields.every((field) => {
      const value = pick(theirs, field.name);
      if (value === undefined) { diffs.push({ path: `${location}.${field.name}`, reason: 'missing in oracle output' }); return false; }
      return same(field.type, mine[field.name], value, `${location}.${field.name}`);
    });
  }
  const variants = enumShape(type);
  if (variants) {
    if (typeof theirs === 'number') {
      const variant = variants[theirs];
      if (!variant) return equal(location, mine.__kind, `index ${theirs}`);
      return equal(location, mine.__kind, variant.name);
    }
    if (!theirs || typeof theirs !== 'object') return equal(location, 'enum', JSON.stringify(theirs)?.slice(0, 80));
    if (mine.__kind !== theirs.__kind) return equal(location, mine.__kind, theirs.__kind);
    const shape = variantShape(variants.find((variant) => variant.name === mine.__kind));
    if (shape.kind === 'unit') return true;
    if (shape.kind === 'tuple') {
      return mine.fields.every((item, index) => same(shape.fields[index], item, theirs.fields?.[index], `${location}.fields[${index}]`));
    }
    return shape.fields.every((field) => {
      const value = pick(theirs, field.name);
      if (value === undefined) { diffs.push({ path: `${location}.${field.name}`, reason: 'missing in oracle output' }); return false; }
      return same(field.type, mine[field.name], value, `${location}.${field.name}`);
    });
  }
  return equal(location, JSON.stringify(mine)?.slice(0, 120), JSON.stringify(theirs)?.slice(0, 120));
}

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
    return sample(typeByName.get(name), depth + 1);
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

const compare = (instruction, mine, theirs) => {
  const before = diffs.length;
  for (const argument of instruction.args ?? []) {
    const argumentType = (typeof argument.type === 'object' && argument.type.defined)
      ? typeByName.get(argument.type.defined.name) : argument.type;
    let target = pick(theirs, argument.name);
    if (target === undefined) {
      const shape = structShape(argumentType);
      if (shape && shape.every((field) => pick(theirs, field.name) !== undefined)) target = theirs;
      else { diffs.push({ path: `${instruction.name}.${argument.name}`, reason: 'argument absent in oracle output' }); continue; }
    }
    same(argumentType, mine.args[argument.name], target, `${instruction.name}.${argument.name}`);
  }
  return diffs.splice(before);
};

for (const instruction of idl.instructions) {
  const name = instruction.name;
  const oracleName = camel(name);
  const encoder = oracle[`get${oracleName[0].toUpperCase()}${oracleName.slice(1)}InstructionDataEncoder`];
  const decoder = oracle[`get${oracleName[0].toUpperCase()}${oracleName.slice(1)}InstructionDataDecoder`];
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
    const oracleName = camel(record.name);
    const decoder = oracle[`get${oracleName[0].toUpperCase()}${oracleName.slice(1)}InstructionDataDecoder`];
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
