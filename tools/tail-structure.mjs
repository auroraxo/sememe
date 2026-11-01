#!/usr/bin/env node
// tools/tail-structure.mjs — second-pass structure probe on the 40-byte `fill`
// wire of the Jupiter order_engine, derived ONLY from the committed fixture.
//
// tail-hypotheses.mjs rejected every *value* interpretation (checksums, the
// declared arguments, the slot, a timestamp). This tool asks the structural
// question instead: WHAT SHAPE does the unknown have?
//
//   - which of the 8 tail bytes actually vary, and how much entropy they carry
//   - is the varying part ordered like the slot (monotonic), i.e. a counter?
//   - does it correlate with the slot at all?
//   - does it equal bytes of the transaction signature?
//   - does it equal the *nonce*/ordering position of the fill inside its tx?
//   - is it the same value when the same tx has several fills?
//
// Every number is derived here and re-derived by test/rfq-stack.test.mjs, so a
// later change to the fixture turns the test RED instead of letting the claim
// go stale.
//
// Output: research/rfq-order-engine-tail-structure-2026-11-01.json

import { readFile, writeFile } from 'node:fs/promises';
import { decodeBase58 } from '../src/base58.mjs';

const HARVEST = new URL('../test/fixtures/harvest-order-engine-2026-11-01.json', import.meta.url);
const OUT = new URL('../research/rfq-order-engine-tail-structure-2026-11-01.json', import.meta.url);

const u32le = (b, o) => b.readUInt32LE(o);
const u32be = (b, o) => b.readUInt32BE(o);

const harvest = JSON.parse(await readFile(HARVEST, 'utf8'));

const longs = [];
const multiFillTx = [];
for (const tx of harvest.transactions) {
  if (tx.missing) continue;
  const ps = tx.payloads ?? [];
  const longHere = ps.filter((p) => p.dataHex.length === 80);
  for (const p of longHere) {
    longs.push({ slot: tx.slot, signature: tx.signature, ix: p.ix, depth: p.depth, bytes: Buffer.from(p.dataHex, 'hex') });
  }
  if (longHere.length > 1) multiFillTx.push({ signature: tx.signature, slot: tx.slot, fills: longHere.length });
}

// ---- byte-level variation -------------------------------------------------
const byteStats = [];
for (let i = 0; i < 8; i++) {
  const vals = longs.map((r) => r.bytes[32 + i]);
  const set = new Set(vals);
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  byteStats.push({
    byteIndex: 32 + i,
    distinct: set.size,
    min: Math.min(...vals),
    max: Math.max(...vals),
    mostCommon: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, n]) => ({ value: v, count: n })),
  });
}

// ---- monotonicity and correlation with the slot -----------------------------
const bySlot = [...longs].sort((a, b) => a.slot - b.slot);
const leVals = bySlot.map((r) => u32le(r.bytes, 32));
const beVals = bySlot.map((r) => u32be(r.bytes, 32));
const slots = bySlot.map((r) => r.slot);

const countIncreases = (arr) => arr.reduce((n, v, i) => (i > 0 && v > arr[i - 1] ? n + 1 : n), 0);
const pearson = (xs, ys) => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  return cov / Math.sqrt(vx * vy);
};

const leMonotonic = countIncreases(leVals);
const beMonotonic = countIncreases(beVals);

// ---- signature bytes ------------------------------------------------------
const sigMatchLe = longs.filter((r) => {
  const sb = Buffer.from(decodeBase58(r.signature));
  return u32le(sb, 0) === u32le(r.bytes, 32);
}).length;
const sigMatchBe = longs.filter((r) => {
  const sb = Buffer.from(decodeBase58(r.signature));
  return u32be(sb, 0) === u32be(r.bytes, 32);
}).length;
const sigMatchLeLast = longs.filter((r) => {
  const sb = Buffer.from(decodeBase58(r.signature));
  return u32le(sb, sb.length - 4) === u32le(r.bytes, 32);
}).length;

// ---- the same tx carrying several long fills ------------------------------
const sameValueInOneTx = multiFillTx.filter(({ signature }) => {
  const rows = longs.filter((r) => r.signature === signature);
  const vals = new Set(rows.map((r) => u32le(r.bytes, 32)));
  return vals.size === 1;
}).length;

const report = {
  derivedFrom: 'test/fixtures/harvest-order-engine-2026-11-01.json',
  note: 'Structural probe of the 8 undeclared tail bytes. All numbers derived from the committed fixture by this tool.',
  sample: { longPayloads: longs.length, transactionsWithSeveralLongFills: multiFillTx.length },
  byteStats,
  ordering: {
    leIncreasesWithSlot: `${leMonotonic}/${leVals.length - 1}`,
    beIncreasesWithSlot: `${beMonotonic}/${beVals.length - 1}`,
    correlationSlotVsLe: Number(pearson(slots, leVals).toFixed(6)),
    correlationSlotVsBe: Number(pearson(slots, beVals).toFixed(6)),
  },
  signatureBytes: {
    matchesSignatureFirst4Le: `${sigMatchLe}/${longs.length}`,
    matchesSignatureFirst4Be: `${sigMatchBe}/${longs.length}`,
    matchesSignatureLast4Le: `${sigMatchLeLast}/${longs.length}`,
  },
  sameTx: {
    transactionsWithSeveralLongFills: multiFillTx.length,
    ofThoseWithIdenticalVaryingValue: sameValueInOneTx,
  },
};

await writeFile(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
