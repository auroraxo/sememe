// The EXTRA-program damage ladder: `sememe verify` must not call a store clean
// when the store reader refuses part of it — even when the damaged program is
// not pinned by the lock.
//
// MEASURED (2026-11-07, this host, pre-fix tree 61df87b):
//
//   store  = Whirlpool (pinned by sememe.lock) + Jupiter pulled LATER
//            -> Jupiter is an EXTRA: the lock pins minimums, not equality.
//   damage = Jupiter's object rewritten so it no longer re-hashes to the
//            fingerprint its receipt claims. The store reader refuses it:
//            `sememe decode <jupiter> …` exits 1 ("object and receipt
//            disagree, refusing to decode").
//
//     sememe lock   over that store -> EXIT 1, no lock written
//                    (writeLock re-checks EVERY receipt, extras included)
//     sememe verify over that store -> EXIT 0, violations 0, extra: [jupiter]
//                    (checkLock only ever re-checked PINNED programs)
//
// Two commands, two verdicts about the SAME store — the exact class this repo
// killed for pinned copies on 2026-11-07 ("writeLock and checkLock share ONE
// helper, so lock and verify cannot disagree about what a clean store is").
// That promise held for pinned programs and stopped holding one level down:
// the helper was shared but only ever CALLED for pinned programs. The result
// was a green CI gate over a store one of whose programs the reader refuses —
// the gate the README tells a stranger to run after checkout.
//
// LADDER (written FIRST, against 61df87b):
//   G1 (guard, GREEN pre-fix) an INTACT extra is reported and is NOT a
//      violation — the documented "lock pins minimums, not store equality"
//      rule must survive the fix.
//   G2 (guard, GREEN pre-fix) a damaged PINNED program is still named
//      `unverified` — the fix must not move that case.
//   T1 (RED pre-fix) a damaged EXTRA is named `unverified` with scope
//      `extra`, and error mode THROWS.
//   T2 (RED pre-fix) the CLI `sememe verify --mode error` exits 1 over that
//      store (it exited 0).
//   T3 (RED pre-fix) lock and verify AGREE: the same store that writeLock
//      refuses is a store checkLock reports as violating, in both modes.
//   T4 (RED pre-fix) warn mode counts the damaged extra as a violation
//      without throwing — the count is the contract, not the throw.
//
// G1 and G2 are the two tests expected to pass on the pre-fix tree; they are
// the false-positive guards. Everything else must be red there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm as fsRm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const whirlpoolIdl = JSON.parse(await readFile(new URL('./fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const jupiterIdl = JSON.parse(await readFile(new URL('./fixtures/jupiter-amm-v6-idl.json', import.meta.url), 'utf8'));
const { canonicalJson } = await import('../src/canonical.mjs');
const { writeLock, checkLock } = await import('../src/lock.mjs');

/** Write one verified receipt+object pair, exactly as `sememe pull` writes. */
async function putIdl(store, program, idl, slot, source) {
  const bytes = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(store, 'receipts', `${program}-${slot}-${source}-${fingerprint}.json`),
    JSON.stringify({ program, fingerprint: `sha256:${fingerprint}`, slot, source }));
  return fingerprint;
}

/**
 * A store whose lock pins Whirlpool only, plus Jupiter as an EXTRA.
 * `damageExtra` rewrites Jupiter's object so it no longer re-hashes — the
 * same damage the store reader already refuses on decode.
 */
async function storeWithExtra({ damageExtra }) {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-extra-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const lockPath = path.join(store, 'sememe.lock');
  await putIdl(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
  // Lock FIRST: only Whirlpool is pinned, exactly as in a project that pulls
  // another program after committing its lock.
  await writeLock(store, lockPath);
  const jupiterFingerprint = await putIdl(store, JUPITER, jupiterIdl, 465104868, 'anchor');
  if (damageExtra) {
    await writeFile(path.join(store, 'objects', `${jupiterFingerprint}.json`), '{"instructions":[]}\n');
  }
  return { store, lockPath, jupiterFingerprint };
}

const runCli = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });

// ------------------------------------------------------------------- guards

test('G1 (guard): an INTACT extra is reported, never a violation — lock pins minimums, not store equality', async () => {
  const { store, lockPath } = await storeWithExtra({ damageExtra: false });
  try {
    const report = await checkLock(store, lockPath, { mode: 'error' });
    assert.deepEqual(report.extra, [JUPITER], 'the extra program must be reported');
    assert.equal(report.violations, 0, 'an intact extra must NOT be a violation (documented contract)');
    assert.deepEqual(report.unverified, [], 'nothing in an intact store is unverified');
    assert.deepEqual(report.verified, [WHIRLPOOL], 'the pinned program still verifies');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('G2 (guard): a damaged PINNED program is still named unverified, not silently accepted', async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-pinned-damage-'));
  try {
    await mkdir(path.join(store, 'objects'), { recursive: true });
    await mkdir(path.join(store, 'receipts'), { recursive: true });
    const lockPath = path.join(store, 'sememe.lock');
    const fingerprint = await putIdl(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
    await writeLock(store, lockPath);
    await writeFile(path.join(store, 'objects', `${fingerprint}.json`), '{"instructions":[]}\n');

    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.unverified.length, 1, 'the damaged pinned program must be named');
    assert.equal(report.unverified[0].program, WHIRLPOOL);
    assert.match(report.unverified[0].reason, /re-hashes to sha256:[a-f0-9]{64}/,
      'the reason must carry the store reader\'s own re-hash refusal');
    assert.ok(report.violations >= 1, 'a damaged pinned program is a violation');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ reds

test('T1: a damaged EXTRA is named unverified with scope extra, and error mode throws', async () => {
  const { store, lockPath } = await storeWithExtra({ damageExtra: true });
  try {
    await assert.rejects(
      () => checkLock(store, lockPath, { mode: 'error' }),
      (error) => {
        assert.match(error.message, new RegExp(JUPITER),
          'the refusal must NAME the damaged extra program');
        assert.match(error.message, /unverified/,
          'the refusal must name the violation kind the repairer needs');
        return true;
      },
      'verify must refuse a store the store reader refuses (it exited 0 before the fix)',
    );

    const report = await checkLock(store, lockPath, { mode: 'warn' });
    const entry = report.unverified.find((u) => u.program === JUPITER);
    assert.ok(entry, `the damaged extra must appear in unverified, got ${JSON.stringify(report.unverified)}`);
    assert.equal(entry.scope, 'extra',
      'the report must say the damage is in an UNPINNED program, so it is not read as pin drift');
    assert.match(entry.reason, /re-hashes to sha256:[a-f0-9]{64}/,
      'the reason must carry the store reader\'s own re-hash refusal');
    assert.equal(report.extra.includes(JUPITER), true,
      'the program stays reported as extra: presence is still not the violation, damage is');
    assert.equal(report.violations >= 1, true, 'the damaged extra must count toward violations');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('T2: the CLI sememe verify --mode error exits 1 over that store (it exited 0 before the fix)', () => {
  const { store, lockPath, jupiterFingerprint } = storeWithExtraSync(true);
  try {
    const result = runCli(['verify', '--store', store, '--lock', lockPath, '--mode', 'error']);
    assert.equal(result.status, 1,
      `the CI gate must exit 1 over a store the reader refuses; got status ${result.status}\n`
      + `stdout: ${String(result.stdout).slice(0, 400)}\nstderr: ${String(result.stderr).slice(0, 400)}`);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.ok(combined.includes(JUPITER), 'the CLI output must name the damaged program');
    assert.ok(combined.includes(jupiterFingerprint),
      'the CLI output must carry the fingerprint the receipt claims');
  } finally { fsRmSync(store, { recursive: true, force: true }); }
});

test('T3: lock and verify AGREE — the store writeLock refuses is the store checkLock reports as violating', async () => {
  const { store, lockPath } = await storeWithExtra({ damageExtra: true });
  try {
    // The writer's verdict: a store the reader refuses produces NO lock.
    let lockError = null;
    try { await writeLock(store, path.join(store, 'second.lock')); }
    catch (error) { lockError = String(error.message); }
    assert.ok(lockError, 'writeLock must refuse to write a lock over this store');
    assert.match(lockError, new RegExp(JUPITER), 'writeLock must name the damaged program');

    // The checker's verdict on the SAME store: it must not be clean.
    const warn = await checkLock(store, lockPath, { mode: 'warn' });
    assert.ok(warn.violations >= 1,
      `checkLock and writeLock must agree the store is damaged; got violations ${warn.violations}`);
    await assert.rejects(() => checkLock(store, lockPath, { mode: 'error' }),
      'error mode must throw for the store writeLock refuses');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('T4: warn mode counts the damaged extra as a violation without throwing', async () => {
  const { store, lockPath } = await storeWithExtra({ damageExtra: true });
  try {
    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.mode, 'warn');
    assert.ok(report.violations >= 1, 'warn mode must still COUNT it — the count is the contract');
    assert.equal(report.unverified.some((u) => u.program === JUPITER && u.scope === 'extra'), true,
      'warn mode must name it, with its scope');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

// ---- CLI fixture built synchronously so T2 can be a plain (sync) test ----
function storeWithExtraSync(damageExtra) {
  const store = mkdtempSyncSafe();
  const lockPath = path.join(store, 'sememe.lock');
  putIdlSync(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
  writeLockSyncSafe(store, lockPath);
  const jupiterFingerprint = putIdlSync(store, JUPITER, jupiterIdl, 465104868, 'anchor');
  if (damageExtra) {
    writeFileSyncSafe(path.join(store, 'objects', `${jupiterFingerprint}.json`), '{"instructions":[]}\n');
  }
  return { store, lockPath, jupiterFingerprint };
}

// Synchronous wrappers: node:test runs async tests fine, but T2 needs the
// fixture before spawnSync and a sync fixture keeps the ordering obvious.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
function mkdtempSyncSafe() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sememe-extra-cli-'));
  mkdirSync(path.join(dir, 'objects'), { recursive: true });
  mkdirSync(path.join(dir, 'receipts'), { recursive: true });
  return dir;
}
function putIdlSync(store, program, idl, slot, source) {
  const bytes = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  writeFileSync(
    path.join(store, 'receipts', `${program}-${slot}-${source}-${fingerprint}.json`),
    JSON.stringify({ program, fingerprint: `sha256:${fingerprint}`, slot, source }));
  return fingerprint;
}
function writeFileSyncSafe(file, data) { writeFileSync(file, data); }
function writeLockSyncSafe(store, lockPath) {
  // writeLock is async; T2 is sync, so write the lock through the CLI instead —
  // that is also the command a stranger runs.
  const result = spawnSync(process.execPath, [BIN, 'lock', '--store', store, '--out', lockPath],
    { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw Error(`lock failed: ${result.stderr || result.stdout}`);
}
function fsRmSync(target) { rmSync(target, { recursive: true, force: true }); }

void readdir; void readFile;

// ---------------------------------------------------------------------------
// MUTATIONS — each must turn a test above red.
//
// The mutant is written INTO src/ under a dot-prefixed name (so its relative
// imports resolve against the real tree) and deleted afterwards; the real
// modules are never modified. Pattern matches test/multi-copy-store.test.mjs.
//
//   X1  do not re-check EXTRA programs at all (the pre-fix rule: the shared
//       helper existed but only the PINNED loop ever called it): a damaged
//       extra is skipped in silence.
//       -> T1/T3 red (verify calls a store clean that the writer refuses).
//   X2  report the extra damage but do not COUNT it: the store is named and
//       the gate stays green — the "reported but not a violation" shape that
//       made the legacy unbound-origin case a green lie.
//       -> T3/T4 red (violations stays 0).
//   X3  check the extras but drop the `scope` marker, so a repairer cannot
//       tell pin drift from damage in an unpinned program.
//       -> T1 red (the report must say WHICH side is damaged).
// ---------------------------------------------------------------------------

async function withMutant(name, mutate) {
  const source = await readFile(path.join(ROOT, 'src', 'lock.mjs'), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${name}: the mutation must actually change the source`);
  const mutantPath = path.join(ROOT, 'src', `.${name}-mutant.mjs`);
  try {
    await writeFile(mutantPath, mutated);
    return await import(mutantPath);
  } finally {
    await fsRm(mutantPath, { force: true });
  }
}

test('MUTATION X1 (do not re-check extra programs) turns T1 and T3 red', async () => {
  const mutant = await withMutant('x1-no-extra-check', (source) => source.replace(
    '  for (const program of report.extra) {\n    const candidates = validReceipts.filter((name) => name.startsWith(`${program}-`));',
    '  for (const program of []) {\n    const candidates = validReceipts.filter((name) => name.startsWith(`${program}-`));',
  ));
  const { store, lockPath } = await storeWithExtra({ damageExtra: true });
  try {
    const report = await mutant.checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.violations, 0,
      'the mutant must report a CLEAN store over a damaged one — otherwise T1/T3 pin nothing');
    assert.equal(report.unverified.length, 0,
      'the mutant must name no damaged receipt');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('MUTATION X2 (report the extra damage but do not count it) turns T3 and T4 red', async () => {
  const mutant = await withMutant('x2-uncounted-extra', (source) => source.replace(
    '  const violations = report.drifted.length + report.missing.length\n    + report.unverified.length + report.relabelled.length + report.unbound.length;',
    '  const violations = report.drifted.length + report.missing.length\n    + report.relabelled.length + report.unbound.length;',
  ));
  const { store, lockPath } = await storeWithExtra({ damageExtra: true });
  try {
    const report = await mutant.checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.unverified.length, 1,
      'the mutant must still NAME the damaged receipt — it only stops counting it');
    assert.equal(report.violations, 0,
      'the mutant must leave the gate green over damage — otherwise T3/T4 pin nothing');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('MUTATION X3 (drop the scope marker) turns T1 red', async () => {
  const mutant = await withMutant('x3-no-scope', (source) => source.replace(
    "      scope: 'extra',\n    };",
    "      scope: 'pinned',\n    };",
  ));
  const { store, lockPath } = await storeWithExtra({ damageExtra: true });
  try {
    const report = await mutant.checkLock(store, lockPath, { mode: 'warn' });
    const entry = report.unverified.find((u) => u.program === JUPITER);
    assert.ok(entry, 'the mutant must still find the damaged extra');
    assert.notEqual(entry.scope, 'extra',
      'the mutant must lose the scope marker — otherwise T1 pins nothing');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});
