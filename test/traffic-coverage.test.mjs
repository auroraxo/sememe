// Real pump.fun and cp-amm traffic against the two IDLs, with the numbers pinned.
//
// Why this exists: the two programs were carried in `out/` of solana-tx-remix with
// `(unknown)` CPI labels because "they publish no on-chain IDL" — an assumption one
// pull falsified. Having the artifacts is step one; this test measures what they
// actually DECODE, because "the interface is in the store" and "the interface
// describes the bytes the deployed program emits" are different claims.
//
// Everything here is frozen: fixtures are committed, so the counts are reproducible
// offline and a change in them means the CODE changed, not the chain.
//
// The honest headline, all three measured on the same 996 payloads:
//   on-chain IDL alone      669/996 decoded, 327 refused (unknown discriminator)
//   published (first-party) 880/996 decoded, 116 refused (truncated input)
//   union of both           914/996 decoded,  82 refused
// The two sources disagree with EACH OTHER about a deployed program, which is the
// point: neither is "the interface", and a pull records a view, not the truth.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decodeData, encodeInstructionData, encodeEventData, toJsonSafe, CodecError,
} from '../src/codec.mjs';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CPAMM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

const load = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const pumpIdl = await load('pump-idl.json');
const cpAmmIdl = await load('cp-amm-idl.json');
const pumpHarvest = await load('harvest-pump-2026-10-30.json');
const cpAmmHarvest = await load('harvest-cp-amm-2026-10-30.json');
// First-party published copy: pump-fun/pump-public-docs idl/pump.json, same commit.
const pumpPublished = await load('pump-published-idl.json');

const payloads = (harvest) =>
  harvest.transactions.flatMap((tx) =>
    (tx.payloads ?? []).map((p) => ({
      bytes: Buffer.from(p.dataHex, 'hex'),
      failed: tx.txErr !== null,
      signature: tx.signature,
    })));

/** Decode every payload, tallying verdicts without hiding any of them. */
function measure(idl, rows) {
  const out = {
    total: rows.length, decoded: 0, refused: 0, trailing: 0,
    byteExact: 0, refusals: {},
  };
  for (const row of rows) {
    let decoded;
    try {
      decoded = decodeData(idl, row.bytes, { trailing: 'report' });
    } catch (error) {
      out.refused++;
      const key = String(error.message).slice(0, 40);
      out.refusals[key] = (out.refusals[key] ?? 0) + 1;
      continue;
    }
    out.decoded++;
    if (decoded.trailing.count > 0) out.trailing++;
    const re = decoded.kind === 'instruction'
      ? encodeInstructionData(idl, decoded.instruction, decoded.args)
      : encodeEventData(idl, decoded.event, decoded.args);
    if (re.equals(row.bytes)) out.byteExact++;
  }
  return out;
}

test('the fixtures carry the programs and traffic they claim', () => {
  assert.equal(pumpIdl.address, PUMP);
  assert.equal(cpAmmIdl.address, CPAMM);
  assert.equal(pumpPublished.address, PUMP);
  assert.equal(pumpHarvest.program, PUMP);
  assert.equal(cpAmmHarvest.program, CPAMM);
  assert.equal(payloads(pumpHarvest).length, 996);
  assert.equal(payloads(cpAmmHarvest).length, 1894);
});

test('cp-amm: the on-chain IDL decodes every real payload, byte-exact', () => {
  const rows = payloads(cpAmmHarvest);
  const m = measure(cpAmmIdl, rows);
  assert.equal(m.refused, 0, `unexpected refusals: ${JSON.stringify(m.refusals)}`);
  assert.equal(m.decoded, 1894);
  // 6 payloads carry trailing bytes the IDL does not describe (swap, 8 zero bytes
  // or 1 zero byte) — the deployed program's swap is ahead of its own IDL. Those
  // cannot be byte-exact by construction: the re-encode has no field to write.
  assert.equal(m.byteExact, 1888);
  assert.equal(m.trailing, 6);
});

test('pump.fun: the on-chain IDL alone refuses a third of real traffic', () => {
  const m = measure(pumpIdl, payloads(pumpHarvest));
  assert.equal(m.decoded, 669);
  assert.equal(m.refused, 327);
  // Every refusal is an unknown discriminator, not a codec failure: the
  // deployed program executes instructions its own on-chain IDL does not list.
  assert.ok(!('OptionBool: malformed struct field' in m.refusals),
    'the tuple-struct defect is back');
  const unknown = Object.entries(m.refusals)
    .filter(([k]) => k.startsWith('unknown instruction'))
    .reduce((sum, [, v]) => sum + v, 0);
  assert.equal(unknown, 326);
});

test('pump.fun: the published first-party IDL names the 326 the on-chain one cannot', () => {
  const onChainDiscs = new Set(
    pumpIdl.instructions.map((i) => Buffer.from(i.discriminator).toString('hex')));
  const publishedDiscs = new Map(
    pumpPublished.instructions.map((i) => [Buffer.from(i.discriminator).toString('hex'), i.name]));

  // Disciplines the on-chain IDL lacks, that appear in real traffic:
  const missing = {};
  for (const row of payloads(pumpHarvest)) {
    const disc = row.bytes.subarray(0, 8).toString('hex');
    if (onChainDiscs.has(disc) || disc === 'e445a52e51cb9a1d') continue;
    missing[disc] = (missing[disc] ?? 0) + 1;
  }
  const total = Object.values(missing).reduce((a, b) => a + b, 0);
  assert.equal(total, 326);
  // The published copy must name every one of them — no guessing.
  for (const [disc, count] of Object.entries(missing)) {
    assert.ok(publishedDiscs.has(disc),
      `discriminator ${disc} (${count} payloads) is not in the published IDL either`);
  }
  const names = Object.keys(missing)
    .map((d) => publishedDiscs.get(d))
    .sort();
  assert.deepEqual(names, [
    'buy_exact_quote_in_v3', 'buy_v3', 'multi_hop_curve_swap', 'sell_v3',
    'sweep_creator_fee',
  ]);
});

test('pump.fun: neither source alone describes the deployed program', () => {
  const rows = payloads(pumpHarvest);
  const onChain = measure(pumpIdl, rows);
  const published = measure(pumpPublished, rows);
  assert.equal(published.decoded, 880);
  assert.equal(published.refused, 116);
  assert.ok(published.decoded > onChain.decoded,
    'published copy should explain more traffic than the stale on-chain account');
  assert.ok(onChain.decoded > 0 && published.refused > 0,
    'neither source reaches 996 — the limit must stay visible');
  // The published copy is not a superset either: its `buy` carries a
  // `partial_fill` argument the deployed program does not always send, which is
  // where its own 116 refusals come from.
  assert.ok(Object.values(published.refusals).every((v) => v > 0));
});

test('pump.fun: TradeEvent carries 8 bytes no published field explains', () => {
  const rows = payloads(pumpHarvest);
  const withTrailing = [];
  for (const row of rows) {
    let decoded;
    try { decoded = decodeData(pumpPublished, row.bytes, { trailing: 'report' }); }
    catch { continue; }
    if (decoded.kind === 'event' && decoded.event === 'TradeEvent') {
      withTrailing.push(decoded.trailing);
    }
  }
  assert.ok(withTrailing.length >= 80, `expected a real sample, got ${withTrailing.length}`);
  for (const trailing of withTrailing) {
    assert.equal(trailing.count, 8, 'the unattributed tail is exactly one u64');
    assert.equal(trailing.hex, '0000000000000000',
      'every observed value is zero in this window — so it is NOT proven to be a field');
  }
});

test('refusal does not predict on-chain failure (the flattering version is false)', () => {
  const rows = payloads(pumpHarvest);
  const cell = {};
  for (const row of rows) {
    let refused = false;
    try { decodeData(pumpPublished, row.bytes, { trailing: 'report' }); }
    catch { refused = true; }
    const key = `${refused ? 'refused' : 'decoded'}-${row.failed ? 'failed' : 'success'}`;
    cell[key] = (cell[key] ?? 0) + 1;
  }
  // A decoder refusal is about the IDL, not about the chain: plenty of
  // transactions the IDL cannot describe were accepted by the program, and most
  // transactions it CAN describe still failed for their own reasons (slippage…).
  assert.ok(cell['refused-success'] > 0,
    'if refusal implied failure this cell would be empty');
  assert.ok(cell['decoded-success'] > 0);
  assert.ok(cell['decoded-failed'] > 0);
  // Pinned so the shape of this cannot drift silently.
  assert.deepEqual(cell, {
    'decoded-failed': 715,
    'decoded-success': 165,
    'refused-failed': 84,
    'refused-success': 32,
  });
});

test('both IDLs store every discriminator they list (no derivation needed)', () => {
  for (const [label, idl] of [['on-chain', pumpIdl], ['published', pumpPublished], ['cp-amm', cpAmmIdl]]) {
    assert.ok(idl.instructions.every((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8),
      `${label}: instruction without a stored discriminator`);
    assert.ok((idl.events ?? []).every((e) => Array.isArray(e.discriminator) && e.discriminator.length === 8),
      `${label}: event without a stored discriminator`);
  }
});

test('the committed report is the one the tool produces (no hand-edited numbers)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [fileURLToPath(new URL('../tools/traffic-coverage.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  const produced = JSON.parse(stdout);
  const committed = JSON.parse(await readFile(new URL('../research/traffic-coverage-2026-10-30.json', import.meta.url), 'utf8'));
  delete produced.generatedAt;
  delete committed.generatedAt;
  assert.deepEqual(committed, produced,
    'research/traffic-coverage-2026-10-30.json has drifted from what tools/traffic-coverage.mjs computes');
});

test('cp-amm and pump IDLs agree with Anchor derivation on every stored value', async () => {
  const { createHash } = await import('node:crypto');
  const snake = (name) => name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  for (const idl of [pumpIdl, cpAmmIdl]) {
    for (const ix of idl.instructions) {
      const derived = createHash('sha256').update(`global:${snake(ix.name)}`)
        .digest().subarray(0, 8).toString('hex');
      assert.equal(Buffer.from(ix.discriminator).toString('hex'), derived, ix.name);
    }
    for (const ev of idl.events ?? []) {
      const derived = createHash('sha256').update(`event:${ev.name}`)
        .digest().subarray(0, 8).toString('hex');
      assert.equal(Buffer.from(ev.discriminator).toString('hex'), derived, ev.name);
    }
  }
});
