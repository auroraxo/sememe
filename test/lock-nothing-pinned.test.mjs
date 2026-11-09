// test/lock-nothing-pinned.test.mjs — A LOCK THAT PINS NOTHING MUST NOT BE
// WRITTEN, AND MUST NOT VERIFY GREEN
//
// THE DEFECT THIS PINS (measured 2026-11-09, this host, published v0.4.13
// install AND main f22dbf5 — the defect is in the delivery, not only in the
// tree):
//
// `sememe lock` / `sememe verify` is the CI surface the README tells a
// stranger to run after checkout ("Commit the file; CI then runs
// sememe verify"). Two faces of ONE defect made that gate able to pass
// without ever checking anything:
//
//   1. `sememe lock` on a store whose `receipts/` directory exists but holds
//      no receipt wrote `{"lockVersion":1,"programs":{}}` and exited 0.
//      Nothing is pinned, nothing can ever drift.
//   2. `sememe verify --mode error` against such a lock exited 0 with
//      `pinned: 0, violations: 0` — over the real 18-program fixture store.
//      Every program was reported as an `extra`, and extras are never
//      violations, so the report even LOOKED informative while certifying
//      nothing. `--mode warn` did the same.
//
// A gate that can never fail is the same class this repository has measured
// three times: `verify` green over a store the reader refuses (2026-11-07),
// `conform --only` green over a filter selecting nothing (2026-11-09, fixed
// in v0.4.13), and now `lock`/`verify` green over a lock pinning nothing.
//
// THE CONTRACT:
//
//   C1  (RED pre-fix) `writeLock` REFUSES a store with zero receipts with
//       `lock-pins-nothing`, and writes NO file.
//   C2  (RED pre-fix) the CLI `sememe lock` exits 1 with `lock-pins-nothing`
//       and writes no lock file (it exited 0 and wrote one).
//   C3  (RED pre-fix) `checkLock` REFUSES a lock document whose `programs`
//       map is empty with `lock-pins-nothing`, in `--mode error`.
//   C4  (RED pre-fix) the same refusal in `--mode warn`: an empty lock is a
//       defect of the DOCUMENT, not a violation of the store, so it is
//       refused regardless of mode (the same way `lock-v1-shape` is).
//   C5  (RED pre-fix) the CLI `sememe verify` exits 1 with
//       `lock-pins-nothing` over an empty lock against a REAL store (it
//       exited 0 with `violations: 0`).
//   C6  (GREEN pre-fix, must stay green) a store directory with no
//       `receipts/` at all is still refused as `no sememe store` — the two
//       refusals are different repairs and must not collapse into one
//       message when the new check is added.
//
//   G1  GUARD: locking a real two-program store still writes a lock pinning
//       both programs (the fix must not refuse the ordinary case).
//   G2  GUARD: `verify --mode error` over that lock on an intact store still
//       exits 0 with the pinned programs verified.
//   G3  GUARD: a lock with `lockVersion: 99` is still refused as a version
//       problem, not re-labelled `lock-pins-nothing` (the empty check runs
//       AFTER the version check).
//   G4  GUARD: `programs` of the wrong shape is still `lock-v1-shape`.
//   G5  GUARD: extras remain reported and never violations — the fix must
//       not move the documented "lock pins minimums" rule.
//
// Mutants M1-M5 (tools/mutation-ladder-lock-nothing-pinned.sh) verify that
// each check, each reason name and the mode coverage turn red when broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const whirlpoolIdl = JSON.parse(
  await readFile(new URL('./fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const jupiterIdl = JSON.parse(
  await readFile(new URL('./fixtures/jupiter-amm-v6-idl.json', import.meta.url), 'utf8'));

const { canonicalJson } = await import('../src/canonical.mjs');

/** Write one verified receipt+object pair, exactly as `sememe pull` would. */
async function putIdl(store, program, idl, slot, source) {
  const bytes = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(store, 'receipts', `${program}-${slot}-${source}-${fingerprint}.json`),
    JSON.stringify({ program, fingerprint: `sha256:${fingerprint}`, slot, source }));
}

/** A store directory structure with objects/receipts present, no receipts written. */
async function emptyStore() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-lock-empty-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  return store;
}

/** A real two-program store exactly as `sememe pull` writes it. */
async function twoProgramStore() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-lock-real-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  await putIdl(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
  await putIdl(store, JUPITER, jupiterIdl, 465104868, 'anchor');
  return store;
}

async function rmrf(dir) { await rm(dir, { recursive: true, force: true }); }

/** The hand-written empty lock — the shape a stale or forged lock has. */
async function writeEmptyLock(file) {
  await writeFile(file, `${JSON.stringify({ lockVersion: 1, programs: {} })}\n`);
}

const bin = (args, cwd) => spawnSync(process.execPath, [BIN, ...args],
  { cwd: cwd ?? ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// Defect cases: C1 - C6
// ---------------------------------------------------------------------------

test('C1: writeLock refuses a store with zero receipts with lock-pins-nothing, and writes NO file', async () => {
  const store = await emptyStore();
  const out = path.join(store, 'sememe.lock'); // inside the store dir: rmrf(store) removes both
  try {
    const { writeLock } = await import('../src/lock.mjs');
    await assert.rejects(
      () => writeLock(store, out),
      (error) => {
        assert.match(String(error.message), /lock-pins-nothing/,
          'the refusal must carry the stable reason name');
        assert.match(String(error.message), /pull/, 'the refusal must name the repair');
        return true;
      },
      'a lock pinning zero programs must not be written',
    );
    assert.equal(existsSync(out), false, 'no lock file may exist after the refusal');
  } finally { await rmrf(store); }
});

test('C2: the CLI sememe lock exits 1 over an empty store and writes no lock file', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'sememe-lock-cli-empty-'));
  const store = path.join(work, 'store');
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const out = path.join(work, 'sememe.lock');
  try {
    const result = bin(['lock', '--store', store, '--out', out], work);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /lock-pins-nothing/);
    assert.equal(existsSync(out), false, 'a refused lock must leave no file behind');
  } finally { await rmrf(work); }
});

test('C3: checkLock refuses a lock with an empty programs map — mode error', async () => {
  const store = await twoProgramStore();
  const lockPath = path.join(store, 'empty.lock');
  try {
    await writeEmptyLock(lockPath);
    const { checkLock } = await import('../src/lock.mjs');
    await assert.rejects(
      () => checkLock(store, lockPath, { mode: 'error' }),
      (error) => {
        assert.match(String(error.message), /lock-pins-nothing/);
        assert.match(String(error.message), /empty\.lock/, 'the refusal must name the file');
        return true;
      },
      'a lock that pins nothing must never certify a real store',
    );
  } finally { await rmrf(store); }
});

test('C4: checkLock refuses an empty lock in mode warn too — it is a document defect, not a store violation', async () => {
  const store = await twoProgramStore();
  const lockPath = path.join(store, 'empty-warn.lock');
  try {
    await writeEmptyLock(lockPath);
    const { checkLock } = await import('../src/lock.mjs');
    await assert.rejects(
      () => checkLock(store, lockPath, { mode: 'warn' }),
      (error) => {
        assert.match(String(error.message), /lock-pins-nothing/);
        return true;
      },
      'warn mode reports store violations; it must not certify a lock that pins nothing',
    );
  } finally { await rmrf(store); }
});

test('C5: the CLI sememe verify exits 1 over an empty lock against a real store', async () => {
  const store = await twoProgramStore();
  const lockPath = path.join(store, 'cli-empty.lock');
  try {
    await writeEmptyLock(lockPath);
    const result = bin(['verify', '--store', store, '--lock', lockPath, '--mode', 'error']);
    assert.equal(result.status, 1,
      `verify over an empty lock must exit 1 (green gate over a check that never ran); got ${result.status}: ${result.stdout}`);
    assert.match(result.stderr, /lock-pins-nothing/);
    // The old defect: violations 0, pinned 0, exit 0.
    if (result.stdout.trim().startsWith('{')) {
      const report = JSON.parse(result.stdout);
      assert.notEqual(report.violations, 0, 'no report may claim 0 violations for a lock that pins nothing');
    }
  } finally { await rmrf(store); }
});

test('C6: a store with NO receipts directory is still refused as no sememe store — the repairs differ', async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-lock-nostore-'));
  try {
    const { writeLock } = await import('../src/lock.mjs');
    await assert.rejects(
      () => writeLock(store, path.join(store, 'x.lock')),
      (error) => {
        assert.match(String(error.message), /no sememe store/);
        assert.doesNotMatch(String(error.message), /lock-pins-nothing/,
          'missing store and empty store are different refusals');
        return true;
      },
    );
  } finally { await rmrf(store); }
});

// ---------------------------------------------------------------------------
// Guards: G1 - G5
// ---------------------------------------------------------------------------

test('G1: GUARD — locking a real two-program store still writes a lock pinning both', async () => {
  const store = await twoProgramStore();
  const lockPath = path.join(store, 'sememe.lock');
  try {
    const { writeLock } = await import('../src/lock.mjs');
    const doc = await writeLock(store, lockPath);
    assert.equal(Object.keys(doc.programs).length, 2, 'the ordinary case must keep working');
    assert.ok(existsSync(lockPath), 'the ordinary lock must still be written');
  } finally { await rmrf(store); }
});

test('G2: GUARD — verify --mode error over a real lock on an intact store still exits 0', async () => {
  const store = await twoProgramStore();
  const lockPath = path.join(store, 'guard.lock');
  try {
    const { writeLock, checkLock } = await import('../src/lock.mjs');
    await writeLock(store, lockPath);
    const report = await checkLock(store, lockPath, { mode: 'error' });
    assert.equal(report.violations, 0);
    assert.equal(report.pinned, 2);
    assert.deepEqual([...report.verified].sort(), [JUPITER, WHIRLPOOL].sort());
  } finally { await rmrf(store); }
});

test('G3: GUARD — an unsupported lockVersion is still refused as a version problem', async () => {
  const store = await twoProgramStore();
  const lockPath = path.join(store, 'v99.lock');
  try {
    await writeFile(lockPath, JSON.stringify({ lockVersion: 99, programs: {} }));
    const { checkLock } = await import('../src/lock.mjs');
    await assert.rejects(
      () => checkLock(store, lockPath, { mode: 'error' }),
      (error) => {
        assert.match(String(error.message), /lockVersion/);
        assert.doesNotMatch(String(error.message), /lock-pins-nothing/,
          'the empty check runs after the version check, not instead of it');
        return true;
      },
    );
  } finally { await rmrf(store); }
});

test('G4: GUARD — programs of the wrong shape is still lock-v1-shape', async () => {
  const store = await twoProgramStore();
  const lockPath = path.join(store, 'shape.lock');
  try {
    await writeFile(lockPath, JSON.stringify({ lockVersion: 1, programs: 'not-an-object' }));
    const { checkLock } = await import('../src/lock.mjs');
    await assert.rejects(
      () => checkLock(store, lockPath, { mode: 'error' }),
      (error) => {
        assert.match(String(error.message), /programs/);
        assert.doesNotMatch(String(error.message), /lock-pins-nothing/);
        return true;
      },
    );
  } finally { await rmrf(store); }
});

test('G5: GUARD — extras stay reported and never violations for being there', async () => {
  const store = await twoProgramStore();
  const lockPath = path.join(store, 'one.lock');
  try {
    const { writeLock, checkLock } = await import('../src/lock.mjs');
    const full = await writeLock(store, path.join(store, 'full.lock'));
    // Pin ONLY whirlpool: jupiter becomes an extra.
    await writeFile(lockPath, `${JSON.stringify({ lockVersion: 1, programs: { [WHIRLPOOL]: full.programs[WHIRLPOOL] } })}\n`);
    const report = await checkLock(store, lockPath, { mode: 'error' });
    assert.equal(report.violations, 0, 'an extra program must never be a violation for being there');
    assert.deepEqual(report.extra, [JUPITER]);
    assert.equal(report.pinned, 1);
  } finally { await rmrf(store); }
});

test('G6: GUARD — the full CLI journey (lock then verify on a real store) still exits 0', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'sememe-lock-journey-'));
  const store = path.join(work, 'store');
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  await putIdl(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
  await putIdl(store, JUPITER, jupiterIdl, 465104868, 'anchor');
  try {
    const lock = bin(['lock', '--store', store, '--out', path.join(work, 'sememe.lock')], work);
    assert.equal(lock.status, 0, `documented lock must still run: ${lock.stderr}`);
    const verify = bin(['verify', '--store', store, '--lock', path.join(work, 'sememe.lock')], work);
    assert.equal(verify.status, 0, `documented verify must still run: ${verify.stderr}`);
    const report = JSON.parse(verify.stdout);
    assert.equal(report.pinned, 2);
    assert.equal(report.violations, 0);
  } finally { await rmrf(work); }
});
