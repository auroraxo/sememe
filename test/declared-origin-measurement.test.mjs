// The declared-origin measurement: a label that never reads as a proven fact,
// and cannot be rewritten without the gate noticing.
//
// This file pins the two committed artifacts of tools/measure-declared-origin.mjs:
//
//   research/declared-origin-2026-11-07-before.json  the PUBLISHED v0.4.10 tag
//       (the code before this fix — the tag carries the defect)
//   research/declared-origin-2026-11-07.json          the FIXED tree
//
// WHAT WAS MEASURED, on the published v0.4.10 tree:
//
//   1. THE LABEL IS A PROVENANCE CLAIM. `sememe adopt` writes a receipt whose
//      `origin` is whatever the caller typed, and EVERY reader surface then
//      presents that string as where the bytes came from:
//
//        adopt output : "origin": "solana-labs-anchor-deadbeef-does-not-exist.json"
//        reader label : "published (adopted, solana-labs-anchor-deadbeef-...)"
//        union label  : "published (adopted, solana-labs-anchor-deadbeef-...)"
//
//      Nothing checks that the named repo exists, that the file is there, or
//      that the bytes came from it at all.
//
//   2. THE LABEL IS NOT COVERED BY THE FINGERPRINT. The fingerprint covers the
//      OBJECT; the RECEIPT — which carries the declared origin — was covered by
//      NOTHING. Measured: rewriting `origin` to `attacker/rewritten-origin`
//      and running `sememe verify --mode warn` reported
//        violations: 0   verified: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
//      and `verify --mode error` exited 0. The CI gate could not see a
//      rewritten provenance label.
//
//   3. THE SAME BYTES UNDER A DIFFERENT DECLARED ORIGIN COLLIDE. Two adopts
//      of ONE file with two different `--origin` values wrote the SAME receipt
//      filename with DIFFERENT contents, so the second write failed with
//      "digest collision or corrupted local object" — a reason that names
//      neither the origin nor the fact that the two receipts differ only in
//      their declared label. The caller is told their store is corrupt when
//      their store is fine.
//
// The suite's job is to keep the fixed tree fixed and the before-artifact
// honest: a hand-edited "before" that said the published tag was clean would
// make this file prove nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm as fsRm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-declared-origin.mjs');
const BEFORE = path.join(ROOT, 'research', 'declared-origin-2026-11-07-before.json');
const AFTER = path.join(ROOT, 'research', 'declared-origin-2026-11-07.json');

const before = JSON.parse(await readFile(BEFORE, 'utf8'));
const after = JSON.parse(await readFile(AFTER, 'utf8'));

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const REWRITTEN = 'attacker/rewritten-origin';

test('the BEFORE artifact records the defect on the PUBLISHED v0.4.10 tag', () => {
  assert.equal(before.binary.tag, 'v0.4.10',
    'the before-artifact must be measured on the published tag, not on this tree');
  assert.equal(before.verdict.ok, false,
    'v0.4.10 violated the contract — if this says clean, the measurement is wrong');
  assert.ok(before.verdict.violations.length >= 5,
    `the defect must be recorded violation by violation, got ${JSON.stringify(before.verdict.violations)}`);

  // 1. The label read as a bare provenance claim on every surface.
  const t1 = before.t1.readerSurfaces;
  assert.equal(t1.adoptOriginStatus, null,
    'v0.4.10 did not tell the caller the origin was only declared');
  assert.equal(t1.adoptOriginNote, null,
    'v0.4.10 said nothing about what it did NOT check');
  assert.equal(t1.idlMetaOriginStatus, null,
    'v0.4.10 carried no status next to the origin on the decode surface');
  assert.match(t1.readerLabel, /adopted, solana-labs-anchor-deadbeef/,
    'v0.4.10 presented the caller-typed origin as a plain provenance label');
  assert.doesNotMatch(t1.readerLabel, /declared/i,
    'v0.4.10 did not mark the origin as declared');
  assert.match(t1.unionLabel, /adopted, solana-labs-anchor-deadbeef/,
    'v0.4.10 presented the origin as a plain provenance claim on the union path too');

  // 2. A rewritten declared origin was invisible to the gate.
  const t2 = before.t2.rewrittenOrigin;
  assert.equal(t2.verifyBeforeViolations, 0, 'the untouched store was clean');
  assert.equal(t2.verifyAfterViolations, 0,
    'v0.4.10 reported ZERO violations after the declared origin was rewritten');
  assert.deepEqual(t2.verifyAfterVerified, [PUMP],
    'v0.4.10 still reported the program as VERIFIED over a rewritten origin');
  assert.equal(t2.relabelled, null,
    'v0.4.10 had no way to name a rewritten origin');
  assert.equal(t2.verifyErrorExit, 0,
    'v0.4.10 verify exited 0 in error mode over a rewritten origin — the CI gate was green');

  // 3. Two declared origins for one set of bytes were a false collision.
  const t3 = before.t3.twoDeclaredOrigins;
  assert.equal(t3.secondExit, 1, 'v0.4.10 refused the second adopt');
  assert.equal(t3.secondSaysCollision, true,
    'v0.4.10 called a differing declared origin a digest collision');
  assert.equal(t3.receipts, 1,
    'v0.4.10 stored one receipt, not one per declared origin');
  assert.match(t3.secondErrorHead, /digest collision or corrupted local object/);

  // The control was green BEFORE the fix too: the defect is specific to the
  // declared origin, not a general breakage.
  const t4 = before.t4.control;
  assert.equal(t4.adoptExit, 0);
  assert.equal(t4.decodeExit, 0);
  assert.equal(t4.decodeInstruction, 'sell_v3');
  assert.equal(t4.lockExit, 0);
  assert.equal(t4.verifyExit, 0);
});

test('the AFTER artifact is the one the tool produces right now (no hand-edited numbers)', async () => {
  const fresh = path.join(ROOT, 'research', '.declared-origin-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, fresh], { cwd: ROOT, stdio: 'pipe' });
    const computed = JSON.parse(await readFile(fresh, 'utf8'));
    delete computed.generatedAt;
    delete after.generatedAt;
    assert.deepEqual(computed, after,
      'the committed after-artifact must be exactly what the tool measures now');
  } finally {
    await fsRm(fresh, { force: true });
  }
});

test('the fixed tree satisfies the whole contract, control included', () => {
  assert.equal(after.verdict.ok, true,
    `the fixed tree violated the contract: ${JSON.stringify(after.verdict.violations)}`);

  // 1. Every surface calls the origin DECLARED and says what was not checked.
  const t1 = after.t1.readerSurfaces;
  assert.equal(t1.adoptExit, 0);
  assert.equal(t1.adoptOriginStatus, 'declared');
  assert.match(t1.adoptOriginNote, /not verified|declared/i);
  assert.equal(t1.idlMetaOriginStatus, 'declared',
    'the decode surface must carry the origin status');
  assert.match(t1.readerLabel, /declared/i,
    `the reader label must mark the origin as declared, got: ${t1.readerLabel}`);
  assert.match(t1.unionLabel, /declared/i,
    `the union label must mark the origin as declared, got: ${t1.unionLabel}`);
  assert.ok(t1.readerLabel.includes('solana-labs-anchor-deadbeef-does-not-exist.json'),
    'the label must still carry the origin the caller typed — declared, not hidden');

  // 2. A rewritten declared origin is a NAMED violation and fails the gate.
  const t2 = after.t2.rewrittenOrigin;
  assert.equal(t2.verifyBeforeViolations, 0, 'the untouched store is still clean');
  assert.ok(t2.verifyAfterViolations > 0,
    'a rewritten declared origin must be a violation');
  assert.deepEqual(t2.verifyAfterVerified, [],
    'the program must NOT still be reported as verified');
  assert.ok(Array.isArray(t2.relabelled) && t2.relabelled.length >= 1,
    'the rewrite must be named as a relabelled origin');
  assert.equal(t2.relabelled[0].program, PUMP);
  assert.match(t2.relabelled[0].reason, /origin/i);
  assert.equal(t2.verifyErrorExit, 1,
    'verify in error mode must exit 1 over a rewritten origin');
  assert.match(t2.verifyErrorHead, /origin/i);

  // 3. Two declared origins for one set of bytes are two receipts.
  const t3 = after.t3.twoDeclaredOrigins;
  assert.equal(t3.firstExit, 0);
  assert.equal(t3.secondExit, 0, 'the second adopt must succeed');
  assert.equal(t3.secondSaysCollision, false,
    'a differing declared origin must never be reported as a digest collision');
  assert.equal(t3.receipts, 2,
    'one set of bytes, two declared origins, two receipts');

  // The control still works — the fix changes the defective case only.
  const t4 = after.t4.control;
  assert.equal(t4.adoptExit, 0);
  assert.equal(t4.decodeExit, 0);
  assert.equal(t4.decodeInstruction, 'sell_v3');
  assert.equal(t4.lockExit, 0);
  assert.equal(t4.verifyExit, 0);
});

test('the fix is visible in the measurement, not only in the unit tests', () => {
  // The gate that could not see a rewritten label now sees it.
  assert.equal(before.t2.rewrittenOrigin.verifyAfterViolations, 0);
  assert.ok(after.t2.rewrittenOrigin.verifyAfterViolations > 0);
  assert.equal(before.t2.rewrittenOrigin.verifyErrorExit, 0);
  assert.equal(after.t2.rewrittenOrigin.verifyErrorExit, 1);

  // The false collision is gone.
  assert.equal(before.t3.twoDeclaredOrigins.secondExit, 1);
  assert.equal(after.t3.twoDeclaredOrigins.secondExit, 0);
  assert.equal(before.t3.twoDeclaredOrigins.receipts, 1);
  assert.equal(after.t3.twoDeclaredOrigins.receipts, 2);

  // The surfaces now say what they are.
  assert.doesNotMatch(before.t1.readerSurfaces.readerLabel, /declared/i);
  assert.match(after.t1.readerSurfaces.readerLabel, /declared/i);

  // And the CONTROL must NOT move — the fix changes the defective case only.
  assert.equal(before.t4.control.verifyExit, after.t4.control.verifyExit);
  assert.equal(before.t4.control.decodeInstruction, after.t4.control.decodeInstruction);
});
