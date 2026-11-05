// sememe.lock — the fingerprint lockfile.
//
// The README has promised this file since the idea section was written
// ("store: keep records under ~/.sememe/; `sememe.lock` pins exact
// fingerprints per project") while the Status line still called lockfiles a
// proposal and no implementation existed. A stranger who read the contract and
// looked for the tool found nothing — the same "the surface promises, the
// tree does not answer" class measured three times before (Signerd.connect,
// Tag-README journeys, peer-refusal claim).
//
// v0 contract, pinned here:
//   - `sememe lock [--store dir] [--out file]` snapshots every verified
//     receipt of a store into a `sememe.lock` document: per program the exact
//     fingerprint it answered with, plus source/slot/receipt provenance.
//   - `sememe verify [--lock file] [--store dir] [--mode warn|error]`
//     re-checks the store against the pin and refuses drift BY NAME:
//       drifted    the store answers the program with a DIFFERENT fingerprint
//       missing    the store has nothing for a pinned program
//       unverified a pinned object fails the store reader's own re-hash check
//     extra store programs are reported, never a violation (the lock pins
//     minimums, not store equality).
//   - `--mode error` (verify's default) exits 1 on any violation — the CI
//     gate behaviour; `--mode warn` reports and exits 0.
//   - The document itself is JSON with `lockVersion: 1`; anything else is
//     refused with a named reason, never guessed around.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const whirlpoolIdl = JSON.parse(
  await readFile(new URL('./fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const jupiterIdl = JSON.parse(
  await readFile(new URL('./fixtures/jupiter-amm-v6-idl.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(
  await readFile(new URL('./fixtures/mainnet-whirlpool.json', import.meta.url), 'utf8'));
const swapV2 = fixture.records.find((record) => record.name === 'swap_v2');
assert.ok(swapV2, 'fixture payload must map to a named instruction');

const { canonicalJson } = await import('../src/canonical.mjs');

/** Write one verified receipt+object pair, exactly as `sememe pull` would. */
async function putIdl(store, program, idl, slot, source) {
  const bytes = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(store, 'receipts', `${program}-${slot}-${source}-${fingerprint}.json`),
    JSON.stringify({ program, fingerprint: `sha256:${fingerprint}`, slot, source }));
  return { fingerprint, bytes };
}

/** A two-program store exactly as `sememe pull` writes it. */
async function twoProgramStore() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-lock-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const whirlpool = await putIdl(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
  const jupiter = await putIdl(store, JUPITER, jupiterIdl, 465104868, 'anchor');
  return { store, fingerprints: { [WHIRLPOOL]: whirlpool.fingerprint, [JUPITER]: jupiter.fingerprint } };
}

async function rmrf(dir) { await rm(dir, { recursive: true, force: true }); }

test('the control: an intact store plus the lock written from it verifies clean', async () => {
  const { store } = await twoProgramStore();
  const lockPath = path.join(store, '..', `sememe-lock-control-${Date.now()}.json`);
  try {
    const { writeLock, checkLock } = await import('../src/lock.mjs');
    const doc = await writeLock(store, lockPath);
    assert.equal(doc.lockVersion, 1);
    assert.equal(doc.programs[WHIRLPOOL].fingerprint, `sha256:${doc.programs[WHIRLPOOL].fingerprint.slice(7)}`);
    assert.match(doc.programs[WHIRLPOOL].fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(doc.programs[WHIRLPOOL].slot, 462039125);
    assert.equal(doc.programs[JUPITER].slot, 465104868);
    assert.equal(Object.keys(doc.programs).length, 2, 'the lock must carry both programs');

    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.pinned, 2);
    assert.equal(report.verified.length, 2);
    assert.deepEqual(report.drifted, [], 'an intact store must not drift');
    assert.deepEqual(report.missing, [], 'an intact store must not miss');
    assert.deepEqual(report.unverified, [], 'an intact store must be re-hashable');
    assert.deepEqual(report.extra, [], 'a store written by the same run has no extras');
  } finally { await rmrf(store); await rm(lockPath, { force: true }); }
});

test('the lock document is deterministic: same store, byte-identical lock', async () => {
  const { store } = await twoProgramStore();
  const a = path.join(store, 'lock-a.json');
  const b = path.join(store, 'lock-b.json');
  try {
    const { writeLock } = await import('../src/lock.mjs');
    await writeLock(store, a);
    await writeLock(store, b);
    assert.equal(await readFile(a, 'utf8'), await readFile(b, 'utf8'),
      'same store must produce byte-identical locks (stable diffs)');
    // GUARD against a serializer change: the file must be CANONICAL JSON with
    // a trailing newline — the same serialization `pull`/`adopt` fingerprint
    // their objects with. Two runs agreeing is not enough: a non-canonical
    // serializer (key order of insertion) is stable per run only by accident
    // of this fixture's insertion order, and the committed lock must be
    // re-hashable against the store's own rule.
    const raw = await readFile(a, 'utf8');
    assert.ok(raw.endsWith('\n'), 'the lock file must end with a newline');
    const doc = JSON.parse(raw);
    assert.equal(raw, `${canonicalJson(doc)}\n`,
      'the lock file must be canonical JSON — keys sorted, trailing newline');
  } finally { await rmrf(store); }
});

test('lock refuses a store the reader refuses: a damaged object yields NO lock', async () => {
  const { store, fingerprints } = await twoProgramStore();
  const lockPath = path.join(store, 'sememe.lock');
  try {
    const { writeLock } = await import('../src/lock.mjs');
    // Damage the store the way the 2026-10-30 defect was found: valid JSON,
    // one instruction renamed, so the object no longer re-hashes to its receipt.
    const objectPath = path.join(store, 'objects', `${fingerprints[WHIRLPOOL]}.json`);
    const tampered = JSON.parse(await readFile(objectPath, 'utf8'));
    tampered.instructions[0].name = 'totally_honest_name';
    await writeFile(objectPath, `${canonicalJson(tampered)}\n`);

    // A lock over damaged bytes would be worse than no lock: it would pin a
    // fingerprint the store cannot produce and hand a CI gate a green lie.
    await assert.rejects(
      () => writeLock(store, lockPath),
      /re-hashes to sha256:[a-f0-9]{64}/,
      'writeLock must refuse a store the reader refuses, by the reader\'s own reason',
    );
    await assert.rejects(() => readFile(lockPath), /ENOENT/,
      'no lock file may be left behind when the store is refused');
  } finally { await rmrf(store); }
});

test('a drifted store (newer pull replaced the pinned fingerprint) is named', async () => {
  const { store, fingerprints } = await twoProgramStore();
  const lockPath = path.join(store, 'sememe.lock');
  try {
    const { writeLock, checkLock } = await import('../src/lock.mjs');
    await writeLock(store, lockPath);
    // A newer pull of Whirlpool: same program address (the reader would refuse
    // a foreign address), newer slot, one renamed instruction -> new fingerprint.
    const newer = JSON.parse(JSON.stringify(whirlpoolIdl));
    newer.instructions[0].name = `${newer.instructions[0].name}_v2`;
    await putIdl(store, WHIRLPOOL, newer, 465999999, 'metadata');

    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.drifted.length, 1, 'exactly the newer-pulled program drifts');
    assert.equal(report.drifted[0].program, WHIRLPOOL);
    assert.equal(report.drifted[0].pinned, `sha256:${fingerprints[WHIRLPOOL]}`,
      'the report must quote the pinned fingerprint in receipt form');
    assert.match(report.drifted[0].store, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(report.drifted[0].store, `sha256:${fingerprints[WHIRLPOOL]}`);
    assert.deepEqual(report.missing, []);
    assert.equal(report.pinned, 2, 'the pin count stays the whole lock');
    // and Jupiter stays verified
    assert.deepEqual(report.verified, [JUPITER]);
  } finally { await rmrf(store); }
});

test('a store without a pinned program is reported missing, by name', async () => {
  const { store } = await twoProgramStore();
  const lockPath = path.join(store, 'sememe.lock');
  try {
    const { writeLock, checkLock } = await import('../src/lock.mjs');
    await writeLock(store, lockPath);
    await rm(path.join(store, 'receipts'), { recursive: true, force: true });
    await mkdir(path.join(store, 'receipts'), { recursive: true });
    // leave Jupiter's receipts, drop Whirlpool's
    const names = []; // receipts dir is now empty; re-add Jupiter
    await putIdl(store, JUPITER, jupiterIdl, 465104868, 'anchor');
    assert.deepEqual(names, []);

    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.deepEqual(report.missing, [WHIRLPOOL]);
    assert.equal(report.drifted.length, 0);
    assert.deepEqual(report.verified, [JUPITER]);
  } finally { await rmrf(store); }
});

test('a pinned object that fails the re-hash is unverified, not silently accepted', async () => {
  const { store, fingerprints } = await twoProgramStore();
  const lockPath = path.join(store, 'sememe.lock');
  try {
    const { writeLock, checkLock } = await import('../src/lock.mjs');
    await writeLock(store, lockPath);
    // tamper the whirlpool object (valid JSON, renamed instruction)
    const objectPath = path.join(store, 'objects', `${fingerprints[WHIRLPOOL]}.json`);
    const tampered = JSON.parse(await readFile(objectPath, 'utf8'));
    tampered.instructions[0].name = 'totally_honest_name';
    await writeFile(objectPath, `${canonicalJson(tampered)}\n`);

    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.unverified.length, 1, 'the tampered program must be unverified');
    assert.equal(report.unverified[0].program, WHIRLPOOL);
    assert.match(report.unverified[0].reason, /re-hashes to sha256:[a-f0-9]{64}/,
      'the unverified reason must carry the store reader\'s own re-hash refusal');
    assert.equal(report.drifted.length, 0, 'a re-hash failure is not drift');
    assert.deepEqual(report.verified, [JUPITER]);
  } finally { await rmrf(store); }
});

test('store programs outside the lock are extra: reported, never a violation', async () => {
  const { store } = await twoProgramStore();
  const lockPath = path.join(store, 'only-whirlpool.json');
  try {
    const { writeLock, checkLock } = await import('../src/lock.mjs');
    // hand-write a lock that pins only Whirlpool
    const doc = {
      lockVersion: 1,
      programs: { [WHIRLPOOL]: { fingerprint: `sha256:${'a'.repeat(64)}`, source: 'metadata', slot: 462039125, receipt: 'x' } },
    };
    await writeFile(lockPath, JSON.stringify(doc, null, 2));
    // fix the fingerprint so whirlpool verifies, jupiter stays unpinned
    const { readLock } = await import('../src/lock.mjs');
    void readLock;
    const real = await writeLock(store, path.join(store, 'full.lock'));
    doc.programs[WHIRLPOOL] = real.programs[WHIRLPOOL];
    await writeFile(lockPath, JSON.stringify(doc, null, 2));

    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.deepEqual(report.extra, [JUPITER]);
    assert.deepEqual(report.drifted, [], 'extra programs are not violations');
    assert.deepEqual(report.verified, [WHIRLPOOL]);
  } finally { await rmrf(store); }
});

test('mode error throws on drift with the program and both fingerprints named', async () => {
  const { store, fingerprints } = await twoProgramStore();
  const lockPath = path.join(store, 'sememe.lock');
  try {
    const { writeLock, checkLock } = await import('../src/lock.mjs');
    await writeLock(store, lockPath);
    const newer = JSON.parse(JSON.stringify(whirlpoolIdl));
    newer.instructions[0].name = `${newer.instructions[0].name}_v2`;
    const replaced = await putIdl(store, WHIRLPOOL, newer, 465999999, 'metadata');

    await assert.rejects(
      () => checkLock(store, lockPath, { mode: 'error' }),
      (error) => error.message.includes(WHIRLPOOL)
        && error.message.includes(fingerprints[WHIRLPOOL])
        && error.message.includes(replaced.fingerprint),
      'the error-mode refusal must name the program and BOTH fingerprints',
    );
  } finally { await rmrf(store); }
});

test('a lock document that is not v1 JSON is refused with a named reason', async () => {
  const { store } = await twoProgramStore();
  const lockPath = path.join(store, 'bad.lock');
  try {
    const { checkLock } = await import('../src/lock.mjs');
    await writeFile(lockPath, '{not json');
    await assert.rejects(() => checkLock(store, lockPath, { mode: 'warn' }), /is not JSON/);

    await writeFile(lockPath, JSON.stringify({ lockVersion: 99, programs: {} }));
    await assert.rejects(() => checkLock(store, lockPath, { mode: 'warn' }), /unsupported lockVersion/);

    await writeFile(lockPath, JSON.stringify({
      lockVersion: 1,
      programs: { [WHIRLPOOL]: { fingerprint: 'sha256:zz-not-a-hash', source: 'metadata', slot: 1, receipt: 'x' } },
    }));
    await assert.rejects(() => checkLock(store, lockPath, { mode: 'warn' }), /malformed fingerprint/);

    await writeFile(lockPath, JSON.stringify({ lockVersion: 1, programs: 'not-an-object' }));
    await assert.rejects(() => checkLock(store, lockPath, { mode: 'warn' }), /programs/);
  } finally { await rmrf(store); }
});

test('the CLI writes and verifies a lock: lock then verify exits 0', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'sememe-lock-cli-'));
  const store = path.join(work, 'store');
  try {
    await mkdir(path.join(store, 'objects'), { recursive: true });
    await mkdir(path.join(store, 'receipts'), { recursive: true });
    await putIdl(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
    await putIdl(store, JUPITER, jupiterIdl, 465104868, 'anchor');

    const lockOut = path.join(work, 'sememe.lock');
    execFileSync(process.execPath, [BIN, 'lock', '--store', store, '--out', lockOut], { cwd: work });
    const doc = JSON.parse(await readFile(lockOut, 'utf8'));
    assert.equal(doc.lockVersion, 1);
    assert.ok(doc.programs[WHIRLPOOL], 'the CLI lock must carry the pinned program');

    const ok = spawnSync(process.execPath, [BIN, 'verify', '--store', store, '--lock', lockOut, '--mode', 'warn'], { cwd: work, encoding: 'utf8' });
    assert.equal(ok.status, 0, `verify on an intact store must exit 0, got ${ok.status}: ${ok.stderr}`);
    const report = JSON.parse(ok.stdout);
    assert.equal(report.verified.length, 2);
  } finally { await rmrf(work); }
});

test('the CLI verify in error mode exits 1 and names the drift on stderr', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'sememe-lock-cli-'));
  const store = path.join(work, 'store');
  try {
    await mkdir(path.join(store, 'objects'), { recursive: true });
    await mkdir(path.join(store, 'receipts'), { recursive: true });
    await putIdl(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
    const lockOut = path.join(work, 'sememe.lock');
    execFileSync(process.execPath, [BIN, 'lock', '--store', store, '--out', lockOut], { cwd: work });

    const newer = JSON.parse(JSON.stringify(whirlpoolIdl));
    newer.instructions[0].name = `${newer.instructions[0].name}_v2`;
    await putIdl(store, WHIRLPOOL, newer, 465999999, 'metadata');

    const drifted = spawnSync(process.execPath, [BIN, 'verify', '--store', store, '--lock', lockOut], { cwd: work, encoding: 'utf8' });
    assert.equal(drifted.status, 1, 'verify in error mode must exit 1 on drift');
    assert.match(drifted.stderr, /drifted/, 'stderr must name the violation class');
    assert.match(drifted.stderr, new RegExp(WHIRLPOOL.slice(0, 12)), 'stderr must name the program');

    // GUARD (bug found in the first live run, 2026-11-05): warn mode REPORTS
    // the drift but must exit 0 — a warning that fails the build is not a
    // warning. The pre-fix CLI set exitCode=1 for both modes.
    const warned = spawnSync(process.execPath, [BIN, 'verify', '--store', store, '--lock', lockOut, '--mode', 'warn'], { cwd: work, encoding: 'utf8' });
    assert.equal(warned.status, 0, 'warn mode must report and exit 0');
    assert.match(warned.stderr, /drifted/, 'warn mode must still name the drift on stderr');
  } finally { await rmrf(work); }
});

test('the CLI usage documents both lock commands, and the README ships them', async () => {
  const usage = (await readFile(BIN, 'utf8')).match(/const usage = `([\s\S]*?)`;/)[1];
  assert.match(usage, /sememe lock/, 'usage must document `sememe lock`');
  assert.match(usage, /sememe verify/, 'usage must document `sememe verify`');

  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /Lockfiles, catalog import and daemon are still proposals/,
    'the Status line must stop calling lockfiles a proposal now that the lockfile ships');
  assert.match(readme, /`sememe lock`/, 'README must document the lock command');
  assert.match(readme, /`sememe verify`/, 'README must document the verify command');
  // the limits sentence used to list `lock` among the unbuilt proposals
  const limits = readme.match(/`resolve`, `decode-tx`[^`]*remain proposals/);
  assert.ok(limits === null || !/`lock`/.test(limits[0]),
    'the limits sentence must stop listing lock as a proposal');
});
