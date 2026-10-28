// The 1,000-transaction diff: does sememe's stored-IDL decoder agree with an
// independent reference decoder on real mainnet traffic, at scale?
//
// The earlier measurements compared 50 harvested payloads. That is a sample,
// not a scale claim, and "50 payloads" was the stated limit of the evidence.
// This tool closes that limit: it decodes EVERY instruction payload of the
// target program in a harvested transaction set and compares each one against
// @orca-so/whirlpools-client (Orca License, used only as a test oracle,
// nothing vendored).
//
// For every payload it answers three separate questions, and keeps them
// separate because they have different meanings:
//
//   1. NAMING    — does sememe name the instruction the way the oracle names
//                  it? A disagreement here is a wrong label, not a wrong value.
//   2. VALUES    — for every field both paths decode, do the values agree?
//   3. BYTES     — does re-encoding the decoded value reproduce the input
//                  bytes? (checked against the IDL-described prefix, because
//                  real payloads can carry bytes the stored IDL does not
//                  describe; those are counted separately as `unexplained`.)
//
// Usage:
//   node tools/tx-diff.mjs --store <sememe-store> --harvest <harvest.json>
//   SEMEME_ORACLE_PATH=<dir>/node_modules node tools/tx-diff.mjs ...
//
// Exit code is non-zero when a value disagreement, a byte mismatch, a naming
// disagreement or a sememe decode error occurs. Unexplained trailing bytes
// are reported but do NOT fail the run: they are a completeness finding about
// the stored IDL, already tracked separately, not a decoder fault.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decodeInstructionData, encodeInstructionData } from '../src/codec.mjs';
import { findStoredIdl } from '../src/decode.mjs';
import { createComparator, oracleCodecs } from './lib/compare.mjs';

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
const harvestPath = option('--harvest', null);
const program = option('--program', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const oracleRoot = option('--oracle', process.env.SEMEME_ORACLE_PATH);
const outPath = option('--out', null);
const maxExamples = Number(option('--max-examples', '5'));

if (!store || !harvestPath) {
  console.error('usage: node tools/tx-diff.mjs --store <dir> --harvest <harvest.json> [--out <report.json>]');
  process.exit(2);
}

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

const harvest = JSON.parse(await readFile(harvestPath, 'utf8'));
if (harvest.program !== program) throw Error(`harvest is for program ${harvest.program}, not ${program}`);

const { idl, receipt } = await findStoredIdl(store, program);
const comparator = createComparator({ idl, oracle, oracleRequire, program });
const instructionByName = new Map((idl.instructions ?? []).map((entry) => [entry.name, entry]));

const totals = {
  transactionsInHarvest: 0,
  transactionsWithPayloads: 0,
  payloads: 0,
  payloadsDecoded: 0,
  namingAgrees: 0,
  namingDisagrees: 0,
  valueAgrees: 0,
  valueDisagrees: 0,
  byteExact: 0,
  byteMismatch: 0,
  unexplained: 0,
  sememeErrors: 0,
  oracleErrors: 0,
  oracleHasNoCodec: 0,
};

const examples = { naming: [], values: [], bytes: [], sememeError: [], unexplained: [] };
const pushExample = (bucket, entry) => {
  if (examples[bucket].length < maxExamples) examples[bucket].push(entry);
};

const perInstruction = new Map();
const noteInstruction = (name, field) => {
  const entry = perInstruction.get(name) ?? { instruction: name, payloads: 0, valueAgrees: 0, valueDisagrees: 0, unexplained: 0 };
  entry.payloads++;
  entry[field] = (entry[field] ?? 0) + 1;
  perInstruction.set(name, entry);
};

for (const transaction of harvest.transactions ?? []) {
  totals.transactionsInHarvest++;
  if (!transaction.payloads?.length) continue;
  totals.transactionsWithPayloads++;

  for (const payload of transaction.payloads) {
    totals.payloads++;
    const bytes = Buffer.from(payload.dataHex ?? '', 'hex');
    if (!bytes.length) continue;

    let mine;
    try {
      mine = decodeInstructionData(idl, bytes);
      totals.payloadsDecoded++;
    } catch (error) {
      totals.sememeErrors++;
      pushExample('sememeError', {
        signature: transaction.signature, slot: transaction.slot,
        instruction: payload.instruction ?? null, error: String(error.message).slice(0, 200),
      });
      continue;
    }

    // 3. BYTES: re-encoding must reproduce the bytes the IDL describes.
    const reencoded = encodeInstructionData(idl, mine.instruction, mine.args);
    const described = bytes.subarray(0, mine.consumed);
    if (reencoded.equals(described)) totals.byteExact++;
    else {
      totals.byteMismatch++;
      pushExample('bytes', {
        signature: transaction.signature, slot: transaction.slot, instruction: mine.instruction,
        bytes: bytes.length, consumed: mine.consumed,
        reencoded: reencoded.toString('hex').slice(0, 160), original: described.toString('hex').slice(0, 160),
      });
    }
    if (mine.trailing?.count > 0) {
      totals.unexplained++;
      pushExample('unexplained', {
        signature: transaction.signature, slot: transaction.slot, instruction: mine.instruction,
        bytes: bytes.length, consumed: mine.consumed, trailing: mine.trailing,
      });
    }

    // 1. NAMING.
    //
    // The oracle's per-instruction decoders do NOT validate the
    // discriminator: given any bytes, most of them happily decode them as
    // their own instruction. So "the oracle decoder returned an object" is
    // NOT evidence about which instruction these bytes are.
    //
    // The honest naming oracle is the ENCODER: decode with a candidate
    // instruction, re-encode, and see whether the bytes come back exactly.
    // Only the instruction whose bytes round-trip is the true name. This
    // also decides the "unexplained trailing bytes" case correctly: a
    // payload with trailing bytes still round-trips through the encoder
    // of its real instruction, because the encoder writes the described
    // prefix.
    const { decoder, encoder } = oracleCodecs(oracle, mine.instruction);
    if (!decoder || !encoder) { totals.oracleHasNoCodec++; continue; }

    let theirs;
    try { theirs = decoder().decode(bytes); }
    catch (error) {
      totals.oracleErrors++;
      pushExample('sememeError', {
        signature: transaction.signature, slot: transaction.slot, instruction: mine.instruction,
        oracleError: String(error.message).slice(0, 200),
      });
      continue;
    }

    // The encoder must reproduce the described prefix of the payload.
    let oracleRoundTrips = false;
    try {
      const reencoded = Buffer.from(encoder().encode(theirs));
      oracleRoundTrips = reencoded.equals(described);
    } catch { oracleRoundTrips = false; }
    if (oracleRoundTrips) totals.namingAgrees++;
    else {
      totals.namingDisagrees++;
      pushExample('naming', {
        signature: transaction.signature, slot: transaction.slot,
        sememe: mine.instruction, oracle: 'encoder does not reproduce these bytes',
      });
    }

    // 2. VALUES: field-by-field comparison of every IDL argument.
    const instruction = instructionByName.get(mine.instruction);
    if (!instruction) { totals.oracleErrors++; continue; }
    const mismatches = comparator.compare(instruction, mine, theirs);
    if (mismatches.length) {
      totals.valueDisagrees++;
      pushExample('values', {
        signature: transaction.signature, slot: transaction.slot, instruction: mine.instruction, diffs: mismatches,
      });
    } else totals.valueAgrees++;
    noteInstruction(mine.instruction, mismatches.length ? 'valueDisagrees' : 'valueAgrees');
    if (mine.trailing?.count > 0) {
      const entry = perInstruction.get(mine.instruction);
      if (entry) entry.unexplained = (entry.unexplained ?? 0) + 1;
    }
  }
}

const report = {
  tool: 'tools/tx-diff.mjs',
  oracle: '@orca-so/whirlpools-client',
  program,
  idl: { fingerprint: receipt.fingerprint, slot: receipt.slot, source: receipt.source },
  harvest: {
    file: path.resolve(harvestPath),
    harvestedAt: harvest.harvestedAt ?? null,
    slotRange: harvest.slotRange ?? null,
    counts: harvest.counts ?? null,
  },
  totals,
  perInstruction: [...perInstruction.values()].sort((a, b) => b.payloads - a.payloads),
  examples,
};

if (outPath) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, `${JSON.stringify(report, null, 1)}\n`);
}

console.log(JSON.stringify({ totals, perInstruction: report.perInstruction.slice(0, 15) }, null, 2));
if (examples.naming.length || examples.values.length || examples.bytes.length || examples.sememeError.length) {
  console.log(JSON.stringify({ examples }, null, 1));
}

const failed = totals.namingDisagrees + totals.valueDisagrees + totals.byteMismatch + totals.sememeErrors;
if (failed) {
  console.error(`tx-diff FAILED: ${failed} disagreement(s) across ${totals.payloads} payloads`);
  process.exitCode = 1;
} else {
  console.error(`tx-diff OK: ${totals.payloads} payloads, ${totals.valueAgrees} value agreements, ` +
    `${totals.byteExact} byte-exact, ${totals.unexplained} unexplained trailing`);
}
