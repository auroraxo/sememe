// Account-list conformance: the declared interface against the wire.
//
// These tests are the ladder for the feature, and they were written against
// the defect class measured on a foreign first-party program (jup-ag
// order_engine: the published interface declared 11 accounts, every observed
// `fill` carried 12 or 13, and the extra account at the end SIGNS every fill
// and pays the fee in 31/141 — jup-ag/rfq-webhook-toolkit#96).
//
// What each test pins:
//   1. the ARITHMETIC of the verdict: an extra SIGNING account beyond the
//      declared list is an `undeclared-signing-account`;
//   2. the FALSE-POSITIVE GUARDS — the cases that must NOT be reported as
//      violations. These are the ones that decide whether the feature is
//      usable at all: Anchor's remaining_accounts (extra, non-signing), the
//      fee payer sitting at a non-signer position, a declared signer that
//      DOES sign, and Anchor's absent-optional placeholder (the program's
//      own id at an optional position);
//   3. the READ of the transaction shape: the signer flags come from the
//      message header counts, and a shape this file cannot read is REFUSED
//      rather than reported as conforming;
//   4. the SUMMARY derives from the rows, so a hand-edited summary cannot
//      disagree with the rows it claims to summarize.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkAccountList, declaredAccounts, instructionByDiscriminator, summarizeConformance,
} from '../src/account-list.mjs';
import {
  transactionKeys, transactionInstructions, discriminatorOf, ConformanceRefusal,
} from '../src/conformance.mjs';

const PROGRAM = '2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1';
const SYSTEM = '11111111111111111111111111111111';

const ADDRESS = {
  taker: '7oQkdyAaBGxBJAWDZRs4YGdXyMKgbmEKH8XeLLtZn1tZaczpfFZPft5tMEzAKwwprMCtH1xdQaEhyVPJZLQuehnT7E9n',
};

// The IDL's own `fill` declaration, copied from the verified store object
// (fingerprint sha256:f13a31e6…) so the test does not depend on the store.
const FILL_IDL = {
  instructions: [{
    name: 'fill',
    discriminator: [168, 96, 183, 163, 92, 10, 40, 160],
    accounts: [
      { name: 'taker', signer: true, writable: true },
      { name: 'maker', signer: true, writable: true },
      { name: 'taker_input_mint_token_account', optional: true, writable: true },
      { name: 'maker_input_mint_token_account', optional: true, writable: true },
      { name: 'taker_output_mint_token_account', optional: true, writable: true },
      { name: 'maker_output_mint_token_account', optional: true, writable: true },
      { name: 'input_mint' },
      { name: 'input_token_program' },
      { name: 'output_mint' },
      { name: 'output_token_program' },
      { name: 'system_program', address: SYSTEM },
    ],
    args: [
      { name: 'input_amount', type: 'u64' },
      { name: 'output_amount', type: 'u64' },
      { name: 'expire_at', type: 'i64' },
    ],
  }],
};

const fill = FILL_IDL.instructions[0];

/** A conforming 11-position account list (the IDL's own order), with the
 * declared signers at 0 and 1 and the pinned system program at 10. */
function conforming(overrides = {}) {
  const list = [
    { address: 'taker', signer: true },
    { address: 'maker', signer: true },
    { address: 'taker-in', signer: false },
    { address: 'maker-in', signer: false },
    { address: 'taker-out', signer: false },
    { address: 'maker-out', signer: false },
    { address: 'input-mint', signer: false },
    { address: 'input-token-program', signer: false },
    { address: 'output-mint', signer: false },
    { address: 'output-token-program', signer: false },
    { address: SYSTEM, signer: false },
  ];
  for (const [index, entry] of Object.entries(overrides)) list[Number(index)] = entry;
  return list;
}


test('the declared list is read from BOTH the new and the legacy IDL spec', () => {
  const modern = declaredAccounts(fill);
  assert.equal(modern.length, 11);
  assert.equal(modern[0].signer, true);
  assert.equal(modern[2].optional, true);
  assert.equal(modern[10].address, SYSTEM);

  const legacy = declaredAccounts({
    accounts: [
      { name: 'a', isSigner: true, isMut: true },
      { name: 'b', isSigner: false, isMut: false },
    ],
  });
  assert.equal(legacy[0].signer, true);
  assert.equal(legacy[0].writable, true);
  assert.equal(legacy[1].signer, false);
  assert.equal(legacy[1].writable, false);
});

test('an instruction is found by its discriminator, and a foreign one is not', () => {
  assert.equal(instructionByDiscriminator(FILL_IDL, fill.discriminator)?.name, 'fill');
  assert.equal(instructionByDiscriminator(FILL_IDL, [0, 0, 0, 0, 0, 0, 0, 0]), null);
  assert.equal(instructionByDiscriminator(FILL_IDL, [1, 2, 3]), null);
  assert.equal(instructionByDiscriminator(null, fill.discriminator), null);
});

test('an extra SIGNING account beyond the declared list is the finding', () => {
  const observed = [
    ...conforming(),
    { address: 'extra-program', signer: false },
    { address: 'pAEmG7MRXPxbALhEBDkxG2upr1JVTnwcB2hByCVafs4', signer: true },
  ];
  const result = checkAccountList(fill, observed, { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.verdict, 'undeclared-signing-account');
  assert.equal(result.violations.length, 1);
  const violation = result.violations[0];
  assert.equal(violation.kind, 'undeclared-signing-account');
  assert.equal(violation.extraCount, 2);
  assert.equal(violation.accounts.length, 1);
  // The declared list is 11 long, so the extras start at index 11; the
  // SIGNING one is the second extra, at index 12 — the same position the
  // co-signer occupies on chain.
  assert.equal(violation.accounts[0].index, 12);
  assert.equal(violation.accounts[0].address, 'pAEmG7MRXPxbALhEBDkxG2upr1JVTnwcB2hByCVafs4');
  assert.equal(violation.accounts[0].signer, true);
  assert.equal(result.positions.declared, 11);
  assert.equal(result.positions.observed, 13);
});

test('GUARD: extra NON-signing accounts (Anchor remaining_accounts) are not a violation', () => {
  const observed = [
    ...conforming(),
    { address: 'remaining-1', signer: false },
    { address: 'remaining-2', signer: false },
  ];
  const result = checkAccountList(fill, observed, { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.violations.length, 0, `no violation expected, got ${JSON.stringify(result.violations)}`);
  assert.equal(result.verdict, 'remaining-accounts');
  assert.ok(result.notes.some((note) => note.kind === 'remaining-accounts'));
});

test('GUARD: a signer at a non-signer position (the fee payer) is not a violation', () => {
  // The fee payer is usually account 0 and does NOT sign the instruction's
  // declared signer list in some programs; a declared non-signer that signs
  // anyway must not be reported.
  const instruction = {
    name: 'x',
    accounts: [{ name: 'payer', signer: false }, { name: 'authority', signer: true }],
  };
  const result = checkAccountList(instruction, [
    { address: 'payer', signer: true },
    { address: 'authority', signer: true },
  ], { program: PROGRAM });
  assert.equal(result.violations.length, 0);
  assert.ok(result.notes.some((note) => note.kind === 'signer-at-non-signer-position'));
});

test('GUARD: a declared signer that DOES sign is not a violation', () => {
  const result = checkAccountList(fill, conforming(), { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.violations.length, 0);
  assert.equal(result.verdict, 'conforms');
});

test('GUARD: Anchor\'s absent-optional placeholder (the program id) is not a signer violation', () => {
  // Anchor writes the PROGRAM's own id at an optional position when the
  // account is absent. It is not a signer and not a disagreement; comparing
  // it would manufacture a violation out of the convention.
  const observed = conforming({
    2: { address: PROGRAM, signer: false },
    3: { address: PROGRAM, signer: false },
    4: { address: PROGRAM, signer: false },
    5: { address: PROGRAM, signer: false },
  });
  const result = checkAccountList(fill, observed, { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.violations.length, 0, `no violation expected, got ${JSON.stringify(result.violations)}`);
  assert.ok(result.notes.some((note) => note.kind === 'absent-optional-accounts'));
});

test('a declared signer that does NOT sign IS a violation', () => {
  const observed = conforming({ 0: { address: 'taker', signer: false } });
  const result = checkAccountList(fill, observed, { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.verdict, 'declared-signer-not-signing');
  assert.equal(result.violations[0].index, 0);
  assert.equal(result.violations[0].name, 'taker');
});

test('a pinned address that the wire contradicts IS a violation', () => {
  const observed = conforming({ 10: { address: 'NOT-THE-SYSTEM-PROGRAM', signer: false } });
  const result = checkAccountList(fill, observed, { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.verdict, 'fixed-address-mismatch');
  assert.equal(result.violations[0].kind, 'fixed-address-mismatch');
  assert.equal(result.violations[0].declared, SYSTEM);
});

test('a list SHORTER than the declaration is a violation, unless the tail is optional', () => {
  const short = [
    { address: 'taker', signer: true },
    { address: 'maker', signer: true },
  ];
  const result = checkAccountList(fill, short, { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.verdict, 'missing-declared-accounts');
  assert.ok(result.violations[0].missing.length >= 1);

  // A list that stops inside an OPTIONAL tail is informational, not a
  // violation. `fill` puts its optional accounts in the MIDDLE (2..5), so a
  // truncation always drops non-optional positions too — that is why this
  // case needs an instruction whose optional accounts are at the END.
  const optionalTailInstruction = {
    name: 'with_optional_tail',
    accounts: [
      { name: 'authority', signer: true },
      { name: 'vault', signer: false },
      { name: 'maybe_a', optional: true },
      { name: 'maybe_b', optional: true },
    ],
  };
  const tail = checkAccountList(optionalTailInstruction, [
    { address: 'authority', signer: true },
    { address: 'vault', signer: false },
  ], { program: PROGRAM, programId: PROGRAM });
  assert.equal(tail.violations.length, 0, `no violation expected, got ${JSON.stringify(tail.violations)}`);
  assert.equal(tail.verdict, 'short-optional-tail');
  assert.ok(tail.notes.some((note) => note.kind === 'short-optional-tail'));
});

test('an unknown signer flag is recorded, never turned into a verdict', () => {
  const observed = conforming({ 0: { address: 'taker', signer: null } });
  const result = checkAccountList(fill, observed, { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.violations.length, 0, 'an unknown signer flag must not become a violation');
  assert.equal(result.unknownSigner.length, 1);
  assert.equal(result.unknownSigner[0].index, 0);
});

test('legacy isOptional is READ: an optional signer arriving unsigned is absent, not a violation', () => {
  // Measured on OpenBook v2 `cancelAllAndPlaceOrders`: the legacy IDL marks
  // `openOrdersAdmin` isOptional+isSigner, and live traffic passes it without
  // a signature whenever the admin is not needed — 40/40 of one fresh sample.
  // Losing the optional flag would have manufactured 40 violations out of the
  // account being absent.
  const instruction = {
    name: 'cancelAllAndPlaceOrders',
    accounts: [
      { name: 'signer', isSigner: true },
      { name: 'openOrdersAccount', isMut: true },
      { name: 'openOrdersAdmin', isOptional: true, isSigner: true },
      { name: 'market', isMut: true },
      { name: 'tokenProgram', isSigner: false },
    ],
  };
  assert.equal(declaredAccounts(instruction)[2].optional, true,
    'isOptional must be read from the legacy spec');

  const result = checkAccountList(instruction, [
    { address: 'authority', signer: true },
    { address: 'open-orders', signer: false },
    { address: 'some-placeholder', signer: false },
    { address: 'market', signer: false },
    { address: 'token-program', signer: false },
  ], { program: PROGRAM, programId: PROGRAM });
  assert.equal(result.violations.length, 0, `no violation expected, got ${JSON.stringify(result.violations)}`);
  assert.ok(result.notes.some((note) => note.kind === 'absent-optional-accounts'));
});

test('a declared signer at depth > 0 is a CPI boundary note, not a signature violation', () => {
  // Measured on Whirlpool swap_v2 invoked via CPI by the Titan router: the
  // top-level message header carries ONE signature, while the inner
  // instruction's declared token_authority is a PDA signed for inside the CPI
  // stack (`invoke_signed`), which never appears in numRequiredSignatures.
  const observed = conforming({ 0: { address: 'taker', signer: false } });

  const top = checkAccountList(fill, observed, { program: PROGRAM, programId: PROGRAM, depth: 0 });
  assert.equal(top.verdict, 'declared-signer-not-signing',
    'at depth 0 the header IS the authority and the violation stands');

  const inner = checkAccountList(fill, observed, { program: PROGRAM, programId: PROGRAM, depth: 1 });
  assert.equal(inner.violations.length, 0, `no violation expected, got ${JSON.stringify(inner.violations)}`);
  const note = inner.notes.find((entry) => entry.kind === 'cpi-signer-not-observable');
  assert.ok(note, 'the CPI boundary must be named as a note');
  assert.equal(note.index, 0);
  assert.equal(note.depth, 1);
  assert.ok(note.reason.includes('invoke_signed'));
});

test('an instruction the interface does not know is named, not guessed', () => {
  const result = checkAccountList(null, [{ address: 'x', signer: true }], { program: PROGRAM });
  assert.equal(result.verdict, 'unknown-instruction');
  assert.equal(result.violations.length, 0);
});

// ---------------------------------------------------------------------------
// The transaction shape
// ---------------------------------------------------------------------------

/** A transaction in the RPC `encoding: "json"` shape, with three signers. */
function transactionOf({ accountKeys, header, instructions, innerInstructions = [], err = null }) {
  return {
    transaction: {
      message: { accountKeys, header, instructions },
      signatures: ['sig0', 'sig1', 'sig2'],
    },
    meta: { err, innerInstructions },
  };
}

test('the signer flags come from the message header counts, not from the keys', () => {
  const transaction = transactionOf({
    accountKeys: ['a', 'b', 'c', 'd', 'e'],
    header: { numRequiredSignatures: 3, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: 1 },
    instructions: [],
  });
  const { keys } = transactionKeys(transaction);
  assert.deepEqual(keys.map((key) => key.signer), [true, true, true, false, false]);
  // The canonical order is [signers-writable, signers-readonly,
  // non-signers-writable, non-signers-readonly]: 3 signers of which 1 is
  // readonly -> indices 0 and 1 are signer-writable, index 2 is the
  // readonly signer; of the 2 non-signers, 1 is readonly -> index 3 is
  // non-signer-writable.
  assert.deepEqual(keys.map((key) => key.writable), [true, true, false, true, false]);
});

test('a transaction shape this file cannot read is REFUSED, not reported as conforming', () => {
  assert.throws(
    () => transactionKeys({ transaction: { message: { accountKeys: ['a'] } } }),
    (error) => error instanceof ConformanceRefusal && error.reason === 'unreadable-transaction',
  );
  assert.throws(
    () => transactionKeys({ transaction: { message: { accountKeys: [{ pubkey: 'a' }] } } }),
    (error) => error instanceof ConformanceRefusal,
    'a jsonParsed-shaped key object has no header counts here and must be refused',
  );
  assert.throws(
    () => transactionKeys(null),
    (error) => error instanceof ConformanceRefusal,
  );
});

test('an instruction\'s accounts are indices, resolved to addresses', () => {
  const transaction = transactionOf({
    accountKeys: ['payer', 'authority', 'other'],
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
    instructions: [{ programIdIndex: 1, accounts: [2, 0], data: 'abc' }],
  });
  const { instructions } = transactionInstructions(transaction);
  assert.equal(instructions.length, 1);
  assert.deepEqual(instructions[0].accounts.map((entry) => entry.address), ['other', 'payer']);
  assert.deepEqual(instructions[0].accounts.map((entry) => entry.signer), [false, true]);
});

test('a discriminator is read from the instruction data', () => {
  assert.deepEqual(discriminatorOf('9NF8W8BvXNkS5VUmJJqSAbNVPqYz5qkfG6NsUM7xbz7PkFPD1W99GTf').slice(0, 3),
    [168, 96, 183]);
  assert.equal(discriminatorOf(''), null);
  assert.equal(discriminatorOf(null), null);
  assert.equal(discriminatorOf('0OIl'), null, 'a non-base58 character must not decode');
});

// ---------------------------------------------------------------------------
// The live, measured case: the committed fixture's newest fill
// ---------------------------------------------------------------------------

test('the committed fixture\'s newest fill reproduces the first-party finding', async () => {
  // The finding was reported as jup-ag/rfq-webhook-toolkit#96: the published
  // interface says 11 accounts, the wire carries 13, and the 13th signs.
  const harvest = JSON.parse(readFileSync(
    new URL('../test/fixtures/harvest-order-engine-2026-11-01.json', import.meta.url),
    'utf8',
  ));
  const newest = [...harvest.transactions].sort((a, b) => b.slot - a.slot)[0];
  assert.equal(newest.payloads.length, 1);
  // The fixture records the payload bytes; the ACCOUNT list is not in the
  // fixture, so this test pins what IS in it: the payload length and the
  // discriminator, and the fixture's own count of transactions.
  assert.equal(Buffer.from(newest.payloads[0].dataHex, 'hex').length, 40);
  assert.equal(newest.payloads[0].dataHex.slice(0, 16), 'a860b7a35c0a28a0');
  assert.equal(harvest.transactions.length, 141);
});

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

test('the committed research report re-derives consistently from its rows', () => {
  // A committed report is reproducible only if its summary equals what the
  // shared summarizer derives from the committed rows: a hand-edited summary
  // cannot hide or invent findings.
  const path = new URL('../research/account-list-conformance-2026-11-03.json', import.meta.url);
  const report = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(report.rows.length, 236);
  assert.equal(report.disagreeing.length, 47);
  assert.equal(report.perProgram.length, 6);
  assert.equal(report.rpcFailures, 0);

  for (const prog of report.perProgram) {
    const programRows = report.rows.filter((row) => row.program === prog.program);
    const derived = summarizeConformance(programRows);
    assert.deepEqual(prog.summary.byVerdict, derived.byVerdict,
      `${prog.program}: per-program summary must re-derive from its rows`);
    assert.equal(prog.summary.instructions, programRows.length);
  }

  // The order_engine co-signer is pinned: exactly ONE constant address in
  // all 40 fills, signing in 40/40, at the LAST position of every fill.
  const oeRows = report.rows.filter((row) => row.program === PROGRAM);
  assert.equal(oeRows.length, 40);
  for (const row of oeRows) {
    assert.equal(row.verdict, 'undeclared-signing-account');
    const signing = row.violations[0].accounts;
    assert.equal(signing.length, 1);
    assert.equal(signing[0].address, 'pAEmG7MRXPxbALhEBDkxG2upr1JVTnwcB2hByCVafs4');
    // It sits at the LAST position of the observed list (index == length - 1).
    assert.equal(signing[0].index, row.positions.observed - 1);
  }
});

test('the summary is derived from the rows, not written by hand', () => {
  const rows = [
    { program: 'p1', instruction: 'a', verdict: 'conforms', executed: true, violations: [], unknownSigner: [] },
    { program: 'p1', instruction: 'a', verdict: 'undeclared-signing-account', executed: true, violations: [{ kind: 'undeclared-signing-account' }], unknownSigner: [] },
    { program: 'p2', instruction: 'b', verdict: 'remaining-accounts', executed: true, violations: [], unknownSigner: [{ index: 0 }] },
    { program: 'p2', instruction: 'b', verdict: 'unknown-discriminator', executed: null, violations: [], unknownSigner: [] },
  ];
  const summary = summarizeConformance(rows);
  assert.equal(summary.instructions, 4);
  assert.equal(summary.byVerdict.conforms, 1);
  assert.equal(summary.byVerdict['undeclared-signing-account'], 1);
  assert.equal(summary.byVerdict['remaining-accounts'], 1);
  assert.equal(summary.byVerdict['unknown-discriminator'], 1);
  assert.equal(summary.unknownDiscriminator, 1);
  assert.equal(summary.executed.total, 3);
  assert.equal(summary.executed.disagreements, 1);
  assert.equal(summary.unknownSignerPositions, 1);
  assert.equal(summary.byProgram.p1.instructions, 2);
  assert.equal(summary.byProgram.p2.instructions, 2);
  assert.equal(summary.byInstruction.a.total, 2);
});
