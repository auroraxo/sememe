#!/usr/bin/env node
// tools/tail-hypotheses.mjs — derive, from the committed order-engine fixture ONLY
// (no RPC), what the 8 undeclared tail bytes of the 40-byte `fill` wire are NOT.
//
// The previous measurement (research/rfq-stack-2026-11-01.json) established the
// shape: 59 payloads of 32 described bytes + 8 undeclared bytes, the last 4 of
// them a constant tag 0x06942069 (LE) and the first 4 varying and pairwise
// distinct. Several interpretations were rejected one by one there. This tool
// turns that rejection list into a reproducible table: every hypothesis gets an
// EXACT match criterion, the count is derived over all 59 payloads, and the
// verdict follows from the count — nothing is asserted from memory.
//
// Output: research/rfq-order-engine-tail-2026-11-01.json
//
// Run:  node tools/tail-hypotheses.mjs

import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';

const HARVEST = new URL('../test/fixtures/harvest-order-engine-2026-11-01.json', import.meta.url);
const IDL = new URL('../test/fixtures/order-engine-idl.json', import.meta.url);
const OUT = new URL('../research/rfq-order-engine-tail-2026-11-01.json', import.meta.url);

const fromHex = (hex) => Buffer.from(hex, 'hex');
const u32le = (b, o) => b.readUInt32LE(o);
const u32be = (b, o) => b.readUInt32BE(o);
const u64le = (b, o) => b.readBigUInt64LE(o);
const i64le = (b, o) => b.readBigInt64LE(o);

const harvest = JSON.parse(await readFile(HARVEST, 'utf8'));
const idl = JSON.parse(await readFile(IDL, 'utf8'));

const fill = idl.instructions.find((i) => i.name === 'fill');
const discriminator = Buffer.from(fill.discriminator);

const all = harvest.transactions
  .flatMap((tx) => (tx.missing ? [] : (tx.payloads ?? []).map((p) => ({ tx, p }))))
  .map(({ tx, p }) => ({ slot: tx.slot, signature: tx.signature, bytes: fromHex(p.dataHex) }));

const forms = { short: [], long: [] };
for (const row of all) (row.bytes.length === 32 ? forms.short : forms.long).push(row);

const longs = forms.longs ?? forms.long;
if (longs.length !== 59 || forms.short.length !== 82) {
  throw new Error(`fixture shape changed: ${forms.short.length}x32B + ${longs.length}x40B (expected 82 + 59)`);
}

// ---- the 59 long payloads, split into prefix / tail -------------------------
const rows = longs.map(({ slot, signature, bytes }) => {
  const prefix = bytes.subarray(0, 32);
  const tail = bytes.subarray(32, 40);
  return {
    slot,
    signature,
    prefix,
    tail,
    input: u64le(prefix, 8),
    output: u64le(prefix, 16),
    expire: i64le(prefix, 24),
    tailLe: u32le(tail, 0),
    tailBe: u32be(tail, 0),
    tagLe: u32le(tail, 4),
    tagBe: u32be(tail, 4),
  };
});

const allDisc = rows.every((r) => Buffer.compare(r.prefix.subarray(0, 8), discriminator) === 0);
const tags = new Set(rows.map((r) => r.tagLe));
const vary = new Set(rows.map((r) => r.tailLe));
const zero = rows.filter((r) => r.tailLe === 0).length;
const shuffled = rows.some((r, i) => i > 0 && r.tailLe <= rows[i - 1].tailLe);

// ---- hypothesis table ------------------------------------------------------
// Each entry: name, claim, count of payloads satisfying it (of 59).
const hyp = [];
const add = (name, claim, matches) =>
  hyp.push({ name, claim, matches, of: rows.length, verdict: matches === rows.length ? 'confirmed' : matches === 0 ? 'refuted' : 'partial' });

const crc = (buf) => crc32(buf) >>> 0;
const sha4 = (buf) => buf.readUInt32BE(0);

add('crc32(prefix) as tail LE',
  'the varying 4 bytes are crc32 over the 32 described bytes, little-endian',
  rows.filter((r) => crc(r.prefix) === r.tailLe).length);
add('crc32(prefix) as tail BE',
  'the varying 4 bytes are crc32 over the 32 described bytes, big-endian',
  rows.filter((r) => crc(r.prefix) === r.tailBe).length);
add('sha256(prefix)[0..4] as tail BE',
  'the varying 4 bytes are the first 4 bytes of sha256 over the 32 described bytes',
  rows.filter((r) => sha4(createHash('sha256').update(r.prefix).digest()) === r.tailBe).length);
add('tail LE == input_amount mod 2^32',
  'the varying 4 bytes re-encode the declared input_amount argument',
  rows.filter((r) => r.tailLe === Number(r.input & 0xffffffffn)).length);
add('tail BE == input_amount mod 2^32',
  'same, big-endian',
  rows.filter((r) => r.tailBe === Number(r.input & 0xffffffffn)).length);
add('tail LE == output_amount mod 2^32',
  'the varying 4 bytes re-encode the declared output_amount argument',
  rows.filter((r) => r.tailLe === Number(r.output & 0xffffffffn)).length);
add('tail BE == output_amount mod 2^32',
  'same, big-endian',
  rows.filter((r) => r.tailBe === Number(r.output & 0xffffffffn)).length);
add('tail LE == expire_at mod 2^32',
  'the varying 4 bytes re-encode the declared expire_at argument',
  rows.filter((r) => r.tailLe === Number(BigInt.asUintN(32, r.expire))).length);
add('tail BE == expire_at mod 2^32',
  'same, big-endian',
  rows.filter((r) => r.tailBe === Number(BigInt.asUintN(32, r.expire))).length);
add('tail LE == slot',
  'the varying 4 bytes are the transaction slot (fits u32 until slot 4294967296)',
  rows.filter((r) => r.tailLe === r.slot).length);
add('tail BE == slot',
  'same, big-endian',
  rows.filter((r) => r.tailBe === r.slot).length);

// slot with a constant offset: confirmed only if the delta is the SAME for all 59
const deltasLe = new Set(rows.map((r) => r.tailLe - r.slot));
const deltasBe = new Set(rows.map((r) => r.tailBe - r.slot));
add('tail LE == slot + K',
  'the varying 4 bytes are the slot plus one constant offset (e.g. an expiry slot)',
  deltasLe.size === 1 ? rows.length : 0);
add('tail BE == slot + K',
  'same, big-endian',
  deltasBe.size === 1 ? rows.length : 0);

// ---- affine class mod 2^32 ------------------------------------------------
// "slot + K" is one member of a much larger family: V == A*base + B (mod 2^32).
// This single class covers seconds (A=1), milliseconds (A=1000), microseconds
// (A=10^6), any rescaling of the declared arguments, and any constant offset.
// A and B are DERIVED from the first payload pair with an invertible base delta
// (never fitted to the answer), then tested against every payload.
const modInv32 = (a) => {
  // odd a only; x2 gives inverse mod 2^32 by Newton iteration
  if ((a & 1) === 0) return null;
  let x = 1n;
  const m = 1n << 32n;
  const A = BigInt(a >>> 0);
  for (let i = 0; i < 6; i++) x = (x * (2n - A * x)) % m;
  return Number((x + m) % m);
};
const mod32 = (n) => Number(BigInt.asUintN(32, BigInt(n)));

const bases = {
  slot: rows.map((r) => r.slot),
  expire_at: rows.map((r) => Number(BigInt.asUintN(32, r.expire))),
  input_amount: rows.map((r) => Number(BigInt.asUintN(32, r.input))),
  output_amount: rows.map((r) => Number(BigInt.asUintN(32, r.output))),
};
for (const [name, xs] of Object.entries(bases)) {
  let derived = null;
  for (let i = 1; i < xs.length && !derived; i++) {
    const dx = mod32(xs[i] - xs[0]);
    const inv = modInv32(dx);
    if (inv === null) continue;
    const A = mod32((rows[i].tailLe - rows[0].tailLe) * inv);
    const B = mod32(rows[0].tailLe - A * xs[0]);
    derived = { A, B };
  }
  if (!derived) {
    add(`tail LE == A*${name} + B (mod 2^32)`,
      `the varying 4 bytes are an affine function of ${name} mod 2^32 (covers seconds/ms/us and any offset)`,
      0);
    continue;
  }
  const matches = rows.filter((r, i) => mod32(derived.A * xs[i] + derived.B) === r.tailLe).length;
  add(`tail LE == A*${name} + B (mod 2^32)`,
    `the varying 4 bytes are an affine function of ${name} mod 2^32; A,B derived from payload 0 and the first payload with an invertible delta, never fitted to the verdict (derived A=${derived.A}, B=${derived.B})`,
    matches);
}

// seconds-scale plausibility: a 4-byte unix-seconds field written now must sit
// near the harvest time. Refuted if NO payload value lands in the window.
const harvestedAt = Math.floor(new Date(harvest.harvestedAt).getTime() / 1000);
const inWindow = (v) => v >= harvestedAt - 86400 && v <= harvestedAt + 365 * 86400;
add('tail LE is a unix-seconds timestamp near harvest time',
  'the varying 4 bytes are a real-time timestamp in seconds (4 bytes hold ~2106)',
  rows.filter((r) => inWindow(r.tailLe)).length);
add('tail BE is a unix-seconds timestamp near harvest time',
  'same, big-endian',
  rows.filter((r) => inWindow(r.tailBe)).length);

// ---- distribution facts (not hypotheses: measured shape of the unknown) ----
const leValues = rows.map((r) => r.tailLe);
const beValues = rows.map((r) => r.tailBe);
const spread = (arr) => ({ min: Math.min(...arr), max: Math.max(...arr), range: Math.max(...arr) - Math.min(...arr) });
const leSp = spread(leValues);
const beSp = spread(beValues);

const report = {
  derivedFrom: 'test/fixtures/harvest-order-engine-2026-11-01.json',
  idl: 'test/fixtures/order-engine-idl.json (on-chain receipt, slot 463089384)',
  note: 'Every count below is derived from the committed fixture by this tool; re-run to reproduce. The verdict column is the count vs the payload total — no interpretation is recorded that the counts do not support.',
  fixture: {
    shortForm: `${forms.short.length} payloads of 32 bytes`,
    longForm: `${rows.length} payloads of 40 bytes`,
    discriminatorMatchesFill: allDisc,
    tagConstant: [...tags].map((t) => `0x${t.toString(16).padStart(8, '0')}`),
    tagDistinctValues: tags.size,
    varyingDistinctValues: vary.size,
    varyingZeroCount: zero,
    varyingMonotonicWithSlot: shuffled,
  },
  hypotheses: hyp,
  bands: {
    // the varying u32 does not use the u32 space uniformly; its top bits are
    // constrained. Recorded as a fact, not interpreted as a meaning.
    leTopByteValues: [...new Set(rows.map((r) => r.tailLe >>> 24))].sort((a, b) => a - b),
    leHigh16Range: [
      Math.min(...rows.map((r) => r.tailLe >>> 16)),
      Math.max(...rows.map((r) => r.tailLe >>> 16)),
    ],
    leHigh16Distinct: new Set(rows.map((r) => r.tailLe >>> 16)).size,
    leLow16Distinct: new Set(rows.map((r) => r.tailLe & 0xffff)).size,
  },
  distributions: {
    tailVaryingLe: leSp,
    tailVaryingBe: beSp,
    harvestSeconds: harvestedAt,
    slots: spread(rows.map((r) => r.slot)),
    expireAt: spread(rows.map((r) => Number(r.expire))),
    deltaTailLeMinusSlot: deltasLe.size <= 5 ? [...deltasLe] : { distinct: deltasLe.size },
    deltaTailBeMinusSlot: deltasBe.size <= 5 ? [...deltasBe] : { distinct: deltasBe.size },
  },
  conclusions: hyp.filter((h) => h.verdict === 'confirmed').map((h) => h.name),
  refuted: hyp.filter((h) => h.verdict === 'refuted').map((h) => h.name),
};

await writeFile(OUT, JSON.stringify(report, null, 2) + '\n');

const confirmed = report.conclusions;
console.log(`fixture: ${forms.short.length} x 32B, ${rows.length} x 40B, tag 0x${[...tags][0].toString(16)}, varying distinct ${vary.size}/${rows.length}`);
for (const h of hyp) console.log(`  ${h.verdict.padEnd(9)} ${h.matches}/${h.of}  ${h.name}`);
console.log('confirmed:', confirmed.length ? confirmed : '(none — the 4 varying bytes are unidentified)');
console.log('wrote research/rfq-order-engine-tail-2026-11-01.json');
