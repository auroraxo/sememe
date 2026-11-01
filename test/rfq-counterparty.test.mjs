// WHO writes the 40-byte fill wire — the attribution the tail studies could not
// give from the instruction bytes alone.
//
// The committed report (research/order-engine-counterparty-2026-11-01.json)
// contains one row per payload, each carrying the counterparty resolved from
// the CHAIN. This suite does not trust the report's own `finding` summary: it
// re-derives the maker sets from the rows, checks every row against the
// fixture's payload bytes (so a row can never claim a payload that does not
// exist or belongs to the other wire form), and only then compares its
// derivation with the recorded verdict. A hand-edited verdict, a row for the
// wrong form, or a second counterparty appearing in either form goes red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const HARVEST = new URL('./fixtures/harvest-order-engine-2026-11-01.json', import.meta.url);
const REPORT = new URL('../research/order-engine-counterparty-2026-11-01.json', import.meta.url);

const harvest = JSON.parse(await readFile(HARVEST, 'utf8'));
const report = JSON.parse(await readFile(REPORT, 'utf8'));

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const payloads = (len) =>
  harvest.transactions
    .flatMap((tx) => (tx.missing ? [] : (tx.payloads ?? []).map((p) => ({ slot: tx.slot, sig: tx.signature, len: Buffer.from(p.dataHex, 'hex').length }))))
    .filter((p) => p.len === len);

const longFixture = payloads(40);
const shortFixture = payloads(32);

test('the fixture still carries both wire forms', () => {
  assert.equal(longFixture.length, 59, '40-byte form');
  assert.equal(shortFixture.length, 82, '32-byte form');
});

test('every row is a real payload of the form it claims, on the side it claims', () => {
  for (const form of [report.longForm, report.shortForm]) {
    assert.ok(form.sampleSize > 0, `${form.formBytes}B: rows exist`);
    assert.equal(form.resolved, form.rows.filter((r) => r.maker && !r.error).length, `${form.formBytes}B: resolved counts`);
    const expected = form.formBytes === 40 ? longFixture : shortFixture;
    const want = new Set(expected.map((p) => `${p.slot}:${p.sig}`));
    for (const row of form.rows) {
      assert.ok(want.has(`${row.slot}:${row.signature}`), `${form.formBytes}B row ${row.slot} must exist in the fixture with this form's bytes`);
      assert.ok(BASE58.test(row.maker), `${form.formBytes}B row ${row.slot}: maker is a pubkey`);
      assert.ok(BASE58.test(row.taker), `${form.formBytes}B row ${row.slot}: taker is a pubkey`);
      assert.notEqual(row.maker, row.taker, 'the two roles are distinct accounts');
    }
  }
});

test('the coverage of the attribution is stated with the finding', () => {
  assert.ok(['full', 'sampled'].includes(report.coverage.mode), 'coverage mode');
  assert.equal(report.coverage.longFormPayloads, longFixture.length, 'the report knows the full population');
  assert.equal(report.coverage.shortFormPayloads, shortFixture.length, 'the report knows the full population');
  assert.equal(report.longForm.sampleSize, report.coverage.longFormResolved + (report.longForm.rows.length - report.longForm.resolved));
  if (report.coverage.mode === 'full') {
    assert.equal(report.coverage.longFormResolved, longFixture.length, 'full mode means every long payload was attributed');
    assert.equal(report.coverage.shortFormResolved, shortFixture.length, 'full mode means every short payload was attributed');
    assert.equal(report.finding.exhaustive, true, 'the report must not call itself exhaustive when it is not');
  }
});

test('the verdict is re-derived from the rows, not read off the summary', () => {
  const makersOf = (form) => new Set(form.rows.map((r) => r.maker));
  const longMakers = makersOf(report.longForm);
  const shortMakers = makersOf(report.shortForm);
  const shared = [...longMakers].filter((m) => shortMakers.has(m));

  assert.deepEqual([...longMakers].sort(), [...report.finding.longFormMakers].sort(), 'long maker set must be re-derivable');
  assert.deepEqual([...shortMakers].sort(), [...report.finding.shortFormMakers].sort(), 'short maker set must be re-derivable');
  assert.deepEqual(shared, report.finding.sharedCounterparties, 'shared counterparties must be re-derivable');

  assert.equal(longMakers.size, 1, `exactly ONE counterparty writes the 40-byte form (found ${longMakers.size})`);
  assert.equal(shortMakers.size, 1, `exactly ONE counterparty writes the 32-byte form (found ${shortMakers.size})`);
  assert.equal(shared.length, 0, 'the two forms come from different counterparties — this is the finding');
  assert.equal(report.finding.oneCounterpartyPerForm, true, 'the summary must match the derivation');
  assert.match(report.finding.verdict, /DIFFERENT counterparties/, 'the verdict must name the measured relation');
});

test('the probe counted its network cost and did not fail a fetch', () => {
  assert.ok(report.rpcCallCount > 0, 'every fetch is counted');
  assert.equal(report.rpcFailures, 0, 'a run with give-ups cannot publish an attribution');
});
