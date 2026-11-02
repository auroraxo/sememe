// Coverage of the real mainnet traffic sample — the number the card asks for.
//
//   node tools/traffic-coverage-report.mjs > research/traffic-coverage-2026-11-02.json
//
// What this measures, and what it deliberately does NOT claim:
//
//   The sample (test/fixtures/traffic-sample-2026-11-02.json) is CONTIGUOUS
//   RECENT MAINNET TRAFFIC, collected without asking the store anything. That
//   removes the selection bias every previous sememe qualification carried:
//   each of those harvested a program that was already in the store.
//
//   For every instruction in that traffic, this asks one question: could
//   sememe have named it? The answer has FOUR distinct outcomes, and the
//   difference between them is the whole point:
//
//     decoded        the interface is available AND the bytes decoded
//     refused        the interface is available AND the bytes were refused
//                   (unknown discriminator, truncated input, ...)
//     no-interface  the program has NO interface sememe can acquire at all
//     not-applicable native programs (System, ComputeBudget) are decoded by
//                   the vendored-upstream path, not by an IDL
//
//   Collapsing "refused" and "no-interface" into one "uncovered" number is
//   the coverage illusion this measurement exists to prevent: they have
//   different fixes (a decoder or source-lag bug vs. an acquisition gap).
//
// THE MEASUREMENT USES THE PRODUCT'S OWN ENTRY POINTS — decodePayload,
// decodeUnionPayload and the native decoder — against the committed store
// fixture (test/fixtures/traffic-sample-store). It does not re-implement
// decoding. A first version of this tool called the codec directly and
// therefore measured a DIFFERENT product: the codec does not fill
// discriminator gaps, the product path does. That mistake showed up as a
// uniform "0 known" refusal for programs whose interfaces are legacy and
// carry no discriminator arrays, and it would have understated coverage.
//
// Everything is computed from the committed fixtures; the tool never touches
// the network, so the number is reproducible offline and a change in it means
// the CODE or the FIXTURE changed, not the chain.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePayload, decodeUnionPayload } from '../src/decode.mjs';
import { decodeNativeInstruction, isNativeProgram } from '../src/native.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const SAMPLE = 'test/fixtures/traffic-sample-2026-11-02.json';
const STORE = 'test/fixtures/traffic-sample-store';
const sample = read(SAMPLE);
const acquirable = sample.acquirable ?? {};

/** Decode one payload through the product, and classify the outcome. */
async function classify(program, hex) {
  const byteLength = hex.length / 2;
  if (isNativeProgram(program)) {
    try {
      const decoded = decodeNativeInstruction(program, Buffer.from(hex, 'hex'), { trailing: 'report' });
      return {
        outcome: 'decoded',
        via: 'native-upstream',
        name: decoded.name,
        byteExact: decoded.roundTripByteExact === true,
        trailing: decoded.trailing?.count ?? 0,
      };
    } catch (error) {
      return { outcome: 'refused', via: 'native-upstream', reason: String(error?.message ?? error).slice(0, 110) };
    }
  }

  // Union first: a program with an adopted published copy answers with both
  // sources, which is what a consumer gets. A program with only an on-chain
  // pull answers through the plain path.
  try {
    const result = await decodeUnionPayload(STORE, program, hex, { trailing: 'report' });
    return {
      outcome: 'decoded',
      via: result.verdict?.winner ? 'union' : 'idl',
      name: result.name,
      byteExact: result.roundTripByteExact === true,
      describedExact: result.describedRoundTripByteExact === true,
      trailing: result.trailing?.count ?? 0,
    };
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 110);
    // The store's own "this program has no interface" signal (src/store-read.mjs)
    // is an ACQUISITION gap, not a decode refusal. Matched exactly, not by
    // guessing: a refusal must never be relabelled as a missing interface.
    if (reason.startsWith('no stored IDL for program')) {
      return { outcome: 'no-interface', via: 'none', reason };
    }
    return { outcome: 'refused', via: 'idl', reason };
  }
}

const perProgram = new Map();
const refusalReasons = new Map();
const outcomeVsChain = {
  decoded_txSuccess: 0, decoded_txFailed: 0,
  refused_txSuccess: 0, refused_txFailed: 0,
  noInterface_txSuccess: 0, noInterface_txFailed: 0,
};
let total = 0;
for (const tx of sample.transactions) {
  for (const row of tx.payloads) {
    const verdict = await classify(row.program, row.dataHex);
    total += 1;
    let entry = perProgram.get(row.program);
    if (!entry) {
      entry = {
        program: row.program,
        name: sample.catalog.find((c) => c.id === row.program)?.name ?? null,
        acquirable: acquirable[row.program]?.acquirable ?? null,
        decoded: 0, refused: 0, noInterface: 0, byteExact: 0, describedExact: 0, trailing: 0,
      };
      perProgram.set(row.program, entry);
    }
    if (verdict.outcome === 'decoded') {
      entry.decoded += 1;
      if (verdict.byteExact === true) entry.byteExact += 1;
      if (verdict.describedExact === true) entry.describedExact += 1;
      if (verdict.trailing > 0) entry.trailing += 1;
      outcomeVsChain[tx.failed ? 'decoded_txFailed' : 'decoded_txSuccess'] += 1;
    } else if (verdict.outcome === 'refused') {
      entry.refused += 1;
      const key = `${verdict.via}: ${verdict.reason}`;
      refusalReasons.set(key, (refusalReasons.get(key) ?? 0) + 1);
      outcomeVsChain[tx.failed ? 'refused_txFailed' : 'refused_txSuccess'] += 1;
    } else {
      entry.noInterface += 1;
      outcomeVsChain[tx.failed ? 'noInterface_txFailed' : 'noInterface_txSuccess'] += 1;
      const key = `no-interface: ${verdict.reason}`;
      refusalReasons.set(key, (refusalReasons.get(key) ?? 0) + 1);
    }
  }
}

const rows = [...perProgram.values()].map((entry) => ({
  ...entry,
  payloads: entry.decoded + entry.refused + entry.noInterface,
  coveredPct: Number((100 * entry.decoded / (entry.decoded + entry.refused + entry.noInterface)).toFixed(1)),
})).sort((a, b) => b.payloads - a.payloads);

const sum = (key) => rows.reduce((acc, row) => acc + row[key], 0);
const decoded = sum('decoded');
const refused = sum('refused');
const noInterface = sum('noInterface');
const byteExact = sum('byteExact');

// Traffic that no watched program covers at all: counted in the sample, not
// stored, therefore NOT part of the coverage denominator. It is reported
// separately so the denominator can never quietly shrink.
const unknownTraffic = (sample.unknownPrograms ?? []).reduce((acc, row) => acc + row.payloadCount, 0);
const unknownTx = (sample.unknownPrograms ?? []).reduce((acc, row) => acc + row.txCount, 0);

const report = {
  generatedAt: new Date().toISOString(),
  sample: {
    file: SAMPLE,
    store: STORE,
    capturedAt: sample.meta.capturedAt,
    slots: sample.meta.requestedSlots,
    blocksWithTraffic: sample.meta.blocksWithTraffic,
    transactionsInBlocks: sample.meta.transactionsInBlocks,
    transactionsWithWatchedTraffic: sample.transactions.length,
    method: sample.meta.method,
    selection: 'contiguous newest finalized blocks — the store was not consulted when the sample was taken, so it carries no store-selection bias',
    measurementPath: 'the product entry points (decodePayload / decodeUnionPayload / native decoder) against the committed store fixture',
  },
  headline: {
    watchedPayloads: total,
    decoded, refused, noInterface,
    coveredPct: Number((100 * decoded / total).toFixed(1)),
    byteExact,
    byteExactPctOfDecoded: Number((100 * byteExact / decoded).toFixed(1)),
    note: 'coverage = payloads an available interface could NAME. "refused" (interface present, bytes refused) and "no-interface" (no interface acquirable at all) are counted separately because they need different fixes.',
  },
  trafficOutsideTheWatchedList: {
    distinctPrograms: (sample.unknownPrograms ?? []).length,
    instructions: unknownTraffic,
    transactions: unknownTx,
    note: 'counted, bytes NOT stored (fixture size limit). NOT in the coverage denominator — reporting them separately keeps the denominator honest.',
  },
  refusalReasons: [...refusalReasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count),
  // Refusal is a statement about the INTERFACE, not about the chain: payloads
  // in transactions the chain ACCEPTED are the ones where an interface gap
  // costs a consumer real, successful traffic.
  outcomeVsChain,
  programs: rows,
  acquisitionQueue: rows
    .filter((row) => row.noInterface > 0)
    .map((row) => ({
      program: row.program,
      name: row.name,
      payloads: row.noInterface,
      acquirable: row.acquirable,
      reason: acquirable[row.program]?.acquirable === false
        ? 'no on-chain IDL at either address; needs a first-party published copy or a vendored upstream source'
        : 'interface exists but is not in this repo',
    }))
    .sort((a, b) => b.payloads - a.payloads),
};

process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
