// A DECLARED origin is not a VERIFIED origin — and sememe's readers said it
// was, everywhere.
//
// WHAT WAS MEASURED (2026-11-07, this host, the PUBLISHED v0.4.10 tree,
// main 939b320 — the code the pinned tag carries):
//
//   1. THE LABEL IS A PROVENANCE CLAIM. `sememe adopt` writes a receipt whose
//      `origin` field is whatever the caller typed, and EVERY reader surface
//      then presents that string as where the bytes came from:
//
//        adopt output : "origin": "solana-labs-anchor-deadbeef-does-not-exist.json"
//        reader label : "published (adopted, solana-labs-anchor-deadbeef-does-not-exist.json)"
//        idlMeta      : { "origin": "solana-labs-anchor-deadbeef-does-not-exist.json" }
//        union view   : primary.label = "published (adopted, solana-labs-...)"
//        refusal text : "decode refused by the only stored source
//                        (published (adopted, solana-labs-...)): ..."
//
//      Nothing checks that the named repo exists, that the file is there, or
//      that the bytes came from it at all. A caller can name a repository that
//      does not exist and every reader will repeat it as the origin.
//
//   2. THE LABEL IS NOT COVERED BY THE FINGERPRINT. The fingerprint covers the
//      OBJECT (the canonical IDL bytes). The receipt — which carries the
//      declared origin — is covered by NOTHING. Measured: rewriting `origin`
//      in a receipt to `attacker/rewritten-origin` and running
//      `sememe verify --mode warn` reported
//        violations: 0   verified: ["6EF8rrec…"]
//      The store's provenance label can be rewritten at will and the CI gate
//      stays green. The lock's own promise is "a snapshot of VERIFIED answers"
//      — the fingerprint is verified, the origin next to it is not, and the
//      report does not say which is which.
//
//   3. THE SAME BYTES UNDER A DIFFERENT DECLARED ORIGIN COLLIDE. Two adopts
//      of ONE file with two different `--origin` values write the SAME receipt
//      filename (`<program>-0-<source>-<fingerprint>.json`) with DIFFERENT
//      contents, so the second write fails with
//        "digest collision or corrupted local object: …receipts/….json"
//      A reason that names neither the origin nor the fact that the two
//      receipts differ only in their declared label. The caller is told their
//      store is corrupt when their store is fine.
//
// WHAT THIS FILE PINS (against the pre-fix tree, then the fix):
//
//   P1  THE DECLARED ORIGIN IS LABELLED AS DECLARED. Every reader surface
//       that shows an adopted copy's origin must mark it as a DECLARED label,
//       never as a verified provenance — so no reader can mistake a typed
//       string for a checked fact.
//   P2  THE ORIGIN IS NOT VERIFIED, AND THE TOOL SAYS SO. `sememe adopt` must
//       refuse to imply it checked anything: the receipt and the CLI output
//       must carry the origin's own status (`declared`, never `verified`),
//       and the CLI must print the fix-line for a caller who wants a CHECKED
//       origin (first-party adoption with a recorded commit + repo, or the
//       on-chain pull, which needs no label at all).
//   P3  THE RECEIPT IS COVERED, SO THE LABEL CANNOT BE REWRITTEN SILENTLY.
//       `sememe verify` must NAME a receipt whose declared origin was
//       rewritten after the fact — the fingerprint covers the object, and the
//       origin must be covered by something too, or the label is a free-text
//       field in a file the gate trusts.
//   P4  THE SAME BYTES UNDER TWO DECLARED ORIGINS ARE TWO RECEIPTS, NOT A
//       COLLISION. Adopting one file twice under two different declared
//       origins must produce two receipts and name both — never a
//       "digest collision or corrupted local object".
//   P5  CONTROL (false-positive guard): a store with ONE adopted copy whose
//       origin was NOT rewritten decodes byte-identically, locks clean and
//       verifies clean.
//
// MUTATIONS (at the end of this file) must each turn a test red:
//   Y1  present the declared origin as a plain provenance label again -> P1 red
//   Y2  drop the origin's status field from the receipt             -> P2 red
//   Y3  stop checking the origin in verify                          -> P3 red
//   Y4  refuse different origins for same bytes as collision again  -> P4 red
//
// The claims this file does NOT make: an adopted copy's origin is still not
// verified, and this fix does not verify it. What it does is stop presenting
// a typed string as a checked fact, and stop letting the string change
// without the CI gate noticing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUBLISHED = path.join(HERE, 'fixtures', 'pump-published-idl.json');
const SELL_V3_BASE58 = '3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b';

const { adopt } = await import('../src/adopt.mjs');
const { findStoredIdls, findStoredIdl } = await import('../src/store-read.mjs');
const { decodeUnionPayload, decodePayload } = await import('../src/decode.mjs');
const { writeLock, checkLock } = await import('../src/lock.mjs');
const { canonicalJson } = await import('../src/canonical.mjs');

/** A declared origin that names a repository which does not exist. */
const UNVERIFIABLE = 'solana-labs/anchor@deadbeef/does-not-exist.json';

function runBin(args, cwd = ROOT) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

async function adoptedStore(origin = UNVERIFIABLE) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-origin-'));
  const receipt = await adopt(PUMP, PUBLISHED, dir, { source: 'published', origin });
  return { dir, receipt };
}

async function rewriteDeclaredOrigin(dir, receiptName, next) {
  const receiptPath = path.join(dir, 'receipts', receiptName);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.origin = next;
  await writeFile(receiptPath, Buffer.from(canonicalJson(receipt) + '\n'));
  return receiptPath;
}

// ---------------------------------------------------------------------------
// P1: the declared origin is LABELLED as declared, on every reader surface.
// ---------------------------------------------------------------------------
test('P1: every reader surface marks a declared origin as DECLARED, never as a verified provenance', async () => {
  const { dir } = await adoptedStore();
  try {
    const found = await findStoredIdls(dir, PUMP);
    const entry = found.adopted[0];
    assert.match(entry.label, /declared/i,
      `the reader label must mark the origin as DECLARED, got: ${entry.label}`);
    assert.match(entry.label, /published/,
      'the label must still name the source it came from');
    assert.ok(entry.label.includes('solana-labs-anchor-deadbeef-does-not-exist.json'),
      'the label must still carry the origin the caller typed');

    assert.ok(entry.idlMeta.originStatus, 'the origin must carry its own status');
    assert.equal(entry.idlMeta.originStatus, 'declared',
      'an adopted origin is DECLARED; nothing verified it');
    assert.equal(entry.idlMeta.origin, 'solana-labs-anchor-deadbeef-does-not-exist.json');

    const union = await decodeUnionPayload(dir, PUMP, SELL_V3_BASE58);
    assert.match(union.view.primary.label, /declared/i,
      `the union view must mark the origin as declared, got: ${union.view.primary.label}`);

    const cli = runBin(['adopt', PUMP, PUBLISHED, '--store', dir, '--origin', UNVERIFIABLE]);
    assert.equal(cli.status, 0, `adopt must succeed: ${cli.stderr}`);
    const printed = JSON.parse(cli.stdout);
    assert.equal(printed.originStatus, 'declared',
      'the CLI must print the origin status');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P2: the tool says what it did NOT do, and names the ways to get a CHECKED
//     origin.
// ---------------------------------------------------------------------------
test('P2: adopt states the origin is declared, not verified, and names the way to a checked origin', async () => {
  const { dir } = await adoptedStore();
  try {
    const cli = runBin(['adopt', PUMP, PUBLISHED, '--store', dir, '--origin', UNVERIFIABLE]);
    assert.equal(cli.status, 0);
    const printed = JSON.parse(cli.stdout);
    assert.equal(printed.originStatus, 'declared');
    assert.match(String(printed.originNote ?? ''), /not verified|unverified|declared/i,
      `the adopt output must say the origin was not verified, got: ${printed.originNote}`);

    const names = await readdir(path.join(dir, 'receipts'));
    const receipt = JSON.parse(await readFile(path.join(dir, 'receipts', names[0]), 'utf8'));
    assert.equal(receipt.originStatus, 'declared');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P3: rewriting the declared origin is a NAMED violation, not a green gate.
// ---------------------------------------------------------------------------
test('P3: verify names a rewritten declared origin instead of reporting a clean store', async () => {
  const { dir, receipt } = await adoptedStore();
  try {
    const lockPath = path.join(dir, 'sememe.lock');
    await writeLock(dir, lockPath);

    const before = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.equal(before.violations, 0, 'an untouched store must verify clean');
    assert.deepEqual(before.verified, [PUMP]);

    await rewriteDeclaredOrigin(dir, path.basename(receipt.receiptPath), 'attacker/rewritten-origin');

    const after = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.ok(after.violations > 0,
      'a rewritten declared origin must be a violation, not a green CI gate');
    assert.ok(after.relabelled && after.relabelled.length >= 1,
      `the violation must be in relabelled, got: ${JSON.stringify(after)}`);
    const named = after.relabelled[0];
    assert.equal(named.program, PUMP);
    assert.match(named.reason, /origin/i, 'the reason must name the origin');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('P3b: verify in error mode exits 1 over a rewritten declared origin', async () => {
  const { dir, receipt } = await adoptedStore();
  try {
    const lockPath = path.join(dir, 'sememe.lock');
    await writeLock(dir, lockPath);
    await rewriteDeclaredOrigin(dir, path.basename(receipt.receiptPath), 'attacker/rewritten-origin');

    const cli = runBin(['verify', '--store', dir, '--lock', lockPath]);
    assert.equal(cli.status, 1, 'verify in error mode must exit 1 over a rewritten origin');
    assert.match(cli.stderr + cli.stdout, /origin/i,
      'the CLI must name the origin in its report');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P4: the same bytes under two declared origins are TWO receipts, not a
//     false "digest collision".
// ---------------------------------------------------------------------------
test('P4: adopting the SAME bytes under two declared origins yields two receipts and names both', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-origin-two-'));
  try {
    const first = await adopt(PUMP, PUBLISHED, dir, { source: 'published', origin: 'author-a/interface-a.json' });
    assert.ok(first.receiptPath, 'the first adopt writes a receipt');

    const second = await adopt(PUMP, PUBLISHED, dir, { source: 'published', origin: 'author-b/interface-b.json' });
    assert.ok(second.receiptPath, 'the second adopt writes a receipt');

    const names = (await readdir(path.join(dir, 'receipts'))).filter((n) => n.startsWith(PUMP));
    assert.equal(names.length, 2,
      `two declared origins for the same bytes must be two receipts, got: ${names.join(', ')}`);

    const found = await findStoredIdls(dir, PUMP);
    const origins = found.adopted.map((e) => e.idlMeta.origin).sort();
    assert.deepEqual(origins, ['author-a-interface-a.json', 'author-b-interface-b.json'],
      `both declared origins must survive, got: ${origins.join(', ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('P4b: the CLI refuses to call a differing receipt a digest collision', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-origin-cli-'));
  try {
    const first = runBin(['adopt', PUMP, PUBLISHED, '--store', dir, '--origin', 'author-a/a.json']);
    assert.equal(first.status, 0, `first adopt must succeed: ${first.stderr}`);
    const second = runBin(['adopt', PUMP, PUBLISHED, '--store', dir, '--origin', 'author-b/b.json']);
    assert.equal(second.status, 0,
      `the second adopt must succeed, not fail as a collision: ${second.stderr}`);
    assert.doesNotMatch(second.stderr, /digest collision|corrupted local object/,
      'the failure reason must not call a differing declared origin a digest collision');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P5: CONTROL (false-positive guard): an untouched store decodes, locks and
//     verifies clean on both trees.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// P5: CONTROL (false-positive guard): an untouched store decodes
//     byte-identically, locks clean and verifies clean on both trees.
// ---------------------------------------------------------------------------
test('P5 (CONTROL): an untouched store decodes byte-identically, locks clean and verifies clean', async () => {
  const { dir } = await adoptedStore('only-copy');
  try {
    const plain = await findStoredIdl(dir, PUMP);
    assert.equal(plain.receipt.program, PUMP);

    const decoded = await decodePayload(dir, PUMP, SELL_V3_BASE58);
    assert.equal(decoded.instruction, 'sell_v3');
    assert.equal(decoded.roundTripByteExact, true);

    const lockPath = path.join(dir, 'sememe.lock');
    await writeLock(dir, lockPath);
    const report = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.equal(report.violations, 0,
      `the control store must verify clean, got: ${JSON.stringify(report)}`);
    assert.deepEqual(report.verified, [PUMP]);
    assert.deepEqual(report.relabelled, [],
      'an untouched store must never report a relabelled origin');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P6: LEGACY receipts — a store written before originStatus/originDigest
//     existed must keep working, must be marked declared, and must still be
//     protected once it is LOCKED (the lock pins the origin string itself).
// ---------------------------------------------------------------------------
async function legacyStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-origin-legacy-'));
  // A receipt exactly as sememe wrote it before this fix: origin, no status,
  // no digests. Written by hand so the test does not depend on `adopt`.
  const idl = JSON.parse(await readFile(PUBLISHED, 'utf8'));
  const fingerprint = createHash('sha256').update(canonicalJson(idl) + '\n').digest('hex');
  await mkdir(path.join(dir, 'objects'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, 'receipts'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, 'objects', `${fingerprint}.json`), Buffer.from(canonicalJson(idl) + '\n'));
  const receipt = {
    program: PUMP,
    source: 'published',
    origin: 'legacy-repo-file.json',
    fingerprint: `sha256:${fingerprint}`,
    instructionCount: idl.instructions.length,
  };
  const name = `${PUMP}-0-published-${fingerprint}.json`;
  await writeFile(path.join(dir, 'receipts', name), Buffer.from(canonicalJson(receipt) + '\n'));
  return { dir, name, receipt };
}

test('P6: a legacy receipt (no status, no digest) still decodes, reads as DECLARED, and is protected by the lock', async () => {
  const { dir, name } = await legacyStore();
  try {
    // 1. It must still decode — a store written by an older sememe is not
    //    broken by this fix.
    const decoded = await decodePayload(dir, PUMP, SELL_V3_BASE58);
    assert.equal(decoded.instruction, 'sell_v3');
    assert.equal(decoded.idl.origin, 'legacy-repo-file.json');
    assert.equal(decoded.idl.originStatus, 'declared',
      'a legacy origin is still DECLARED — adopt never verified it');

    const { findStoredIdls } = await import('../src/store-read.mjs');
    const found = await findStoredIdls(dir, PUMP);
    assert.match(found.adopted[0].label, /declared/i,
      `a legacy receipt must be labelled declared too, got: ${found.adopted[0].label}`);
    assert.equal(found.adopted[0].idlMeta.originStatus, 'declared');

    // 2. Re-adopting the SAME bytes under the SAME origin must not rewrite the
    //    legacy receipt in place (its bytes do not carry the new fields).
    const again = await adopt(PUMP, PUBLISHED, dir, { source: 'published', origin: 'legacy-repo-file.json' });
    assert.equal(path.basename(again.receiptPath), name,
      'the legacy receipt path must be reused, not shadowed by a second file');
    const onDisk = JSON.parse(await readFile(path.join(dir, 'receipts', name), 'utf8'));
    assert.equal(onDisk.originDigest, undefined,
      'an existing receipt must never be rewritten in place');

    // 3. The legacy receipt has no self-digest, so its protection comes from
    //    the LOCK, which pins the origin string itself.
    const lockPath = path.join(dir, 'sememe.lock');
    const doc = await writeLock(dir, lockPath);
    assert.equal(doc.programs[PUMP].origin, 'legacy-repo-file.json',
      'the lock must pin the declared origin of a legacy receipt');

    const clean = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.equal(clean.violations, 0, 'the untouched legacy store verifies clean');
    assert.deepEqual(clean.relabelled, []);

    // Rewrite the legacy origin: without a receipt digest, only the LOCK can
    // see it — and it must.
    const receiptPath = path.join(dir, 'receipts', name);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.origin = 'attacker/rewritten-origin';
    await writeFile(receiptPath, Buffer.from(canonicalJson(receipt) + '\n'));

    const after = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.ok(after.violations > 0,
      'a rewritten ORIGIN on a legacy receipt must be a violation once the store is locked');
    assert.ok(after.relabelled.length >= 1,
      `the rewrite must be named relabelled, got: ${JSON.stringify(after)}`);
    assert.equal(after.relabelled[0].scope, 'lock',
      'the lock layer is what protects a receipt that has no self-digest');
    assert.match(after.relabelled[0].reason, /origin/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P7: the SAME receipt body that is EDITED (origin + its digest, consistently)
//     must still be caught by the receipt's own body digest — the layer a
//     self-digest over the body covers beyond the origin digest alone.
// ---------------------------------------------------------------------------
test('P7: rewriting a receipt body consistently (origin AND its digest) is caught by the body digest', async () => {
  const { dir, receipt } = await adoptedStore('body-check');
  try {
    // Write the lock BEFORE the manipulation so it snapshots the clean store.
    const lockPath = path.join(dir, 'sememe.lock');
    await writeLock(dir, lockPath);

    const receiptPath = path.basename(receipt.receiptPath);
    const file = path.join(dir, 'receipts', receiptPath);
    const body = JSON.parse(await readFile(file, 'utf8'));
    body.origin = 'attacker/rewritten-origin';
    body.originDigest = createHash('sha256').update('attacker/rewritten-origin').digest('hex');
    body.originDigest = `sha256:${body.originDigest}`;
    // NOTE: the body digest is deliberately NOT recomputed — so this exercises
    // the body-digest layer. (Recomputing it would make the receipt a
    // self-consistent forgery, which only the LOCK can catch; that is P6.)
    await writeFile(file, Buffer.from(canonicalJson(body) + '\n'));

    await assert.rejects(
      () => decodePayload(dir, PUMP, SELL_V3_BASE58),
      /modified after it was written/,
      'the reader must refuse a receipt whose body digest no longer matches',
    );

    const after = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.ok(after.violations > 0,
      'an edited receipt body must not verify clean');
    assert.ok(after.unverified.length >= 1,
      'a tampered receipt must be reported as unverified');
    assert.match(after.unverified[0].reason, /modified after it was written/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

