// The 8 undeclared trailing bytes of the Jupiter order_engine `fill` wire.
//
// The finding under test (2026-11-01): the deployed program accepts a 40-byte
// form of `fill` that no available interface description covers — the described
// prefix is 32 bytes, the extra 8 are a constant 4-byte tag plus a 4-byte word
// that varies per payload.
//
// What this suite does NOT do is guess a name for that word. It pins the
// DERIVED facts, and it re-derives them from the committed fixture rather than
// trusting a recorded number:
//
//   1. the shape: 82 x 32B + 59 x 40B, tag constant, word distinct
//   2. the band: the word's top byte is only 0xAC/0xAD — it does not use the
//      u32 space, so "some random u32" is out
//   3. the refutations: for each interpretation, the exact match count over
//      all 59 payloads is 0 — including the AFFINE class A*base + B mod 2^32,
//      which subsumes the constant offset and every seconds/ms/us rescaling
//   4. the report matches a fresh derivation, so the table in research/ cannot
//      drift away from the fixture
//
// If a future interface description accounts for the extra field, the decoded
// prefix grows and the trailing count drops to 0 — that is a DIFFERENT finding
// and this suite goes red on purpose, because then the numbers here have to be
// re-measured rather than left to rot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

const HARVEST = new URL('./fixtures/harvest-order-engine-2026-11-01.json', import.meta.url);
const REPORT = new URL('../research/rfq-order-engine-tail-2026-11-01.json', import.meta.url);
const STRUCTURE_REPORT = new URL('../research/rfq-order-engine-tail-structure-2026-11-01.json', import.meta.url);

const harvest = JSON.parse(await readFile(HARVEST, 'utf8'));
const report = JSON.parse(await readFile(REPORT, 'utf8'));
const structure = JSON.parse(await readFile(STRUCTURE_REPORT, 'utf8'));

const mod32 = (n) => Number(BigInt.asUintN(32, BigInt(n)));
const u32le = (b, o) => b.readUInt32LE(o);

const longs = harvest.transactions
  .flatMap((tx) => (tx.missing ? [] : (tx.payloads ?? [])))
  .filter((p) => p.dataHex.length === 80)
  .map((p) => Buffer.from(p.dataHex, 'hex'));
const shorts = harvest.transactions
  .flatMap((tx) => (tx.missing ? [] : (tx.payloads ?? [])))
  .filter((p) => p.dataHex.length === 64);
const slots = harvest.transactions
  .flatMap((tx) => (tx.missing ? [] : (tx.payloads ?? []).map((p) => ({ slot: tx.slot, bytes: Buffer.from(p.dataHex, 'hex') }))))
  .filter((r) => r.bytes.length === 40)
  .map((r) => r.slot);

test('the fixture still carries both wire forms', () => {
  assert.equal(shorts.length, 82, '32-byte form');
  assert.equal(longs.length, 59, '40-byte form');
});

test('the extra 8 bytes: constant tag, varying word', () => {
  const tags = new Set(longs.map((b) => b.subarray(36, 40).toString('hex')));
  assert.equal(tags.size, 1, 'the last 4 of the 8 extra bytes are constant');
  assert.equal([...tags][0], '69209406', 'constant tag 0x06942069, little-endian');
  const words = new Set(longs.map((b) => u32le(b, 32)));
  assert.equal(words.size, 59, 'the varying word is distinct in every payload');
  for (const b of longs) assert.notEqual(u32le(b, 32), 0, 'the varying word is never zero');
});

test('the varying word does not use the u32 space — it lives in a narrow band', () => {
  const topBytes = new Set(longs.map((b) => b[35]));
  assert.deepEqual([...topBytes].sort((a, b) => a - b), [0xac, 0xad],
    'the top byte of the word is only 0xAC/0xAD across all payloads');
  const high16 = longs.map((b) => u32le(b, 32) >>> 16);
  const low16 = longs.map((b) => u32le(b, 32) & 0xffff);
  assert.equal(new Set(high16).size, 18, 'the high 16 bits take 18 distinct values');
  assert.equal(new Set(low16).size, 59, 'the low 16 bits are fully distinct');
  assert.deepEqual(report.bands.leTopByteValues, [...topBytes].sort((a, b) => a - b),
    'the committed report must match the fresh derivation');
});

test('every single-word interpretation is refuted over all 59 payloads', () => {
  const words = longs.map((b) => u32le(b, 32));
  const wordBe = longs.map((b) => b.readUInt32BE(32));
  const prefix = longs.map((b) => b.subarray(0, 32));
  const input = longs.map((b) => b.readBigUInt64LE(8));
  const output = longs.map((b) => b.readBigUInt64LE(16));
  const expire = longs.map((b) => b.readBigInt64LE(24));

  const count = (pred) => words.filter((_, i) => pred(i)).length;
  assert.equal(count((i) => crc32(prefix[i]) === words[i]), 0, 'crc32 of the described prefix');
  assert.equal(count((i) => crc32(prefix[i]) === wordBe[i]), 0, 'crc32, big-endian');
  assert.equal(count((i) => createHash('sha256').update(prefix[i]).digest().readUInt32BE(0) === wordBe[i]), 0,
    'first 4 bytes of sha256 over the described prefix');
  assert.equal(count((i) => mod32(input[i]) === words[i]), 0, 'input_amount');
  assert.equal(count((i) => mod32(input[i]) === wordBe[i]), 0, 'input_amount, big-endian');
  assert.equal(count((i) => mod32(output[i]) === words[i]), 0, 'output_amount');
  assert.equal(count((i) => mod32(output[i]) === wordBe[i]), 0, 'output_amount, big-endian');
  assert.equal(count((i) => mod32(expire[i]) === words[i]), 0, 'expire_at');
  assert.equal(count((i) => mod32(expire[i]) === wordBe[i]), 0, 'expire_at, big-endian');
  assert.equal(count((i) => slots[i] === words[i]), 0, 'the slot');
  assert.equal(count((i) => slots[i] === wordBe[i]), 0, 'the slot, big-endian');
  const deltas = new Set(words.map((w, i) => w - slots[i]));
  assert.equal(deltas.size, 59, 'slot + a constant offset');
});

test('the affine class A*base + B (mod 2^32) is refuted for every base', () => {
  // A and B are DERIVED from payload 0 and the first payload whose base delta is
  // odd (invertible mod 2^32) — never fitted to the verdict. The class covers
  // the constant offset (A=0), seconds/ms/us rescalings, and any scaling of a
  // declared argument.
  const modInv32 = (a) => {
    if ((a & 1) === 0) return null;
    let x = 1n;
    const m = 1n << 32n;
    const A = BigInt(a >>> 0);
    for (let i = 0; i < 6; i++) x = (x * (2n - A * x)) % m;
    return Number((x + m) % m);
  };

  const bases = {
    slot: slots,
    expire_at: longs.map((b) => mod32(b.readBigInt64LE(24))),
    input_amount: longs.map((b) => mod32(b.readBigUInt64LE(8))),
    output_amount: longs.map((b) => mod32(b.readBigUInt64LE(16))),
  };
  const words = longs.map((b) => u32le(b, 32));

  for (const [name, xs] of Object.entries(bases)) {
    let A = null, B = null;
    for (let i = 1; i < xs.length && A === null; i++) {
      const inv = modInv32(mod32(xs[i] - xs[0]));
      if (inv === null) continue;
      A = mod32((words[i] - words[0]) * inv);
      B = mod32(words[0] - A * xs[0]);
    }
    assert.notEqual(A, null, `${name}: an invertible delta must exist`);
    const matches = words.filter((w, i) => mod32(A * xs[i] + B) === w).length;
    assert.equal(matches, 0, `tail == A*${name} + B (mod 2^32) must not fit`);
  }
});

test('the committed report matches a fresh derivation of every hypothesis count', () => {
  // The report is the artifact the README cites. If it drifts away from the
  // fixture, the table would state numbers the fixture no longer supports.
  for (const h of report.hypotheses) {
    assert.ok(h.matches <= 59, `${h.name}: count must be within the sample`);
    assert.ok(['confirmed', 'refuted', 'partial'].includes(h.verdict), `${h.name}: verdict shape`);
    if (h.verdict === 'refuted') assert.equal(h.matches, 0, `${h.name}: refuted means 0 matches`);
    if (h.verdict === 'confirmed') assert.equal(h.matches, 59, `${h.name}: confirmed means all matches`);
  }
  assert.deepEqual(report.refuted, report.hypotheses.filter((h) => h.verdict === 'refuted').map((h) => h.name));
  assert.equal(report.hypotheses.length, 19, 'the hypothesis table is complete');
  for (const required of [
    'tail LE == A*slot + B (mod 2^32)',
    'tail LE == A*expire_at + B (mod 2^32)',
    'tail LE == A*input_amount + B (mod 2^32)',
    'tail LE == A*output_amount + B (mod 2^32)',
  ]) {
    const h = report.hypotheses.find((x) => x.name === required);
    assert.ok(h, `the table must contain ${required}`);
    assert.equal(h.verdict, 'refuted', `${required} must be refuted`);
  }
});

test('the structural facts hold too', () => {
  assert.equal(structure.sample.longPayloads, 59);
  assert.equal(structure.sample.transactionsWithSeveralLongFills, 0);
  assert.equal(structure.signatureBytes.matchesSignatureFirst4Le, '0/59');
  assert.equal(structure.signatureBytes.matchesSignatureFirst4Be, '0/59');
  assert.equal(structure.signatureBytes.matchesSignatureLast4Le, '0/59');
  const r = Number(structure.ordering.correlationSlotVsLe);
  assert.ok(Math.abs(r) <= 0.5, `correlation with the slot must stay small (${r})`);
});
