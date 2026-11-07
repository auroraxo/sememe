// A store can hold MORE THAN ONE adopted copy of the same program — and then
// three different parts of sememe picked three different copies.
//
// WHAT WAS MEASURED (2026-11-07, this host, on the PUBLISHED v0.4.8 install,
// github:auroraxo/sememe#v0.4.8 in an empty app, no clone):
//
//   store = two adopted copies of the pump.fun program:
//     a35349f3…  pump-published-idl.json  (56 instructions, knows sell_v3)
//     5a00cdb8…  pump-idl.json            (47 instructions, does NOT know sell_v3)
//
//   sememe decode        -> sell_v3, fingerprint a35349f3…      (EXIT 0)
//   sememe decode --union-> REFUSED: "unknown instruction discriminator
//                           1c92de7726c469d5 (47 known, …)"      (EXIT 1)
//   sememe lock          -> pins a35349f3…
//   sememe verify        -> violations 0                        (EXIT 0)
//
//   So the plain decode and the union decode answered the SAME BYTES from
//   DIFFERENT copies of the SAME store — and the union path, the one the README
//   documents for "two verified sources", refused bytes the plain path had
//   just decoded. This is the "two verdicts from one store depending on which
//   flag the caller passed" class the tree already fixed once for the
//   acquisition gap (see test/union.test.mjs), in a second shape.
//
// WHY THE TWO COPIES DISAGREEED — the root cause, not the symptom:
//
//   src/store-read.mjs sorted the ADOPTED receipts by their LABEL
//   ("published (adopted, <origin>)") and took the last one, while
//   findStoredIdl (the plain reader) and src/lock.mjs took the last receipt
//   FILENAME. Both orders are "a sort", and they disagree as soon as a second
//   copy exists: the origin label is a string the caller typed, the filename
//   ends in the fingerprint. The union path therefore read a copy chosen by
//   the user's origin spelling, while the lock pinned a copy chosen by
//   content — and neither of them said so.
//
//   The second hole is in the lock: README says "every receipt is re-checked
//   through the store reader first, so a store the reader refuses produces NO
//   lock". Measured: writeLock re-checked only the NEWEST receipt per program.
//   A damaged copy — the very copy the union path reads as its second source —
//   was skipped in silence: `sememe lock` exited 0 and `sememe verify` reported
//   0 violations over a store whose union decode refused to decode.
//
// WHAT THIS FILE PINS (all against the pre-fix tree, then the fix):
//
//   M1  the plain decode and the union decode read the SAME copy out of a
//       two-adopted-copy store (the fingerprints must be equal).
//   M2  with no on-chain copy, the union path ARBITRATES between the two
//       adopted copies instead of ignoring one and refusing the payload.
//   M3  `sememe lock` refuses a store whose SECOND copy is damaged — the
//       README's "every receipt is re-checked" claim, measured.
//   M4  `sememe verify` names that damaged copy as unverified for the pinned
//       program instead of reporting a clean store.
//   M5  CONTROL (false-positive guard): a store with ONE adopted copy still
//       decodes as a single source, locks clean and verifies clean. This is
//       the only case expected to pass on the pre-fix tree.
//   M6  the union result reports the copies it did NOT arbitrate, so a store
//       holding three copies never reads as a two-source store.
//   M7  the CLI exits 0 on the union path for a two-copy store (pre-fix: 1).
//
// MUTATIONS (at the end of this file) must each turn a test red:
//   X1  sort the adopted copies by label again      -> M1 + M2 red
//   X2  let writeLock check only the newest receipt -> M3 + M4 red
//   X3  let the union path ignore its second source -> M2 + M7 red

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// A real mainnet pump.fun sell_v3 payload (test/fixtures/harvest-pump-2026-10-30.json).
const SELL_V3_BASE58 = '3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b';

const { adopt } = await import('../src/adopt.mjs');
const { findStoredIdl, findStoredIdls } = await import('../src/store-read.mjs');
const { decodeUnionPayload } = await import('../src/decode.mjs');
const { writeLock, checkLock } = await import('../src/lock.mjs');
const { canonicalJson } = await import('../src/canonical.mjs');

const PUBLISHED = path.join(HERE, 'fixtures', 'pump-published-idl.json'); // 56 ix, knows sell_v3
const ONCHAIN = path.join(HERE, 'fixtures', 'pump-idl.json'); // 47 ix, does not know sell_v3

/**
 * A store with two ADOPTED copies of the pump program.
 *
 * The origin labels are chosen so that the two possible orderings DISAGREE:
 * the label order ('aaa…' before 'zzz…') and the receipt-filename order (the
 * fingerprint decides) point at different copies. A fix that sorts by label
 * again therefore fails M1 — the trap is built into the fixture, not into the
 * test's expectations.
 */
async function twoAdoptedStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-multicopy-'));
  const first = await adopt(PUMP, PUBLISHED, dir, { source: 'published', origin: 'aaa-docs-copy' });
  const second = await adopt(PUMP, ONCHAIN, dir, { source: 'published', origin: 'zzz-sdk-copy' });
  return { dir, first, second };
}

async function oneAdoptedStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-onecopy-'));
  const only = await adopt(PUMP, PUBLISHED, dir, { source: 'published', origin: 'only-copy' });
  return { dir, only };
}

/** Damage one stored object the way the 2026-10-30 defect was found:
 *  valid JSON, one instruction renamed, so it no longer re-hashes. */
async function damageObject(dir, fingerprint) {
  const hex = fingerprint.replace(/^sha256:/, '');
  const objectPath = path.join(dir, 'objects', `${hex}.json`);
  const tampered = JSON.parse(await readFile(objectPath, 'utf8'));
  tampered.instructions[0].name = `${tampered.instructions[0].name}_tampered`;
  await writeFile(objectPath, `${canonicalJson(tampered)}\n`);
  return objectPath;
}

test('M1: the plain decode and the union decode read the SAME copy of a two-copy store', async () => {
  const { dir, first, second } = await twoAdoptedStore();
  try {
    const plain = await findStoredIdl(dir, PUMP);
    const result = await decodeUnionPayload(dir, PUMP, SELL_V3_BASE58);
    assert.equal(result.view.verdict !== 'refused', true,
      'the union path must not refuse bytes the plain path decodes');
    assert.equal(result.idl.fingerprint, plain.receipt.fingerprint,
      'the union decode and the plain decode must read the same copy — one store, one answer');
    assert.ok([first.fingerprint, second.fingerprint].includes(result.idl.fingerprint));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M2: with no on-chain copy, the union path arbitrates between two adopted copies', async () => {
  const { dir } = await twoAdoptedStore();
  try {
    const sources = await findStoredIdls(dir, PUMP);
    assert.equal(sources.onChain.length, 0, 'nothing on chain to displace');
    assert.equal(sources.adopted.length, 2, 'both copies must be visible to the reader');

    const result = await decodeUnionPayload(dir, PUMP, SELL_V3_BASE58);
    assert.notEqual(result.view.verdict, 'single_source',
      'two adopted copies are two sources — the verdict must not claim a single source');
    assert.equal(result.view.verdict, 'primary_only',
      'the copy that knows sell_v3 answers; the copy that does not is recorded as the refusal');
    assert.equal(result.name, 'sell_v3');
    assert.equal(result.view.secondary.present, true,
      'the second copy must be present in the view, not dropped');
    assert.equal(result.view.secondary.decoded, false);
    assert.match(result.view.secondary.refusedReason ?? '', /discriminator/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M3: the lock refuses a store whose SECOND copy is damaged (every receipt is re-checked)', async () => {
  const { dir, second } = await twoAdoptedStore();
  try {
    await damageObject(dir, second.fingerprint);
    const lockPath = path.join(dir, 'sememe.lock');
    await assert.rejects(
      () => writeLock(dir, lockPath),
      /re-hashes to sha256:[a-f0-9]{64}/,
      'writeLock must re-check EVERY receipt, not only the newest one per program',
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M4: verify names the damaged copy as unverified instead of reporting a clean store', async () => {
  const { dir, second } = await twoAdoptedStore();
  try {
    const lockPath = path.join(dir, 'sememe.lock');
    await writeLock(dir, lockPath);
    await damageObject(dir, second.fingerprint);

    const report = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.equal(report.unverified.length, 1,
      'the damaged copy must be named — a store whose second copy is damaged is not clean');
    assert.equal(report.unverified[0].program, PUMP);
    assert.match(report.unverified[0].reason, /re-hashes to sha256:[a-f0-9]{64}/);
    assert.ok(report.unverified[0].receipt.includes(second.fingerprint.replace(/^sha256:/, '')),
      'the report must name the receipt of the damaged copy');
    assert.ok(report.violations >= 1, 'a damaged copy is a violation, not a note');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M5 (CONTROL): a store with one adopted copy still decodes as a single source and locks clean', async () => {
  const { dir, only } = await oneAdoptedStore();
  try {
    const result = await decodeUnionPayload(dir, PUMP, SELL_V3_BASE58);
    assert.equal(result.view.verdict, 'single_source');
    assert.equal(result.view.adoptedOnly, true);
    assert.equal(result.name, 'sell_v3');
    assert.equal(result.idl.fingerprint, only.fingerprint);

    const lockPath = path.join(dir, 'sememe.lock');
    const doc = await writeLock(dir, lockPath);
    assert.equal(doc.programs[PUMP].fingerprint, only.fingerprint);
    const report = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.deepEqual(report.verified, [PUMP]);
    assert.deepEqual(report.unverified, []);
    assert.equal(report.violations, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M6: the union result reports the copies it did NOT arbitrate', async () => {
  const { dir, first, second } = await twoAdoptedStore();
  try {
    const result = await decodeUnionPayload(dir, PUMP, SELL_V3_BASE58);
    assert.ok(Array.isArray(result.view.additionalSources),
      'the view must carry the remaining copies');
    // Two copies, one arbitrated pair -> nothing left over, and BOTH copies are
    // named between primary, secondary and additional (none vanishes).
    assert.equal(result.view.additionalSources.length, 0);
    assert.ok(result.view.primary.fingerprint);
    assert.ok(result.view.secondary.fingerprint);

    // A THIRD, DISTINCT copy must be accounted for exactly once across the
    // three slots — reported as additional, never silently dropped. (It must
    // differ in BYTES: adopting the same file again yields the same
    // fingerprint and therefore the same receipt — the store stays at two
    // copies, which is why the fixture writes a modified IDL here.)
    const thirdFile = path.join(dir, 'third.json');
    const thirdIdl = JSON.parse(await readFile(ONCHAIN, 'utf8'));
    thirdIdl.instructions[0].name = `${thirdIdl.instructions[0].name}_third`;
    await writeFile(thirdFile, JSON.stringify(thirdIdl));
    const third = await adopt(PUMP, thirdFile, dir, { source: 'published', origin: 'mmm-third-copy' });

    const withThird = await decodeUnionPayload(dir, PUMP, SELL_V3_BASE58);
    const named = [
      withThird.view.primary.fingerprint,
      withThird.view.secondary.fingerprint,
      ...withThird.view.additionalSources.map((s) => s.fingerprint),
    ].filter(Boolean);
    assert.equal(withThird.view.additionalSources.length, 1,
      'a third copy must be reported, never silently dropped');
    assert.deepEqual([...named].sort(), [first.fingerprint, second.fingerprint, third.fingerprint].sort(),
      'every stored copy appears exactly once across primary, secondary and additional');
    assert.ok(withThird.view.additionalSources[0].label);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M7: the CLI union path exits 0 on a two-copy store (it exited 1 before the fix)', async () => {
  const { dir } = await twoAdoptedStore();
  try {
    const run = spawnSync(process.execPath,
      [BIN, 'decode', '--union', PUMP, SELL_V3_BASE58, '--store', dir],
      { encoding: 'utf8' });
    assert.equal(run.status, 0,
      `the union decode must exit 0 on bytes the plain decode decodes, got ${run.status}: ${run.stderr}`);
    const out = JSON.parse(run.stdout);
    assert.equal(out.name, 'sell_v3');
    assert.equal(out.view.verdict, 'primary_only');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M8: the plain and the union CLI decode name the same copy', async () => {
  const { dir } = await twoAdoptedStore();
  try {
    const plain = spawnSync(process.execPath,
      [BIN, 'decode', PUMP, SELL_V3_BASE58, '--store', dir], { encoding: 'utf8' });
    const union = spawnSync(process.execPath,
      [BIN, 'decode', '--union', PUMP, SELL_V3_BASE58, '--store', dir], { encoding: 'utf8' });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(union.status, 0, union.stderr);
    assert.equal(JSON.parse(union.stdout).idl.fingerprint, JSON.parse(plain.stdout).idl.fingerprint,
      'one store, one answer — the fingerprint must not depend on the flag');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// MUTATIONS — each must turn a test above red.
//
// The mutant is written INTO src/ under a dot-prefixed name (so its relative
// imports resolve against the real tree) and deleted afterwards; the real
// modules are never modified. Pattern matches test/union.test.mjs M1/M2.
//
//   X1  sort the adopted copies by their LABEL again (the pre-fix rule in
//       src/store-read.mjs): the union path reads the copy the origin spelling
//       points at, the plain path reads the copy the fingerprint points at.
//       -> M1 red (the two decodes name different fingerprints).
//   X2  let writeLock check only the newest receipt per program (the pre-fix
//       rule in src/lock.mjs): a damaged second copy is skipped.
//       -> M3 red (the lock is written over a damaged store).
//   X3  let the union path ignore its second source (the pre-fix rule in
//       src/union.mjs when there is no on-chain primary): the payload is
//       refused.
//       -> M2 red (no arbitration happens).
// ---------------------------------------------------------------------------

async function withMutant(file, name, mutate) {
  const source = await readFile(path.join(ROOT, 'src', file), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${name}: the mutation must actually change the source`);
  const mutantPath = path.join(ROOT, 'src', `.${name}-mutant.mjs`);
  try {
    await writeFile(mutantPath, mutated);
    return await import(mutantPath);
  } finally {
    await rm(mutantPath, { force: true });
  }
}

test('MUTATION X1 (sort the adopted copies by label again) turns M1 red', async () => {
  const mutant = await withMutant('store-read.mjs', 'x1-label-sort', (source) => source.replace(
    'adopted.sort((a, b) => compareReceiptNames(a.idlMeta.receipt, b.idlMeta.receipt));',
    'adopted.sort((a, b) => a.label.localeCompare(b.label));',
  ));
  const { dir } = await twoAdoptedStore();
  try {
    // Measured under the mutant: the union path's PRIMARY becomes the copy the
    // origin spelling points at (the SDK copy), while the plain reader still
    // answers with the copy the FINGERPRINT points at (the docs copy). The two
    // paths then disagree about the store — the defect this file pins.
    const plain = await mutant.findStoredIdl(dir, PUMP);
    const sources = await mutant.findStoredIdls(dir, PUMP);
    assert.notEqual(sources.primary.idlMeta.fingerprint, plain.receipt.fingerprint,
      'the mutant must make the union path consult a DIFFERENT copy than the plain path — '
      + 'otherwise M1 pins nothing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MUTATION X2 (check only the newest receipt per program) turns M3 red', async () => {
  // The pre-fix rule lived in BOTH lock paths; the mutant reverts the shared
  // helper, so writeLock no longer re-checks the damaged second copy.
  const mutant = await withMutant('lock.mjs', 'x2-newest-only', (source) => source.replace(
    '  for (const name of names) {\n    try {\n      await readVerified(storeDir, program, name);',
    '  for (const name of names.slice(-1)) {\n    try {\n      await readVerified(storeDir, program, name);',
  ));
  const { dir, second } = await twoAdoptedStore();
  try {
    await damageObject(dir, second.fingerprint);
    // The mutant writes a lock over a store whose second copy is damaged —
    // exactly the green lie M3 forbids.
    await mutant.writeLock(dir, path.join(dir, 'sememe.lock'));
    const report = await mutant.checkLock(dir, path.join(dir, 'sememe.lock'), { mode: 'warn' });
    assert.equal(report.unverified.length, 0,
      'the mutant must report a clean store over a damaged one — otherwise M3/M4 pin nothing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MUTATION X3 (let the union path ignore its second source) turns M2 red', async () => {
  const mutant = await withMutant('union.mjs', 'x3-ignore-secondary', (source) => source.replace(
    'const sec = secondary?.idl && secondary !== soleSource ? prepare(secondary) : null;',
    'const sec = null; void secondary; void soleSource;',
  ));
  const { dir } = await twoAdoptedStore();
  try {
    const { findStoredIdls } = await import('../src/store-read.mjs');
    const s = await findStoredIdls(dir, PUMP);
    const { decodeBase58 } = await import('../src/base58.mjs');
    // Measured: with the fixed ordering the PRIMARY is the copy that knows
    // sell_v3, so dropping the secondary does not change WHICH copy answers —
    // it changes the VERDICT: the union stops arbitrating two sources and
    // degrades to "single source". That is exactly what M2 forbids, so X3
    // asserts the verdict differs, not the decode outcome.
    const mutated = await mutant.unionDecode({
      program: PUMP,
      primary: s.primary,
      secondary: s.secondary,
      bytes: decodeBase58(SELL_V3_BASE58),
    });
    assert.equal(mutated.view.verdict, 'single_source',
      'the mutant must degrade the union to a single source — otherwise M2 pins nothing');
    assert.equal(mutated.view.secondary.present, false,
      'the mutant must drop the second source entirely');

    // The unmutated build must arbitrate: two sources, a verdict that says so.
    const { unionDecode } = await import('../src/union.mjs');
    const real = await unionDecode({
      program: PUMP,
      primary: s.primary,
      secondary: s.secondary,
      bytes: decodeBase58(SELL_V3_BASE58),
    });
    assert.notEqual(real.view.verdict, 'single_source',
      'the fixed build must arbitrate the two adopted copies');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
