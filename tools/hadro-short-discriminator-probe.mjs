// tools/hadro-short-discriminator-probe.mjs — pure probe for the short-discriminator defect
// Run by tools/measure-hadro-short-discriminator.mjs in both pre-fix and post-fix trees
// (byte-identical copy in each tree — only the src/ under test differs).
// Outputs JSON to stdout. No host paths in the output: it is committed as an artifact.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const HADRO = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';
const ETRN = 'EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PFEE = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const SAMPLE_PATH = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const STORE_PATH = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');

const shortOf = (list) => (Array.isArray(list) ? list.filter((x) => Array.isArray(x.discriminator) && x.discriminator.length > 0 && x.discriminator.length !== 8).length : 0);

/** Unit face: does withDerivedDiscriminators preserve short stored discriminators? */
async function unitFace() {
  const { withDerivedDiscriminators } = await import('../src/discriminators.mjs');
  const idl = {
    instructions: [
      { name: 'shortOne', discriminator: [4], args: [] },
      { name: 'eightOne', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], args: [] },
      { name: 'missingOne', args: [] },
    ],
    events: [
      { name: 'shortEvent', discriminator: [0], fields: [] },
      { name: 'missingEvent', fields: [] },
    ],
  };
  const { idl: out, filled, conflicts } = withDerivedDiscriminators(idl);
  return {
    preservesShortInstruction: Array.isArray(out.instructions[0].discriminator)
      && out.instructions[0].discriminator.length === 1
      && out.instructions[0].discriminator[0] === 4,
    preservesShortEvent: Array.isArray(out.events[0].discriminator)
      && out.events[0].discriminator.length === 1
      && out.events[0].discriminator[0] === 0,
    // Guards in the same face: the 8-byte gap-fill must still run (it is not
    // the defect), and a stored 8-byte conflict must still be reported.
    instructionsFilled: filled.instructions,
    eventsFilled: filled.events,
    eightByteConflictReported: conflicts.length === 1,
    keepsEightByteStored: Buffer.from(out.instructions[1].discriminator).toString('hex')
      === '0102030405060708',
  };
}

/** Store face: how many short discriminators survive withDerivedDiscriminators? */
async function storeFace(program) {
  const { withDerivedDiscriminators } = await import('../src/discriminators.mjs');
  const { findStoredIdls } = await import('../src/store-read.mjs');
  const { primary } = await findStoredIdls(STORE_PATH, program);
  const totalShortIx = shortOf(primary.idl.instructions);
  const totalShortEv = shortOf(primary.idl.events);
  const { idl: out, filled, conflicts } = withDerivedDiscriminators(primary.idl);
  return {
    totalInstructions: (primary.idl.instructions ?? []).length,
    storedShortInstructions: totalShortIx,
    storedShortEvents: totalShortEv,
    shortDiscriminatorsPreserved: shortOf(out.instructions) + shortOf(out.events),
    instructionsFilled: filled.instructions,
    eventsFilled: filled.events,
    conflicts: conflicts.length,
  };
}

/** Wire face: real payloads through the product's own decode path. */
async function wireFace(program, sample) {
  const { decodeUnionPayload } = await import('../src/decode.mjs');
  const rows = [];
  for (const tx of sample.transactions) {
    for (const p of tx.payloads ?? []) {
      if (p.program === program) rows.push(p.dataHex);
    }
  }
  let decoded = 0;
  let refused = 0;
  let fullExact = 0;
  let describedExact = 0;
  const decodedByInstruction = {};
  const refusalReasons = {};
  for (const hex of rows) {
    try {
      const out = await decodeUnionPayload(STORE_PATH, program, hex, {
        trailing: 'report',
        absent: 'verified',
      });
      decoded += 1;
      if (out.roundTripByteExact === true) fullExact += 1;
      else if (out.describedRoundTripByteExact === true) describedExact += 1;
      decodedByInstruction[out.name] = (decodedByInstruction[out.name] ?? 0) + 1;
    } catch (error) {
      refused += 1;
      const face = String(error?.message ?? error)
        .replace(/unknown instruction discriminator ([0-9a-f]+).*/, 'unknown-discriminator-$1')
        .replace(/unknown event discriminator ([0-9a-f]+).*/, 'unknown-event-discriminator-$1')
        .slice(0, 100);
      refusalReasons[face] = (refusalReasons[face] ?? 0) + 1;
    }
  }
  return { totalPayloads: rows.length, decoded, refused, fullExact, describedExact, decodedByInstruction, refusalReasons };
}

async function main() {
  const sample = JSON.parse(await readFile(SAMPLE_PATH, 'utf8'));
  const result = {
    unit: await unitFace(),
    hadroStore: await storeFace(HADRO),
    etrnStore: await storeFace(ETRN),
    wire: {
      hadro: await wireFace(HADRO, sample),
      etrn: await wireFace(ETRN, sample),
      // Guard faces: programs whose discriminators are all 8-byte — the fix
      // must not move a single byte of their verdicts (pre-fix 400/842 and
      // 5/464 decodes are the pinned baselines).
      pump: await wireFace(PUMP, sample),
      pfee: await wireFace(PFEE, sample),
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${String(error?.stack ?? error)}\n`);
  process.exit(2);
});
