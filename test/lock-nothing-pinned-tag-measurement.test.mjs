// test/lock-nothing-pinned-tag-measurement.test.mjs — the DELIVERY
// measurement of the lock-pins-nothing defect.
//
// This file pins the committed artifact of
// tools/measure-lock-nothing-pinned-tag.mjs:
//
//   research/lock-nothing-pinned-tag-2026-11-09.json
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE WORKING-TREE MEASUREMENT:
//   The working-tree measurement (tools/measure-lock-nothing-pinned.mjs)
//   asks whether THIS code refuses. It cannot say what a stranger receives.
//   This repo's most-repeated defect is exactly that gap — "main fixed, the
//   pin pointing behind it" — so the PUBLISHED TAGS are installed into an
//   empty directory and measured against the bytes a stranger gets.
//
// WHAT THE MEASUREMENT FOUND:
//
//   v0.4.13 (the tag the README pinned until this release) carries the defect
//   on all THREE faces: `sememe lock` exits 0 writing a lock that pins 0
//   programs, and `sememe verify` exits 0 with `pinned: 0, violations: 0`
//   against the real 18-program store, in both modes.
//
//   v0.4.14 refuses all three with `lock-pins-nothing`, and keeps the
//   ordinary lock-then-verify journey green.
//
// FALSIFICATION:
//   The artifact must show the OLD tag carrying the defect and the NEW tag
//   refusing it; a tag that could not be installed is never called clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'lock-nothing-pinned-tag-2026-11-09.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

const byTag = Object.fromEntries(artifact.tags.map((t) => [t.tag, t]));

test('the artifact carries both tags, none of them unmeasurable', () => {
  for (const tag of artifact.tags) {
    assert.equal(tag.error, undefined, `${tag.tag} must be measurable — an unmeasurable tag is never called clean`);
  }
  assert.ok(byTag['v0.4.13'], 'the artifact must cover the tag that carried the defect');
  assert.ok(byTag['v0.4.14'], 'the artifact must cover the tag that carries the fix');
  assert.equal(artifact.ok, true);
});

test('the OLD tag carries the defect on all three faces', () => {
  const old = byTag['v0.4.13'];
  assert.equal(old.verdict, 'carries-the-defect');
  assert.deepEqual(old.greenOverNothing,
    ['lockEmptyStore', 'verifyEmptyLock', 'verifyEmptyLockWarn'],
    'all three faces of the defect must be visible on the old tag');
  const c = old.cases;
  assert.equal(c.lockEmptyStore.exit, 0);
  assert.equal(c.lockEmptyStore.lockFileWritten, true);
  assert.equal(c.lockEmptyStore.lockPinnedPrograms, 0);
  assert.equal(c.verifyEmptyLock.exit, 0);
  assert.equal(c.verifyEmptyLock.pinned, 0);
  assert.equal(c.verifyEmptyLock.violations, 0);
  assert.equal(c.verifyEmptyLockWarn.exit, 0);
});

test('the NEW tag refuses all three faces and keeps the ordinary journey green', () => {
  const fresh = byTag['v0.4.14'];
  assert.equal(fresh.verdict, 'refuses');
  assert.deepEqual(fresh.greenOverNothing, []);
  assert.equal(fresh.guardBroken, false, 'the ordinary lock-then-verify journey must stay green');
  const c = fresh.cases;
  for (const name of ['lockEmptyStore', 'verifyEmptyLock', 'verifyEmptyLockWarn']) {
    assert.equal(c[name].exit, 1, `${name} must exit 1 on the new tag`);
    assert.equal(c[name].reason, 'lock-pins-nothing', `${name} must carry the stable reason`);
  }
  assert.equal(c.lockEmptyStore.lockFileWritten, false, 'a refused lock must leave no file behind');
  assert.equal(c.guardRealLock.lock.exit, 0);
  assert.equal(c.guardRealLock.verify.exit, 0);
  assert.equal(c.guardRealLock.verify.pinned, 18, 'the real store must still pin all 18 programs');
});
