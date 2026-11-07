// The extra-damage measurement: `verify` must agree with `lock` about a
// store whose EXTRA program is damaged.
//
// This file pins the two committed artifacts of
// tools/measure-extra-damage.mjs:
//
//   research/extra-damage-2026-11-07-before.json  the PUBLISHED v0.4.10
//       install (github:auroraxo/sememe#v0.4.10 in an empty app, no clone)
//   research/extra-damage-2026-11-07.json          the FIXED tree
//
// WHAT WAS MEASURED on v0.4.10 — a store holding Whirlpool (locked) and
// Jupiter pulled LATER, so Jupiter is an EXTRA (the lock pins minimums, not
// store equality). Jupiter's object was rewritten so it no longer re-hashes
// to the fingerprint its receipt claims; the store reader refuses it, and
// `sememe decode <jupiter> <payload>` exits 1 with "object and receipt
// disagree, refusing to decode":
//
//   sememe lock   -> EXIT 1, no lock written  (writeLock re-checks extras)
//   sememe verify -> EXIT 0, violations 0     (checkLock read only PINNED)
//                      -> a green CI gate over a program the reader refuses
//
// The suite's job is to keep the fixed tree fixed and to keep the
// before-artifact honest — a hand-edited "before" that says the published
// install was clean would make this file prove nothing.
//
// The ladder in test/extra-program-damage.test.mjs pins the BEHAVIOUR of the
// fix; this file pins the MEASUREMENT (the artifacts are what the tool
// produces, not what a human typed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-extra-damage.mjs');
const BEFORE = path.join(ROOT, 'research', 'extra-damage-2026-11-07-before.json');
const AFTER = path.join(ROOT, 'research', 'extra-damage-2026-11-07.json');

const before = JSON.parse(await readFile(BEFORE, 'utf8'));
const after = JSON.parse(await readFile(AFTER, 'utf8'));

test('the BEFORE artifact records the defect on the PUBLISHED v0.4.10 install', () => {
  assert.equal(before.binary.tag, 'v0.4.10',
    'the before-artifact must be measured on the published tag, not on this tree');
  assert.equal(before.verdict.ok, false,
    'v0.4.10 violated the contract — if this says clean, the measurement is wrong');

  // S1: the WRITER already refused the store — that is the asymmetry.
  assert.equal(before.cases.s1.lockExit, 1,
    'v0.4.10 lock must have refused the damaged store');
  assert.equal(before.cases.s1.lockFileWritten, false,
    'v0.4.10 must not have written a lock over damage');

  // S2: the CHECKER called the same store clean — the headline.
  assert.equal(before.cases.s2.verifyErrorExit, 0,
    'v0.4.10 CI gate exited 0 over a store the reader refuses');

  // S3: warn mode counted nothing and named nothing.
  assert.equal(before.cases.s3.violations, 0,
    'v0.4.10 counted no violation over the damage');
  assert.equal(before.cases.s3.unverified.length, 0,
    'v0.4.10 named no damaged receipt');
  assert.equal(before.cases.s3.hasScope, false,
    'v0.4.10 had no scope marker for the damage');
  assert.deepEqual(before.cases.s3.extra.length, 1,
    'the damaged program WAS reported as extra — presence was seen, damage was not');

  // The controls were green BEFORE the fix too: the defect is specific to an
  // unpinned program, not a general breakage.
  assert.equal(before.controls.s5a.verifyExit, 0,
    'an intact extra must not have been a violation on v0.4.10 either');
  assert.equal(before.controls.s5a.violations, 0);
  assert.equal(before.controls.s5b.violations, 1,
    'a damaged PINNED program was already reported on v0.4.10');
});

test('the AFTER artifact is the one the tool produces right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.extra-damage-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', fresh], { cwd: ROOT, stdio: 'ignore' });
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    assert.deepEqual(produced.verdict.violations, [],
      'the tool must find no contract violation on this tree');
    assert.equal(produced.verdict.ok, true);
    // The committed artifact must BE the tool's output, up to the timestamp.
    const strip = (r) => { const c = { ...r }; delete c.measuredAt; return c; };
    assert.deepEqual(strip(produced), strip(after),
      'the committed after-artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
  }
});

test('the AFTER artifact records the fix: verify refuses, warns with a scope, and stays repairable', () => {
  assert.equal(after.verdict.ok, true, 'this tree must meet the contract');
  assert.deepEqual(after.verdict.violations, []);

  // S1 unchanged: the writer refused before and still refuses.
  assert.equal(after.cases.s1.lockExit, 1);
  assert.equal(after.cases.s1.lockFileWritten, false);

  // S2: the checker now agrees with the writer.
  assert.equal(after.cases.s2.verifyErrorExit, 1,
    'verify must exit 1 over a store the reader refuses');
  assert.equal(after.cases.s2.namesProgram, true,
    'the refusal must name the damaged program');

  // S3: warn mode counts it and says WHERE.
  assert.ok(after.cases.s3.violations >= 1, 'warn mode must count the damage');
  assert.equal(after.cases.s3.hasScope, true, 'the damage must be marked scope=extra');
  assert.equal(after.cases.s3.unverified[0].program,
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  assert.ok(after.cases.s3.unverified[0].receipt.includes(after.cases.s3.unverified[0].receipt.slice(-64 - 5, -5)),
    'the named receipt must carry the fingerprint');

  // S4: a violation nobody can clear is not a gate.
  assert.equal(after.cases.s4.repaired, true,
    'the repair path must be able to clear the violation');

  // The controls must still hold on the fixed tree.
  assert.equal(after.controls.s5a.verifyExit, 0,
    'an INTACT extra must still not be a violation');
  assert.equal(after.controls.s5a.violations, 0);
  assert.equal(after.controls.s5b.violations, 1,
    'a damaged PINNED program must still be reported');
});

test('neither artifact carries a host path — a committed artifact with an absolute path is a snapshot', () => {
  for (const [name, artifact] of [['before', before], ['after', after]]) {
    const serialized = JSON.stringify(artifact);
    assert.ok(!serialized.includes('/home/aurora/'),
      `the ${name}-artifact carries an absolute host path — it will not reproduce on CI`);
    assert.ok(!serialized.includes('/tmp/'),
      `the ${name}-artifact carries a scratch-directory path — it will not reproduce on CI`);
  }
  assert.equal(after.binary.path, 'bin/sememe.mjs',
    'the after-artifact must name the binary relative to the repo');
  assert.equal(before.binary.path, null,
    'a foreign install has no path inside the repo; it is named by its tag');
});
