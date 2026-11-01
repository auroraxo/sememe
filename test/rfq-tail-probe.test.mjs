// The state-side probe of the 8 undeclared trailing bytes: what it measured and
// what its numbers may claim.
//
// The probe (tools/order-engine-tail-probe.mjs) answers the two questions the
// fixture alone could not: is there a PUBLISHED interface revision that declares
// a 4th argument (a fresh pull of both IDL surfaces decides), and does the
// varying word occur OUTSIDE the instruction bytes (the transaction's balance
// surface, sibling instructions, every touched account's data, the program's
// own state accounts)?
//
// This suite is offline: it reads the committed probe report, verifies the
// report is internally consistent with the committed fixture (the same payload
// bytes it claims to have searched), and pins the derived verdicts. The two
// refutations are the finding — if either one flips, this suite must go red and
// force a re-measurement rather than a rewording.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const HARVEST = new URL('./fixtures/harvest-order-engine-2026-11-01.json', import.meta.url);
const REPORT = new URL('../research/order-engine-tail-probe-2026-11-01.json', import.meta.url);

const harvest = JSON.parse(await readFile(HARVEST, 'utf8'));
const report = JSON.parse(await readFile(REPORT, 'utf8'));

const u32le = (b, o) => b.readUInt32LE(o);
const longs = harvest.transactions
  .flatMap((tx) => (tx.missing ? [] : (tx.payloads ?? [])))
  .filter((p) => p.dataHex.length === 80)
  .map((p, i) => ({ slot: harvest.transactions[i]?.slot ?? harvest.transactions.find((t) => (t.payloads ?? []).includes(p))?.slot, bytes: Buffer.from(p.dataHex, 'hex') }));

test('the probe searched payloads that exist in the fixture', () => {
  const slots = harvest.transactions.filter((t) => (t.payloads ?? []).some((p) => p.dataHex.length === 80)).map((t) => t.slot).sort((a, b) => a - b);
  assert.equal(longs.length, 59, 'the fixture still carries 59 long payloads');
  assert.ok(report.samples.length >= 4, 'at least four transactions were sampled');
  for (const s of report.samples) {
    assert.ok(slots.includes(s.slot), `sampled slot ${s.slot} must be a payload-carrying slot of the fixture`);
    assert.ok(/^[1-9A-HJ-NP-Za-km-z]{86,90}$/.test(s.signature), `signature is base58 (${s.signature.length} chars)`);
    assert.ok(Number.isInteger(s.varyingU32) && s.varyingU32 > 0, 'varying u32 is a positive integer');
  }
});

test('the samples are spread across the slot range, not one corner', () => {
  const used = new Set(report.samples.map((s) => s.slot));
  const all = harvest.transactions.filter((t) => (t.payloads ?? []).some((p) => p.dataHex.length === 80)).map((t) => t.slot);
  const lo = Math.min(...all), hi = Math.max(...all);
  assert.ok(used.has(lo), 'the earliest payload slot is covered');
  assert.ok(used.has(hi), 'the latest payload slot is covered');
});

test('refutation A: the published interface still declares exactly the three known arguments', () => {
  const surfaces = report.idlSurfaces;
  assert.ok(Array.isArray(surfaces) && surfaces.length >= 1, 'both IDL surfaces were probed');
  const anchor = surfaces.find((s) => s.source === 'anchor');
  assert.ok(anchor, 'the anchor surface must be present in the report');
  assert.equal(anchor.matchesReceiptFingerprint, true, 'the fresh pull must reproduce the receipt fingerprint');
  assert.deepEqual(anchor.declaredFillArgs, ['input_amount:u64', 'output_amount:u64', 'expire_at:i64'],
    'if the chain declares a 4th argument the finding has changed and this suite must be re-measured, not edited');
  assert.equal(report.refutedNeverPublishedRevision, true, 'the verdict must state the refutation');
});

test('refutation B: the word occurs in no chain surface the probe searched', () => {
  assert.ok(report.totals.samples >= 4, 'the totals cover the sampled transactions');
  assert.equal(report.totals.balanceSurfaceHits, 0, 'balance surface');
  assert.equal(report.totals.siblingInstructionHits, 0, 'sibling instruction bytes');
  assert.equal(report.totals.touchedAccountDataHits, 0, 'touched account data');
  assert.equal(report.refutedValueOutsideInstructionBytes, true, 'the verdict must state the refutation');
});

test('the search counts match the sample rows', () => {
  const sum = (k) => report.samples.reduce((n, s) => n + s[k].length, 0);
  assert.equal(sum('transactionBalanceSurfaceHits'), report.totals.balanceSurfaceHits, 'balance hits');
  assert.equal(sum('siblingInstructionHits'), report.totals.siblingInstructionHits, 'instruction hits');
  assert.equal(sum('touchedAccountDataHits'), report.totals.touchedAccountDataHits, 'account-data hits');
  for (const s of report.samples) {
    assert.ok(s.accountsChecked >= 10, `sample at ${s.slot} checked the transaction's accounts (${s.accountsChecked})`);
    const counter = BigInt(s.counterU64);
    const word = BigInt(s.varyingU32);
    assert.equal(counter & 0xffffffffn, word, 'the recorded counter is (tag<<32) | word with this sample\'s word');
  }
});

test('the program state search was actually performed', () => {
  assert.equal(report.programStateAccountsSearched, true, 'getProgramAccounts must have run');
  assert.ok(Array.isArray(report.programStateAccounts.counterHits), 'counter hits are counted, not asserted');
  assert.equal(report.programStateAccounts.counterHits.length, 0, 'no program-state account carries the counter');
});

test('the probe counted its own network cost', () => {
  assert.ok(report.rpcCallCount > 0, 'every fetch is counted');
  assert.equal(report.rpcFailures, 0, 'a probe that gave up on a fetch cannot publish a verdict');
});
