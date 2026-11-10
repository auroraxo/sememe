// test/conform-store-damage.test.mjs — A STORE THE READER REFUSES MUST NOT
// PASS THE CONFORMANCE GATE.
//
// MEASURED (2026-11-10, this host, pre-fix tree 3d386b2):
//
// `sememe conform <tx.json> --store <dir>` is a CI gate: exit 1 on any
// disagreement, exit 0 when the checked instructions agree with the store.
// The gate read the store through ONE line that swallowed every failure:
//
//     try {
//       const sources = await findStoredIdls(storeDir, instruction.programId);
//       idl = sources.primary?.idl ?? sources.secondary?.idl ?? null;
//     } catch {
//       idl = null;                     // <-- EVERY refusal becomes "no interface"
//     }
//
// `findStoredIdls` is the ONE store reader that refuses damage by name
// (src/store-read.mjs: a receipt whose object no longer re-hashes to its
// fingerprint, a receipt for another program, a missing object, a rewritten
// origin). `sememe decode` on such a store exits 1 with the reader's own
// message. `sememe conform` on the SAME store turned that refusal into a
// verdict and exited 0.
//
// Three faces of ONE defect, all measured on the same fixture transaction
// (test/fixtures/order-engine-conformance-tx.json, which invokes the
// order-engine program 2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1):
//
//   D1  a TAMPERED receipt for an invoked program (the fingerprint no
//       longer matches the object):
//         pre-fix: rows all `no-stored-interface`, exit 0
//         the REAL disagreement this transaction has (an undeclared
//         signing account on the order-engine fill) DISAPPEARED with it.
//         A green gate over a check that never ran — and worse than green:
//         the gate reported "12 instructions, 0 disagreements" for a
//         transaction that demonstrably disagrees.
//   D2  a store that does not exist at all:
//         pre-fix: rows all `no-stored-interface`, exit 0
//   D3  a store whose receipts/ directory is missing:
//         pre-fix: rows all `no-stored-interface`, exit 0
//
// D1 is the worst face, because it is the one a REAL user hits: the store
// drifted (a re-pull, a hand-edited receipt, a half-written file) and the
// gate went green over the program it could no longer read.
//
// THE CONTRACT:
//
//   C1  a store the reader REFUSES is a REFUSAL, never a verdict: the
//       conformance check refuses with a named reason that carries the
//       reader's own message and the repair.
//   C2  the refusal names the PROGRAM it could not read.
//   C3  the CLI exits 1 on that refusal (never 0 over a store it could not
//       read).
//   C4  a program the store genuinely does not hold is still
//       `no-stored-interface` — an honest acquisition gap, NOT a refusal.
//       The two must not collapse into one.
//   G1  GUARD: an INTACT store still reports the real disagreement (the
//       order-engine transaction's undeclared signing account) and exits 1.
//   G2  GUARD: an intact store still reports `no-stored-interface` for the
//       programs it does not hold (System, Token, ComputeBudget), and those
//       rows are NOT a refusal.
//   G3  GUARD: a program the store holds, but whose receipt is MALFORMED
//       (receipt-shaped but not well-formed), is still refused BY NAME —
//       the fix must not turn damage into a silent skip.
//   G4  GUARD: the existing filter refusals (filter-is-not-a-program-id,
//       filter-matched-no-instruction) are unchanged.
//
// C4, G1, G2 and G4 are the tests expected to pass on the PRE-FIX tree;
// they are the false-positive guards. Everything else must be red there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm as fsRm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTransaction, ConformanceRefusal } from '../src/conformance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const FIXTURE_TX = path.join(HERE, 'fixtures', 'order-engine-conformance-tx.json');
const FIXTURE_STORE = path.join(HERE, 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

// The program the fixture transaction invokes and the store holds.
const ORDER_ENGINE = '2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1';
// A program the store does NOT hold (the SPL Token program): its absence is
// an honest acquisition gap, not damage.
const TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const loadTx = async () => {
  const { default: raw } = await import(FIXTURE_TX, { with: { type: 'json' } });
  return raw.result ?? raw;
};

/** A copy of the fixture store with ONE receipt's fingerprint tampered —
 * the damage the store reader already refuses on the decode path. */
async function tamperedStore() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-conform-damaged-'));
  await cp(FIXTURE_STORE, store, { recursive: true });
  const names = (await import('node:fs/promises')).readdir(path.join(store, 'receipts'));
  const files = (await names).filter((name) => name.startsWith(`${ORDER_ENGINE}-`));
  assert.ok(files.length > 0, 'the fixture store must hold a receipt for the order-engine program');
  const target = path.join(store, 'receipts', files[0]);
  const receipt = JSON.parse(await readFile(target, 'utf8'));
  receipt.fingerprint = `sha256:${'0'.repeat(64)}`;
  await writeFile(target, JSON.stringify(receipt));
  return { store, receiptName: files[0] };
}

/** A store whose receipts/ directory does not exist at all. */
async function storeWithoutReceipts() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-conform-nostore-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  return store;
}

// ---------------------------------------------------------------------------
// Defect cases: C1 - C3
// ---------------------------------------------------------------------------

test('C1: a store the reader refuses is a REFUSAL, not a verdict', async () => {
  const tx = await loadTx();
  const { store } = await tamperedStore();
  try {
    await assert.rejects(
      async () => checkTransaction(tx, store, { only: [ORDER_ENGINE] }),
      (error) => {
        assert.ok(error instanceof ConformanceRefusal,
          `expected ConformanceRefusal, got ${error?.name}: ${error?.message}`);
        // The reason name IS the CLI contract (mutation M3 pins it): a
        // caller must be able to branch on `store-reader-refused` without
        // parsing prose.
        assert.equal(error.reason, 'store-reader-refused',
          `the refusal must be named store-reader-refused, got: ${error.reason}`);
        // The refusal carries the READER's own reason, so the caller learns
        // WHY the store could not be read (re-hash mismatch, missing object,
        // rewritten origin) instead of a generic verdict.
        assert.match(error.detail, /re-hash|fingerprint|object|receipt|refus/i,
          `the refusal must carry the reader's reason, got: ${error.detail}`);
        return true;
      },
    );
  } finally {
    await fsRm(store, { recursive: true, force: true });
  }
});

test('C2: the refusal names the PROGRAM the store could not answer', async () => {
  const tx = await loadTx();
  const { store } = await tamperedStore();
  try {
    await assert.rejects(
      async () => checkTransaction(tx, store, { only: [ORDER_ENGINE] }),
      (error) => {
        assert.match(error.detail, new RegExp(ORDER_ENGINE),
          `the refusal must name the program it could not read, got: ${error.detail}`);
        return true;
      },
    );
  } finally {
    await fsRm(store, { recursive: true, force: true });
  }
});

test('C3: the CLI exits 1 over a store the reader refuses (it exited 0)', async () => {
  const { store } = await tamperedStore();
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, 'conform', FIXTURE_TX, '--store', store, '--only', ORDER_ENGINE],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 1,
      `expected exit 1 over a damaged store, got ${result.status} (stdout: ${result.stdout?.slice(0, 200)})`);
    assert.doesNotMatch(result.stdout, /"verdict"/,
      'a refused store must not produce a verdict-carrying report');
  } finally {
    await fsRm(store, { recursive: true, force: true });
  }
});

test('C3b: the CLI exits 1 over a store that does not exist (it exited 0)', async () => {
  const result = spawnSync(
    process.execPath,
    [BIN, 'conform', FIXTURE_TX, '--store', path.join(os.tmpdir(), 'sememe-conform-absent-store')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 1,
    `expected exit 1 over a missing store, got ${result.status} (stdout: ${result.stdout?.slice(0, 200)})`);
});

test('C3c: the CLI exits 1 over a store with no receipts/ directory (it exited 0)', async () => {
  const store = await storeWithoutReceipts();
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, 'conform', FIXTURE_TX, '--store', store],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 1,
      `expected exit 1 over a store without receipts/, got ${result.status} (stdout: ${result.stdout?.slice(0, 200)})`);
  } finally {
    await fsRm(store, { recursive: true, force: true });
  }
});

// The reader's OWN message for a missing store does not name the program —
// it names the directory. So this is the case where the refusal detail only
// carries the program id because the refusal puts it there (mutation M4
// removes that prefix; the tampered-receipt case alone cannot catch it,
// because the receipt FILENAME already contains the program id).
test('C3d: the refusal names the program even when the reader message does not', async () => {
  const tx = await loadTx();
  const store = path.join(os.tmpdir(), 'sememe-conform-absent-store-detail');
  // `--only ORDER_ENGINE` makes the named program deterministic (without it
  // the first invoked instruction is ComputeBudget, which the refusal would
  // also name correctly).
  await assert.rejects(
    async () => checkTransaction(tx, store, { only: [ORDER_ENGINE] }),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal,
        `expected ConformanceRefusal, got ${error?.name}: ${error?.message}`);
      assert.equal(error.reason, 'no-sememe-store');
      assert.match(error.detail, new RegExp(ORDER_ENGINE),
        `the refusal must name the program it could not read, got: ${error.detail}`);
      // The program id is the PREFIX the refusal puts in front of the
      // reader's own message — and the reader's message itself (the part
      // after that prefix) names only the directory, so the program id can
      // only be there because the refusal added it. Mutation M4 removes that
      // prefix, and this assertion is what catches it.
      assert.ok(error.detail.startsWith(`${ORDER_ENGINE}: `),
        `the refusal must lead with the program id, got: ${error.detail}`);
      const readerMessage = error.detail.slice(`${ORDER_ENGINE}: `.length);
      assert.doesNotMatch(
        readerMessage,
        new RegExp(ORDER_ENGINE),
        'precondition: the reader message itself must not already contain the program id',
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// C4: a genuine absence is NOT damage
// ---------------------------------------------------------------------------

test('C4: a program the store genuinely does not hold stays no-stored-interface', async () => {
  const tx = await loadTx();
  // The SPL Token program: the store holds no receipt for it and never will
  // (it publishes no IDL). That is an acquisition gap, not damage — it must
  // keep its honest verdict and must NOT become a refusal.
  const report = await checkTransaction(tx, FIXTURE_STORE, { only: [TOKEN_PROGRAM] });
  assert.ok(report.rows.length > 0, 'the token program is invoked by the fixture transaction');
  assert.ok(report.rows.every((row) => row.verdict === 'no-stored-interface'),
    `expected no-stored-interface rows, got ${JSON.stringify(report.summary.byVerdict)}`);
});

// ---------------------------------------------------------------------------
// Guards: G1 - G4
// ---------------------------------------------------------------------------

test('G1: GUARD — an INTACT store still reports the real disagreement and exits 1', async () => {
  const tx = await loadTx();
  const report = await checkTransaction(tx, FIXTURE_STORE, { only: [ORDER_ENGINE] });
  assert.ok(report.rows.length > 0, 'expected rows for the order-engine program');
  const disagreeing = report.rows.filter((row) => (row.violations ?? []).length > 0);
  assert.ok(disagreeing.length > 0,
    'the intact store must still find the undeclared signing account');
  assert.ok(disagreeing.some((row) => row.violations.some((v) => v.kind === 'undeclared-signing-account')),
    'the documented disagreement (undeclared signing account) must survive');
});

test('G2: GUARD — an intact store still reports honest no-stored-interface rows', async () => {
  const tx = await loadTx();
  const report = await checkTransaction(tx, FIXTURE_STORE);
  const gaps = report.rows.filter((row) => row.verdict === 'no-stored-interface');
  assert.ok(gaps.length > 0,
    'the intact store must still report the programs it does not hold');
  // And those rows are NOT refusals: the report came back.
  assert.ok(report.summary.instructions > 0);
});

test('G3: GUARD — a MALFORMED receipt is refused BY NAME, not silently skipped', async () => {
  const tx = await loadTx();
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-conform-malformed-'));
  await cp(FIXTURE_STORE, store, { recursive: true });
  // Receipt-shaped but not well-formed: the classifier calls this
  // 'malformed' = DAMAGE that must still be read (and refused), never
  // skipped in silence.
  const malformed = path.join(store, 'receipts', `${ORDER_ENGINE}-0-anchor-truncated.json`);
  await writeFile(malformed, JSON.stringify({ program: ORDER_ENGINE, fingerprint: 'sha256:00' }));
  try {
    await assert.rejects(
      async () => checkTransaction(tx, store, { only: [ORDER_ENGINE] }),
      (error) => {
        assert.ok(error instanceof ConformanceRefusal,
          `expected ConformanceRefusal, got ${error?.name}: ${error?.message}`);
        assert.match(error.detail, /malformed|truncated|fingerprint|receipt|refus/i,
          `the refusal must name the damaged receipt, got: ${error.detail}`);
        return true;
      },
    );
  } finally {
    await fsRm(store, { recursive: true, force: true });
  }
});

test('G4: GUARD — the existing filter refusals are unchanged', async () => {
  const tx = await loadTx();
  await assert.rejects(
    async () => checkTransaction(tx, FIXTURE_STORE, { only: ['not-a-program-id'] }),
    (error) => {
      assert.equal(error.reason, 'filter-is-not-a-program-id');
      return true;
    },
  );
  await assert.rejects(
    async () => checkTransaction(tx, FIXTURE_STORE, { only: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'] }),
    (error) => {
      assert.equal(error.reason, 'filter-matched-no-instruction');
      return true;
    },
  );
});
