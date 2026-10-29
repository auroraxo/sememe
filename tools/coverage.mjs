// Coverage measurement for a SECOND program, with a naming cross-check
// against an independent IDL.
//
// The Whirlpool qualification (tools/tx-diff.mjs) proved the decoder against
// one program and one oracle. A decoder that only ever sees one program can
// hide a whole class of defects — this tool exists to make the second program
// a repeatable measurement instead of a one-off script.
//
//   node tools/coverage.mjs --harvest <harvest.json> --store <sememe-store> \
//        --program <program-id> [--cross-check <other-idl.json>] [--out <file.json>]
//
// What it reports per payload:
//   kind        'instruction' | 'event'   (Anchor emit_cpi! self-CPIs)
//   byteExact   decoded and re-encoded to the identical input bytes
//   trailing    IDL-described prefix decoded, bytes remain (report policy)
//   unknownDisc discriminator in neither the instruction nor the event table
//   codecError  decode failed after a known discriminator
//
// The cross-check compares instruction naming against an INDEPENDENT IDL file
// (e.g. the bitquery copy shipped in solana-tx-remix idl/multi). It answers a
// question the sememe store alone cannot: does the on-chain IDL name the same
// instructions as an unrelated copy of the same program's interface?
//
//   namedByBoth      both sources know the discriminator and agree on the name
//   sememeOnly       only the stored on-chain IDL knows it
//   crossCheckOnly   only the independent copy knows it
//   nameDisagreement both know it and disagree on the name

import { readFile, writeFile } from 'node:fs/promises';
import {
  decodeData, encodeInstructionData, encodeEventData, instructionIndex, eventIndex,
} from '../src/codec.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const harvestPath = option('--harvest', null);
const storeDir = option('--store', null);
const program = option('--program', null);
const crossCheckPath = option('--cross-check', null);
const outPath = option('--out', null);
if (!harvestPath || !storeDir || !program) {
  console.error('usage: node tools/coverage.mjs --harvest <file.json> --store <dir> --program <id> [--cross-check <idl.json>] [--out <file.json>]');
  process.exit(2);
}

const { findStoredIdl } = await import('../src/decode.mjs');
const { withDerivedDiscriminators } = await import('../src/discriminators.mjs');
const stored = await findStoredIdl(storeDir, program);
const { idl, filled, conflicts } = withDerivedDiscriminators(stored.idl);
const harvest = JSON.parse(await readFile(harvestPath, 'utf8'));
const crossCheck = crossCheckPath
  ? JSON.parse(await readFile(crossCheckPath, 'utf8'))
  : null;
// The independent copy may also be a legacy IDL without discriminators
// (Kamino's published klend IDL is). Its names are what makes it
// independent — derive its discriminators with the same Anchor rule so the
// naming comparison can run; a stored discriminator on either side wins.
const crossCheckIdl = crossCheck ? withDerivedDiscriminators(crossCheck).idl : null;

const chainInstructions = instructionIndex(idl);
const chainEvents = eventIndex(idl);
const crossInstructions = new Map();
for (const instruction of crossCheckIdl?.instructions ?? []) {
  const discriminator = instruction.discriminator;
  if (!Array.isArray(discriminator) || discriminator.length < 8) continue;
  crossInstructions.set(Buffer.from(discriminator.slice(0, 8)).toString('hex'), instruction.name);
}
const crossEvents = new Map();
for (const event of crossCheckIdl?.events ?? []) {
  const discriminator = event.discriminator;
  if (!Array.isArray(discriminator) || discriminator.length < 8) continue;
  crossEvents.set(Buffer.from(discriminator.slice(0, 8)).toString('hex'), event.name);
}

const decode = {
  payloads: 0, instructions: 0, events: 0,
  byteExact: 0, trailing: 0, unknownDisc: 0, codecError: 0, trailingBytes: 0,
  errorSamples: [],
};
const naming = {
  namedByBoth: 0, sememeOnly: 0, crossCheckOnly: 0, nameDisagreement: 0, disagreements: [],
};
const byInstruction = new Map();
const byEvent = new Map();

for (const transaction of harvest.transactions ?? []) {
  if (transaction.missing) continue;
  for (const payload of transaction.payloads ?? []) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    decode.payloads++;
    let decoded;
    try {
      decoded = decodeData(idl, bytes, { trailing: 'report' });
    } catch (error) {
      if (/unknown (instruction|event) discriminator/.test(String(error.message))) decode.unknownDisc++;
      else decode.codecError++;
      if (decode.errorSamples.length < 5) {
        decode.errorSamples.push(String(error.message).slice(0, 160));
      }
      continue;
    }
    const reencoded = decoded.kind === 'instruction'
      ? Buffer.from(encodeInstructionData(idl, decoded.instruction, decoded.args))
      : Buffer.from(encodeEventData(idl, decoded.event, decoded.args, { tagged: decoded.tagged }));
    if (reencoded.equals(bytes)) decode.byteExact++;
    else if (decoded.trailing.count > 0) {
      decode.trailing++;
      decode.trailingBytes += decoded.trailing.count;
    } else decode.codecError++;

    if (decoded.kind === 'instruction') {
      decode.instructions++;
      byInstruction.set(decoded.instruction, (byInstruction.get(decoded.instruction) ?? 0) + 1);
    } else {
      decode.events++;
      byEvent.set(decoded.event, (byEvent.get(decoded.event) ?? 0) + 1);
    }

    if (!crossCheck) continue;
    const table = decoded.kind === 'instruction' ? crossInstructions : crossEvents;
    const mine = decoded.kind === 'instruction'
      ? chainInstructions.get(decoded.discriminator)
      : chainEvents.get(decoded.discriminator);
    const theirs = table.get(decoded.discriminator);
    if (theirs && mine) {
      naming.namedByBoth++;
      if (theirs !== mine.name) {
        naming.nameDisagreement++;
        if (naming.disagreements.length < 10) naming.disagreements.push([mine.name, theirs]);
      }
    } else if (mine) naming.sememeOnly++;
    else if (theirs) naming.crossCheckOnly++;
  }
}

const report = {
  program,
  store: storeDir,
  harvest: { source: harvest.source ?? null, harvestedAt: harvest.harvestedAt ?? null, counts: harvest.counts ?? null, slotRange: harvest.slotRange ?? null },
  idl: {
    instructions: idl.instructions.length,
    events: (idl.events ?? []).length,
    // A legacy on-chain IDL names its instructions but stores no
    // discriminators (measured: Kamino Lend 66/66 without). The decoder
    // fills those with Anchor's rule; report how much of the run depended on
    // derivation and whether it ever disagreed with a stored value.
    discriminatorsDerived: { instructions: filled.instructions, events: filled.events },
    derivationConflicts: conflicts,
  },
  crossCheck: crossCheck
    ? { source: crossCheckPath, instructions: crossInstructions.size, events: crossEvents.size }
    : null,
  decode,
  naming,
  byInstruction: Object.fromEntries([...byInstruction].sort((a, b) => b[1] - a[1])),
  byEvent: Object.fromEntries([...byEvent].sort((a, b) => b[1] - a[1])),
};

console.log(JSON.stringify(report, null, 2));
if (outPath) await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
