// Reproducible union-coverage report for pump.fun: one payload set, three
// interface views, and the disagreement between them.
//
//   node tools/union-coverage.mjs > research/union-coverage-2026-10-30.json
//
// Why a tool and not a hand-written note: the interesting claim here is that a
// deployed program's own on-chain IDL account and its first-party published copy
// DISAGREE about real traffic, and that a union of both decodes strictly more
// than either alone. Those are easy to state and easy to get wrong by hand.
//
// This tool measures the PRODUCT decode core: it builds the store exactly as
// `sememe pull` + `sememe adopt` do, verifies both sources ONCE through
// `findStoredIdls` (the same reader the CLI uses), then decodes every harvested
// payload through `unionDecode` — the same function `sememe decode --union`
// calls. Re-verifying the store 996 times would not change a single verdict
// (a store that verifies at t0 verifies identically at t1 unless it is mutated
// mid-run, which this tool does not do); it would only multiply runtime by ~3.
//
// The verdicts are kept separate on purpose:
//   - decoding is a statement about the IDL, not about whether the chain
//     accepted the transaction (measured: refused payloads sit in successful
//     transactions), so the cross-tab is reported next to the coverage
//   - the union's byte-exactness count is reported separately from its
//     decode count: a payload decoded with unexplained trailing bytes is a
//     weaker claim than one that re-encodes byte-for-byte.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/canonical.mjs';
import { adopt } from '../src/adopt.mjs';
import { findStoredIdls, unionDecode } from '../src/decode.mjs';
import { parsePayload } from '../src/decode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const pumpIdl = read('test/fixtures/pump-idl.json');
const pumpPublished = read('test/fixtures/pump-published-idl.json');
const pumpHarvest = read('test/fixtures/harvest-pump-2026-10-30.json');

const PROGRAM = pumpIdl.address;
const rows = pumpHarvest.transactions.flatMap((tx) =>
  (tx.payloads ?? []).map((p) => ({
    bytes: Buffer.from(p.dataHex, 'hex'),
    failed: tx.txErr !== null,
    signature: tx.signature,
  })));

/** A store exactly as `sememe pull` and `sememe adopt` write it. */
async function buildStore() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-union-cov-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const bytes = Buffer.from(canonicalJson(pumpIdl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(store, 'receipts', `${PROGRAM}-463372656-metadata-${fingerprint}.json`),
    Buffer.from(canonicalJson({
      program: PROGRAM, source: 'metadata', address: 'AYgC53tU5BbP2NAnv5nConJxAdpQZctvmZK88pu69xRs',
      slot: 463372656, fingerprint: `sha256:${fingerprint}`, instructionCount: pumpIdl.instructions.length,
    }) + '\n'),
  );
  const publishedFile = path.join(store, 'published.json');
  await writeFile(publishedFile, JSON.stringify(pumpPublished));
  await adopt(PROGRAM, publishedFile, store, {
    source: 'published',
    origin: 'pump-fun/pump-public-docs idl/pump.json',
  });
  return store;
}

const store = await buildStore();
// Verified once — the same reader `decodeUnionPayload` calls per invocation.
const { primary, secondary } = await findStoredIdls(store, PROGRAM);
const tally = {};
const arbitration = {};
const refusals = {};
const crossTab = {};
const byteExact = { full: 0, described: 0 };
const driftPaths = {};
let decoded = 0;

for (const row of rows) {
  try {
    const result = unionDecode({ program: PROGRAM, primary, secondary, bytes: row.bytes });
    decoded++;
    const verdict = result.view.verdict;
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    const basis = result.view.arbitration?.basis ?? 'unknown';
    arbitration[basis] = (arbitration[basis] ?? 0) + 1;
    if (result.roundTripByteExact) byteExact.full++;
    if (result.describedRoundTripByteExact) byteExact.described++;
    if (verdict === 'layout_drift') {
      for (const p of result.view.drift.paths.paths) driftPaths[p] = (driftPaths[p] ?? 0) + 1;
    }
    const key = `${verdict}_${row.failed ? 'txFailed' : 'txSuccess'}`;
    crossTab[key] = (crossTab[key] ?? 0) + 1;
  } catch (error) {
    const view = error.view ?? error.details?.view ?? {};
    const p = view.primary?.decoded === false ? 'primaryRefused' : 'primaryDecoded';
    const s = view.secondary?.decoded === false ? 'secondaryRefused' : 'secondaryDecoded';
    const key = `${p}/${s}`;
    refusals[key] = (refusals[key] ?? 0) + 1;
    const reason = String(view.primary?.refusedReason ?? view.secondary?.refusedReason ?? error.message).slice(0, 80);
    refusals[`${key} :: ${reason}`] = (refusals[`${key} :: ${reason}`] ?? 0) + 1;
    const ctKey = `refused_${row.failed ? 'txFailed' : 'txSuccess'}`;
    crossTab[ctKey] = (crossTab[ctKey] ?? 0) + 1;
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  note: 'generated by tools/union-coverage.mjs from committed fixtures — do not hand-edit',
  pumpFun: {
    program: PROGRAM,
    sources: {
      onChain: { instructions: pumpIdl.instructions.length, events: pumpIdl.events.length, slot: 463372656 },
      published: { instructions: pumpPublished.instructions.length, events: pumpPublished.events.length },
    },
    traffic: {
      harvestedAt: pumpHarvest.harvestedAt,
      slotRange: pumpHarvest.slotRange,
      transactions: pumpHarvest.transactions.length,
      payloads: rows.length,
    },
    unionVerdicts: tally,
    arbitrationBasis: arbitration,
    byteExactness: {
      fullRoundTrip: byteExact.full,
      describedRoundTrip: byteExact.described,
      total: rows.length,
      verdict: 'a payload counts as byte-exact only when the winning source re-encodes to the WHOLE payload; "described" covers the IDL-described prefix only',
    },
    refusals,
    decodeVsChainOutcome: crossTab,
    layoutDriftPaths: driftPaths,
  },
  limits: [
    'one program, one 12-block harvest window from 2026-10-30',
    'no outside user: both sources are mine — the on-chain pull and the first-party published copy',
    'decode refusal is a statement about an IDL, not about the chain accepting the transaction',
    'the union is not a verified interface: it is two views, and the disagreement between them is reported, not resolved by preference',
  ],
};

process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
await rm(store, { recursive: true, force: true });
