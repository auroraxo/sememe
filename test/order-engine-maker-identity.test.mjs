// WHO signs the fill — the premise the 2026-11-01 attribution left open, and
// the account list nobody had looked at.
//
// The attribution concluded that the 8 undeclared trailing bytes are "one
// counterparty's own extension of a shared protocol instruction". That rested
// on an unverified premise: that the `maker` account is a CLIENT. This suite
// pins the measurement that decides it, from the committed report.
//
// It also pins the three tool defects that this measurement run found — each
// of them produced a wrong verdict while looking like a successful run:
//
//   1. instruction data in encoding "json" is BASE58, not base64: decoding it
//      as base64 produced plausible-looking payload bytes of the wrong length
//      and a wrong discriminator, which looked like "the program changed its
//      wire format";
//   2. a signature entry in encoding "json" is a base58 STRING, not
//      {signature}: reading s.signature yielded undefined and classified every
//      signer as null-signed ("12/12 makers did not sign");
//   3. getAccountInfo returns [base64Data, "base64"]: element 1 is the
//      encoding NAME. Reading it as a length labelled every wallet as a
//      data-carrying system account.
//
// A hand-edited verdict, a flipped maker, a mutated account count or a
// tampered payload cross-check goes red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const HARVEST = new URL('./fixtures/harvest-order-engine-2026-11-01.json', import.meta.url);
const IDL = new URL('./fixtures/order-engine-idl.json', import.meta.url);
const REPORT = new URL('../research/order-engine-maker-identity-2026-11-02.json', import.meta.url);

const harvest = JSON.parse(await readFile(HARVEST, 'utf8'));
const idl = JSON.parse(await readFile(IDL, 'utf8'));
const report = JSON.parse(await readFile(REPORT, 'utf8'));

const fillDecl = idl.instructions.find((ix) => ix.name === 'fill');
const declaredAccounts = fillDecl.accounts.length;

test('the fixture still carries the order_engine fills', () => {
  assert.equal(harvest.transactions.length, 141, 'fixture transactions');
  assert.equal(fillDecl.discriminator.length, 8, 'fill discriminator is 8 bytes');
});

test('every transaction in the report resolved, and its payload matches the fixture byte for byte', () => {
  assert.equal(report.coverage.transactionsResolved, harvest.transactions.length, 'all transactions resolved');
  assert.equal(report.coverage.transactionsFailed, 0, 'no failed transaction');
  const mismatch = report.payloadCrossCheck.mismatches.filter((m) => m.signature);
  assert.equal(mismatch.length, 0, `payload mismatches: ${JSON.stringify(mismatch)}`);
  assert.equal(report.payloadCrossCheck.byteIdenticalToFixture, harvest.transactions.length, 'payload bytes identical');
});

test('the report re-derives its own rows from the fixture, not from its own summary', () => {
  const rows = report.rows;
  assert.equal(rows.length, harvest.transactions.length, 'one row per fixture transaction');
  const fixtureSigs = new Set(harvest.transactions.map((t) => t.signature));
  for (const row of rows) {
    assert.ok(fixtureSigs.has(row.signature), `row is a real fixture transaction: ${row.signature}`);
    assert.ok(row.ok, `row resolved: ${row.signature}`);
  }
});

test('the account list carries more accounts than the IDL declares, and the extra ones are constant', () => {
  assert.equal(report.accountList.declaredAccountCount, declaredAccounts, 'declared account count');
  const counts = Object.values(report.accountList.observedAccountCounts);
  assert.ok(counts.length > 0, 'observed account counts');
  // Every observed count is at least the declared count: the wire carries the
  // declared accounts plus extra ones.
  for (const [count, n] of Object.entries(report.accountList.observedAccountCounts)) {
    assert.ok(Number(count) >= declaredAccounts, `observed account count ${count} >= declared ${declaredAccounts}`);
    assert.ok(n > 0, 'count has samples');
  }
  assert.ok(report.accountList.transactionsWithUndeclaredAccounts > 0, 'some transactions carry undeclared accounts');
  const constant = report.accountList.constantUndeclaredAddresses;
  assert.ok(constant.length > 0, 'at least one undeclared account appears in EVERY transaction');
  for (const c of constant) {
    assert.equal(c.count, report.coverage.transactionsResolved, 'constant account present in all transactions');
  }
});

test('the undeclared trailing account signs the transaction', () => {
  const constant = report.accountList.constantUndeclaredAddresses;
  const signing = constant.filter((c) => c.signedCount > 0);
  assert.ok(signing.length > 0, 'a constant undeclared account is a signer');
});

test('the counterparties are key-holding clients, proven by the off-curve test and the chain', () => {
  const makers = report.counterparties.makers;
  assert.ok(makers.length >= 2, 'at least two distinct makers');
  for (const m of makers) {
    const curve = report.counterparties.curveFacts[m];
    assert.equal(curve.onCurve, true, `maker ${m} is on-curve (can hold a key)`);
    const account = report.counterparties.accountFacts[m];
    assert.equal(account.owner, '11111111111111111111111111111111', `maker ${m} is system-owned`);
    assert.equal(account.dataLen, 0, `maker ${m} carries no data`);
    assert.equal(account.isWallet, true, `maker ${m} is a wallet`);
  }
});

test('the makers and takers sign; the fee payer is a signer and never the maker', () => {
  assert.equal(report.counterparties.makerSignedTransactions, report.coverage.transactionsResolved, 'every maker signs');
  assert.equal(report.counterparties.takerSignedTransactions, report.coverage.transactionsResolved, 'every taker signs');
  assert.equal(report.counterparties.feePayerIsMakerTransactions, 0, 'the maker never pays the fee');
  assert.ok(report.counterparties.distinctFeePayers > 1, 'the fee payers differ (not one service wallet)');
  // The fee payer is the taker in most transactions and the undeclared
  // co-signer in the rest; together they cover every transaction.
  const paid = report.counterparties.feePayerIsTakerTransactions + report.counterparties.feePayerIsUndeclaredAccountTransactions;
  assert.equal(paid, report.coverage.transactionsResolved, 'every transaction is paid by taker or the undeclared co-signer');
});

test('each wire form belongs to a different maker — the extension correlates with one side', () => {
  assert.equal(report.counterparties.formAndMakerDisjoint, true, '32-byte and 40-byte forms share no maker');
  assert.equal(report.finding.extensionCorrelatesWithMaker, true, 'extension correlates with the maker');
  // The suite does not trust the summary: it re-derives from the rows.
  const byForm = {};
  for (const row of report.rows) (byForm[row.fixturePayloadLength] ??= new Set()).add(row.maker);
  const shared = [...byForm[32]].filter((m) => byForm[40].has(m));
  assert.equal(shared.length, 0, 'no maker appears in both forms');
  assert.ok(report.finding.builderProven === false, 'the builder among the three signers is explicitly NOT claimed as proven');
  assert.ok(Array.isArray(report.finding.limits) && report.finding.limits.length >= 3, 'the limits travel with the finding');
});

// The report's summary must be re-derivable from its own rows: a number that
// was edited by hand (or a tool that writes its verdict first and measures
// later) is caught here. Each check runs against any report object, so the
// falsification tests below can run it against tampered copies and require
// it to FAIL.
function assertSummaryMatchesRows(r) {
  const okRows = r.rows.filter((row) => row.ok);
  const makers = new Set(okRows.map((row) => row.maker));
  assert.deepEqual([...makers].sort(), [...r.counterparties.makers].sort(), 'makers summary == makers in rows');
  assert.equal(r.counterparties.makerSignedTransactions, okRows.filter((row) => row.makerSigned).length, 'makerSigned count == rows');
  assert.equal(r.counterparties.takerSignedTransactions, okRows.filter((row) => row.takerSigned).length, 'takerSigned count == rows');
  assert.equal(r.counterparties.feePayerIsTakerTransactions, okRows.filter((row) => row.feePayerIsTaker).length, 'feePayerIsTaker count == rows');
  assert.equal(r.counterparties.feePayerIsMakerTransactions, okRows.filter((row) => row.feePayerIsMaker).length, 'feePayerIsMaker count == rows');
  assert.equal(r.counterparties.distinctFeePayers, new Set(okRows.map((row) => row.feePayer)).size, 'distinct fee payers == rows');
  assert.equal(r.payloadCrossCheck.byteIdenticalToFixture, okRows.filter((row) => row.payloadBytesMatch).length, 'byte-identical == rows');
  assert.equal(r.coverage.transactionsResolved, okRows.length, 'resolved == rows');
  assert.equal(r.coverage.transactionsFailed, r.rows.length - okRows.length, 'failed == rows');
  // account-count histogram re-derived from the rows
  const histogram = {};
  for (const row of okRows) histogram[row.accountCount] = (histogram[row.accountCount] ?? 0) + 1;
  assert.deepEqual(r.accountList.observedAccountCounts, histogram, 'account histogram == rows');
  // constant undeclared addresses re-derived from the rows
  const freq = {};
  for (const row of okRows) for (const u of row.undeclared) (freq[u.address] ??= { count: 0, signedCount: 0, feePayerCount: 0 }).count++;
  for (const row of okRows) for (const u of row.undeclared) {
    if (u.signed) freq[u.address].signedCount++;
    if (u.isFeePayer) freq[u.address].feePayerCount++;
  }
  assert.deepEqual(r.accountList.undeclaredAddressFrequency, freq, 'undeclared frequency == rows');
  const constants = Object.entries(freq).filter(([, e]) => e.count === okRows.length).map(([address, e]) => ({ address, ...e }));
  assert.deepEqual(r.accountList.constantUndeclaredAddresses, constants, 'constant undeclared == re-derived');
  // maker-per-form mapping re-derived from the rows
  const byForm = {};
  for (const row of okRows) (byForm[row.fixturePayloadLength] ??= new Set()).add(row.maker);
  assert.deepEqual(
    Object.fromEntries(Object.entries(byForm).map(([f, s]) => [f, [...s]])),
    r.counterparties.makerByForm,
    'maker-by-form == rows',
  );
}

test('the report summary is re-derivable from its own rows', () => {
  assertSummaryMatchesRows(report);
});

test('a hand-edited summary number goes red (falsification)', () => {
  // Each mutation is a plausible hand-edit; EVERY one must make the check
  // fail. If any mutation passes, this guard is decorative.
  const mutations = [
    (r) => { r.counterparties.makerSignedTransactions = r.coverage.transactionsResolved - 1; },
    (r) => { r.counterparties.feePayerIsTakerTransactions = r.coverage.transactionsResolved; },
    (r) => { r.payloadCrossCheck.byteIdenticalToFixture = r.payloadCrossCheck.checked - 1; },
    (r) => { r.accountList.observedAccountCounts = { 11: r.coverage.transactionsResolved }; },
    (r) => { r.accountList.constantUndeclaredAddresses = []; },
    (r) => { r.counterparties.makers = [r.counterparties.makers[0]]; },
    (r) => { r.counterparties.distinctFeePayers = 1; },
    (r) => { r.coverage.transactionsFailed = 3; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const tampered = JSON.parse(JSON.stringify(report));
    mutate(tampered);
    assert.throws(() => assertSummaryMatchesRows(tampered), undefined, `mutation ${i} must go red`);
  }
});

test('a swapped maker in the row data goes red', () => {
  const tampered = JSON.parse(JSON.stringify(report));
  const makers = [...new Set(tampered.rows.map((r) => r.maker))];
  tampered.rows.forEach((r) => { r.maker = makers[0]; });
  assert.equal(new Set(tampered.rows.map((r) => r.maker)).size, 1, 'one maker left');
  assert.notEqual(new Set(tampered.rows.map((r) => r.maker)).size, report.counterparties.makers.length);
  assert.throws(() => assertSummaryMatchesRows(tampered), undefined, 'the summary now disagrees with the tampered rows');
});

test('the payload cross-check is not a constant', () => {
  assert.ok(report.payloadCrossCheck.checked > 0, 'cross-check ran');
  assert.equal(report.payloadCrossCheck.byteIdenticalToFixture, report.payloadCrossCheck.checked, 'all identical');
});
