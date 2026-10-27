// Decoder-parity measurement: can sememe's stored-IDL codec replace a real
// first-party decoder path?
//
// This measures sememe's IDL-driven codec against solana-tx-remix's own
// Whirlpool decoder path (src/args.mjs, which parses the generated Codama
// codec modules and decodes argument bytes field by field). Both run on the
// same real mainnet instruction bytes.
//
// The question is not "do both produce a string" but: for every field, do
// both paths decode it, and do they agree? A replacement is only honest if
// the field set and the values line up; the tool reports the differences
// instead of hiding them.
//
// Usage:
//   node tools/decoder-parity.mjs \
//     --store <sememe-store> --program <program-id> \
//     --tx-remix <path to solana-tx-remix checkout> \
//     --generated <path to Codama-generated instruction dir> \
//     --fixture <mainnet fixture json>
//
// The generated Codama modules are the Orca reference client (Orca License)
// and are used here as the first-party decoder's own input, never copied.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeInstructionData, toJsonSafe } from '../src/codec.mjs';
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
const store = option('--store', null);
const program = option('--program', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const txRemixDir = option('--tx-remix', null);
const generatedDir = option('--generated', null);
const fixturePath = option('--fixture', new URL('../test/fixtures/mainnet-whirlpool.json', import.meta.url).pathname);

if (!store || !txRemixDir || !generatedDir) {
  console.error('usage: node tools/decoder-parity.mjs --store <dir> --tx-remix <dir> --generated <dir> [--fixture <file>]');
  process.exit(2);
}

const { idl } = await findStoredIdl(store, program);
const { decodeArgs, schemaForInstruction } = await import(
  pathToFileURL(path.join(txRemixDir, 'src', 'args.mjs')).href);

const camelToSnake = (name) => name.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
const normalize = (value) => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = normalize(value[key]);
    return out;
  }
  return value;
};

const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const results = {
  program,
  txRemixDecoder: 'solana-tx-remix src/args.mjs (decodeArgs + schemaForInstruction)',
  sememeDecoder: 'sememe src/codec.mjs (stored on-chain IDL)',
  perRecord: [],
  // `disagreed` = both paths decoded the field and the values differ (a real
  // conflict). `firstPartyRefuses` = the first-party path returned a marker
  // such as __optionRemaining instead of a value — no comparable output exists,
  // so it is not a disagreement and must not be counted as one.
  totals: {
    records: 0, fieldsCompared: 0, agreed: 0, disagreed: 0,
    firstPartyRefuses: 0, onlySememe: 0, onlyTxRemix: 0,
  },
  instructionLevel: [],
};

for (const record of fixture.records ?? []) {
  const bytes = Buffer.from(record.dataHex, 'hex');
  let sememe;
  try { sememe = decodeInstructionData(idl, bytes); }
  catch (error) {
    results.perRecord.push({ signature: record.signature, instruction: record.name, sememeError: String(error.message).slice(0, 160) });
    continue;
  }
  const schema = schemaForInstruction(generatedDir, record.name);
  const argumentBytes = bytes.subarray(8);
  const theirs = decodeArgs(schema, argumentBytes);
  const theirFields = theirs && typeof theirs === 'object' ? theirs : {};

  const perField = [];
  for (const [name, value] of Object.entries(toJsonSafe(sememe.args))) {
    const theirName = Object.keys(theirFields).find((key) => camelToSnake(key) === name);
    if (theirName === undefined) {
      perField.push({ field: name, status: 'only-sememe', sememe: JSON.stringify(value)?.slice(0, 80) });
      results.totals.onlySememe++;
      continue;
    }
    const theirValue = normalize(theirFields[theirName]);
    if (theirValue && typeof theirValue === 'object' && !Array.isArray(theirValue)
        && Object.keys(theirValue).some((key) => key.startsWith('__'))) {
      perField.push({ field: name, status: 'tx-remix-unsupported', txRemix: JSON.stringify(theirValue)?.slice(0, 80), sememe: JSON.stringify(value)?.slice(0, 80) });
      results.totals.firstPartyRefuses++;
      continue;
    }
    const sememeValue = normalize(value);
    const same = JSON.stringify(sememeValue) === JSON.stringify(theirValue);
    perField.push({ field: name, status: same ? 'agree' : 'disagree', sememe: JSON.stringify(sememeValue)?.slice(0, 80), txRemix: JSON.stringify(theirValue)?.slice(0, 80) });
    results.totals.fieldsCompared++;
    if (same) results.totals.agreed++; else results.totals.disagreed++;
  }
  // fields the first-party path produced that sememe does not have
  for (const key of Object.keys(theirFields)) {
    if (key.startsWith('__')) continue;
    if (!Object.keys(toJsonSafe(sememe.args)).some((name) => camelToSnake(key) === name)) {
      perField.push({ field: key, status: 'only-tx-remix', txRemix: JSON.stringify(normalize(theirFields[key]))?.slice(0, 80) });
      results.totals.onlyTxRemix++;
    }
  }
  results.totals.records++;
  results.perRecord.push({ signature: record.signature, instruction: record.name, fields: perField });
}

// Per-instruction schema coverage: which Whirlpool instructions can the
// first-party path even describe, and which can sememe decode?
for (const instruction of idl.instructions) {
  const schema = schemaForInstruction(generatedDir, instruction.name);
  const argumentTypes = (instruction.args ?? []).map((argument) => argument.type);
  const hasOption = JSON.stringify(argumentTypes).includes('"option"');
  const hasDefined = JSON.stringify(argumentTypes).includes('"defined"');
  results.instructionLevel.push({
    instruction: instruction.name,
    txRemixSchemaFound: Boolean(schema),
    txRemixFieldCount: schema ? schema.length : 0,
    idlUsesOption: hasOption,
    idlUsesDefinedType: hasDefined,
  });
}

const txRemixSchemas = results.instructionLevel.filter((entry) => entry.txRemixSchemaFound).length;
const unsupportedByFirstParty = results.instructionLevel.filter((entry) => entry.idlUsesOption || entry.idlUsesDefinedType);
const summary = {
  ...results.totals,
  txRemixSchemasFound: txRemixSchemas,
  instructionsInIdl: results.instructionLevel.length,
  instructionsWithOptionOrDefinedArgs: unsupportedByFirstParty.length,
  instructionsFirstPartyCannotFullyDecode: unsupportedByFirstParty.map((entry) => entry.instruction),
};
console.log(JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ sample: results.perRecord.slice(0, 3) }, null, 1));
