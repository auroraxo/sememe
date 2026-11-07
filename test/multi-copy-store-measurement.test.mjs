// The multi-copy-store measurement: one store, one answer.
//
// This file pins the two committed artifacts of
// tools/measure-multi-copy-store.mjs:
//
//   research/multi-copy-store-2026-11-07-before.json  the PUBLISHED v0.4.8
//       install (github:auroraxo/sememe#v0.4.8 in an empty app, no clone)
//   research/multi-copy-store-2026-11-07.json          the FIXED tree
//
// WHAT WAS MEASURED on v0.4.8 — a store holding two ADOPTED copies of the
// pump.fun program (a35349f3… = 56 instructions, knows sell_v3; 5a00cdb8… =
// 47 instructions, does not):
//
//   sememe decode         -> sell_v3, a35349f3…              EXIT 0
//   sememe decode --union -> REFUSED "unknown instruction
//                            discriminator 1c92de7726c469d5"  EXIT 1
//   sememe lock           -> pins a35349f3…   over a store whose SECOND
//                            copy was DAMAGED                 EXIT 0
//   sememe verify         -> violations 0, "verified"        EXIT 0
//
// One store, two verdicts depending on the flag, and a green CI gate over
// damage. The suite's job is to keep the fixed tree fixed and to keep the
// before-artifact honest — a hand-edited "before" that says the published
// install was clean would make this file prove nothing.
//
// The ladder in test/multi-copy-store.test.mjs pins the BEHAVIOUR of the
// fix; this file pins the MEASUREMENT (the artifacts are what the tool
// produces, not what a human typed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm as fsRm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-multi-copy-store.mjs');
const BEFORE = path.join(ROOT, 'research', 'multi-copy-store-2026-11-07-before.json');
const AFTER = path.join(ROOT, 'research', 'multi-copy-store-2026-11-07.json');

const before = JSON.parse(await readFile(BEFORE, 'utf8'));
const after = JSON.parse(await readFile(AFTER, 'utf8'));

test('the BEFORE artifact records the defect on the PUBLISHED v0.4.8 install', () => {
  assert.equal(before.binary.tag, 'v0.4.8',
    'the before-artifact must be measured on the published tag, not on this tree');
  assert.equal(before.verdict.ok, false,
    'v0.4.8 violated the contract — if this says clean, the measurement is wrong');
  assert.ok(before.verdict.violations.length >= 5,
    `the defect must be recorded defect by defect, got ${JSON.stringify(before.verdict.violations)}`);

  // S1: the plain path answered, the union path refused — the headline.
  const s1 = before.twoCopies.s1;
  assert.equal(s1.plainExit, 0);
  assert.equal(s1.unionExit, 1,
    'v0.4.8 union decode refused bytes the plain decode had just decoded');
  assert.equal(s1.sameFingerprint, false);
  assert.equal(s1.plainFingerprint, 'sha256:a35349f371114b52701a3aeae83627f6b4667251efb3ac9d37a882baa723e818');

  // S2/S3: the lock over damage, and the green verify.
  assert.equal(before.twoCopies.s2.lockExit, 0,
    'v0.4.8 wrote a lock over a store whose second copy was damaged');
  assert.equal(before.twoCopies.s2.lockFileWritten, true);
  assert.equal(before.twoCopies.s3.verifyErrorExit, 0,
    'v0.4.8 CI gate exited 0 over damage');
  assert.equal(before.twoCopies.s3.violations, 0);
  assert.equal(before.twoCopies.s3.unverified.length, 0,
    'v0.4.8 named no damaged receipt');

  // S4: the control was green BEFORE the fix too — the defect is specific to
  // a store holding more than one copy, not a general breakage.
  assert.equal(before.controlSingleCopy.lockExit, 0);
  assert.equal(before.controlSingleCopy.verifyExit, 0);
  assert.equal(before.controlSingleCopy.sameFingerprint, true);
});

test('the AFTER artifact is the one the tool produces right now (no hand-edited numbers)', async () => {
  const fresh = path.join(ROOT, 'research', '.multi-copy-store-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, fresh], { cwd: ROOT, stdio: 'pipe' });
    const computed = JSON.parse(await readFile(fresh, 'utf8'));
    // The volatile fields are the timestamps; everything else must be equal.
    delete computed.generatedAt;
    delete after.generatedAt;
    assert.deepEqual(computed, after,
      'the committed after-artifact must be exactly what the tool measures now');
  } finally {
    await fsRm(fresh, { force: true });
  }
});

test('the fixed tree satisfies the whole contract, and the control stays green', () => {
  assert.equal(after.verdict.ok, true,
    `the fixed tree violated the contract: ${JSON.stringify(after.verdict.violations)}`);

  const s1 = after.twoCopies.s1;
  assert.equal(s1.plainExit, 0);
  assert.equal(s1.unionExit, 0, 'the union path must not refuse bytes the plain path decodes');
  assert.equal(s1.sameFingerprint, true,
    'one store, one answer — whatever flag the caller passes');
  assert.equal(s1.plainFingerprint, s1.unionFingerprint);
  assert.equal(s1.plainInstruction, 'sell_v3');
  assert.equal(s1.unionInstruction, 'sell_v3');

  const s2 = after.twoCopies.s2;
  assert.equal(s2.lockExit, 1, 'no lock over damage');
  assert.equal(s2.lockFileWritten, false, 'a lock file must not exist over a damaged store');

  const s3 = after.twoCopies.s3;
  assert.equal(s3.verifyErrorExit, 1, 'the CI gate must fail over damage');
  assert.ok(s3.violations >= 1, 'the damage is a violation, not a note');
  assert.equal(s3.unverified.length, 1, 'the damaged copy must be named');
  assert.ok(s3.unverified[0].receipt.includes(s3.damagedCopy.replace(/^sha256:/, '')),
    'the named receipt must be the damaged one — and the damaged copy is derived from the store, not hardcoded');

  const s4 = after.controlSingleCopy;
  assert.equal(s4.plainExit, 0);
  assert.equal(s4.unionExit, 0);
  assert.equal(s4.sameFingerprint, true);
  assert.equal(s4.verdict, 'single_source', 'one adopted copy is still a single source');
  assert.equal(s4.adoptedOnly, true);
  assert.equal(s4.lockExit, 0);
  assert.equal(s4.verifyExit, 0, 'the fix must not turn a clean store red');
});

test('the fix is visible in the measurement, not only in the unit tests', () => {
  // The before/after pair must differ in every dimension the defect touched —
  // a fix that moved one number and left the rest identical would be a
  // partial fix dressed as a complete one.
  const b = before.twoCopies;
  const a = after.twoCopies;
  assert.notEqual(b.s1.unionExit, a.s1.unionExit, 'the union refusal must be gone');
  assert.notEqual(b.s1.sameFingerprint, a.s1.sameFingerprint, 'the two answers must agree now');
  assert.notEqual(b.s2.lockExit, a.s2.lockExit, 'the lock must refuse damage now');
  assert.notEqual(b.s2.lockFileWritten, a.s2.lockFileWritten, 'no lock file over damage now');
  assert.notEqual(b.s3.verifyErrorExit, a.s3.verifyErrorExit, 'the CI gate must fail now');
  assert.notEqual(b.s3.violations, a.s3.violations, 'the damage must be counted now');
});
