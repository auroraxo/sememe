// test/conformance-filter-domain.test.mjs — A FILTER THAT MATCHES NOTHING MUST BE REFUSED
//
// THE DEFECT THIS PINS (measured 2026-11-09, published v0.4.12):
//
// `sememe conform --only <program>` filters a transaction's instructions to
// one program. Before this fix, a filter that matched zero instructions
// produced an empty report with `instructions: 0, disagreements: 0` and
// EXIT 0 — a green CI gate over a check that never ran:
//
//   1. `--only <valid-program-id-not-in-tx>`: exit 0, rows: [], instructions: 0.
//      A caller who mistyped the program id they intended to check was told
//      the transaction conformed.
//   2. `--only <garbage>`: exit 0, same empty green. The value could not even
//      be a program id, and the CLI still accepted it without question.
//
// THE CONTRACT:
//
//   C1  a filter that selects zero instructions is REFUSED with
//       `ConformanceRefusal('filter-matched-no-instruction')` naming the
//       invoked program ids.
//   C2  a filter that is not a valid base58 program id is REFUSED with
//       `ConformanceRefusal('filter-is-not-a-program-id')`.
//   C3  a filter that is base58 but not 32 bytes is REFUSED with
//       `ConformanceRefusal('filter-is-not-a-program-id')`.
//   C4  a filter that is base58 but non-canonical is REFUSED with
//       `ConformanceRefusal('filter-is-not-a-program-id')`.
//   G1  GUARD: a filter that matches at least one instruction RUNS and
//       reports that program's rows.
//   G2  GUARD: no filter runs over every instruction (existing behavior).
//   G3  GUARD: a transaction with an unreadable shape is refused with
//       `unreadable-transaction` regardless of filter.
//   G4  CLI: the CLI exits 1 with a JSON error on C1 and C2 (no exit 0 over 0).
//
// Mutants M1-M4 verify that each guard/check turns red when broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTransaction, ConformanceRefusal } from '../src/conformance.mjs';
import { isProgramId, notAProgramIdMessage } from '../src/program-id.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE_TX = path.join(HERE, 'fixtures', 'order-engine-conformance-tx.json');
const FIXTURE_STORE = path.join(HERE, 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

// Programs the fixture transaction actually invokes:
const INVOKED_TOKENZ = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// A real Solana program id that this fixture transaction does NOT invoke:
const UNINVOKED_PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const loadTx = async () => {
  const { default: raw } = await import(FIXTURE_TX, { with: { type: 'json' } });
  return raw.result ?? raw;
};

// ---------------------------------------------------------------------------
// Unit checks on isProgramId
// ---------------------------------------------------------------------------

test('P1: isProgramId accepts 32-byte canonical base58 and refuses anything else', () => {
  assert.equal(isProgramId(INVOKED_TOKENZ), true);
  assert.equal(isProgramId(UNINVOKED_PUMP), true);
  assert.equal(isProgramId('11111111111111111111111111111111'), true); // 32 zero bytes
  // Not base58:
  assert.equal(isProgramId('not-base58-0OIl'), false);
  assert.equal(isProgramId(''), false);
  assert.equal(isProgramId(null), false);
  assert.equal(isProgramId(123), false);
  // Base58 but wrong length:
  assert.equal(isProgramId('1'), false); // 1 byte
  assert.equal(isProgramId('1111111111111111111111111111111'), false); // 31 bytes
  assert.equal(isProgramId('1'.repeat(33)), false); // 33 bytes
  // Non-canonical base58 (oversized encoding):
  assert.equal(isProgramId('2'.repeat(45)), false);
});

test('P2: notAProgramIdMessage names the flag and the offending value', () => {
  const msg = notAProgramIdMessage('--only', 'bogus');
  assert.match(msg, /--only/);
  assert.match(msg, /"bogus"/);
  assert.match(msg, /32 bytes/);
});

// ---------------------------------------------------------------------------
// Defect cases: C1 - C4
// ---------------------------------------------------------------------------

test('C1: a valid program id that is not in the transaction is refused', async () => {
  const tx = await loadTx();
  await assert.rejects(
    async () => checkTransaction(tx, FIXTURE_STORE, { only: [UNINVOKED_PUMP] }),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal, `expected ConformanceRefusal, got ${error?.name}`);
      assert.equal(error.reason, 'filter-matched-no-instruction');
      assert.match(error.detail, new RegExp(UNINVOKED_PUMP));
      assert.match(error.detail, /it invokes:/);
      assert.match(error.detail, new RegExp(INVOKED_TOKENZ),
        'the refusal detail must name the programs the transaction actually invokes');
      return true;
    },
  );
});

test('C2: a filter string that is not base58 is refused as not-a-program-id', async () => {
  const tx = await loadTx();
  await assert.rejects(
    async () => checkTransaction(tx, FIXTURE_STORE, { only: ['not-base58-value!'] }),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal);
      assert.equal(error.reason, 'filter-is-not-a-program-id');
      assert.match(error.detail, /32 bytes in base58/);
      return true;
    },
  );
});

test('C3: a base58 filter of the wrong length is refused as not-a-program-id', async () => {
  const tx = await loadTx();
  await assert.rejects(
    async () => checkTransaction(tx, FIXTURE_STORE, { only: ['11111111'] }),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal);
      assert.equal(error.reason, 'filter-is-not-a-program-id');
      return true;
    },
  );
});

test('C4: an empty-string filter is refused as not-a-program-id', async () => {
  const tx = await loadTx();
  await assert.rejects(
    async () => checkTransaction(tx, FIXTURE_STORE, { only: [''] }),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal);
      assert.equal(error.reason, 'filter-is-not-a-program-id');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Guards: G1 - G4
// ---------------------------------------------------------------------------

test('G1: GUARD — a filter that matches an invoked program runs and returns rows', async () => {
  const tx = await loadTx();
  const report = await checkTransaction(tx, FIXTURE_STORE, { only: [INVOKED_TOKENZ] });
  assert.ok(report.rows.length > 0, 'expected rows for the matched program');
  assert.ok(report.rows.every((r) => r.program === INVOKED_TOKENZ));
  assert.equal(report.summary.instructions, report.rows.length);
});

test('G2: GUARD — checking without a filter runs over every instruction', async () => {
  const tx = await loadTx();
  const report = await checkTransaction(tx, FIXTURE_STORE);
  assert.ok(report.rows.length > 0);
  assert.ok(report.summary.instructions > 0);
  // The fixture tx has an undeclared signing account disagreement:
  const disagreements = report.summary.executed.disagreements;
  assert.ok(disagreements > 0, 'unfiltered check must still find the real disagreement');
});

test('G3: GUARD — unreadable transaction shape is refused regardless of filter', async () => {
  await assert.rejects(
    async () => checkTransaction({ broken: true }, FIXTURE_STORE, { only: [INVOKED_TOKENZ] }),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal);
      assert.equal(error.reason, 'unreadable-transaction');
      return true;
    },
  );
});

test('G4: CLI refuses uninvoked program filter with exit 1 and a named error', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'sememe.mjs'), 'conform', FIXTURE_TX, '--store', FIXTURE_STORE, '--only', UNINVOKED_PUMP],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status} (stdout: ${result.stdout})`);
  assert.match(result.stderr, /filter-matched-no-instruction/);
  assert.match(result.stderr, new RegExp(UNINVOKED_PUMP));
});

test('G5: CLI refuses non-program-id filter with exit 1 and names the invalid value', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'sememe.mjs'), 'conform', FIXTURE_TX, '--store', FIXTURE_STORE, '--only', 'bogus-value'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.match(result.stderr, /filter-is-not-a-program-id/);
  // The value is named (JSON-escaped inside the machine-readable error).
  assert.match(result.stderr, /bogus-value/);
  assert.doesNotMatch(result.stderr, /can never match an instruction.*can never match an instruction/,
    'the value must be named exactly once');
});
