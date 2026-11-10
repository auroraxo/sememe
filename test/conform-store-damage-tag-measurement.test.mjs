// test/conform-store-damage-tag-measurement.test.mjs — the DELIVERY
// measurement of the conform store-damage defect.
//
// This file pins the committed artifact of
// tools/measure-conform-store-damage-tag.mjs:
//
//   research/conform-store-damage-tag-2026-11-10.json
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE WORKING-TREE MEASUREMENT
// (test/conform-store-damage-measurement.test.mjs):
//   The working-tree measurement asks whether THIS code refuses. It cannot
//   say what a stranger receives. This repo's most-repeated defect is exactly
//   that gap — "main fixed, the pin pointing behind it" — so the PUBLISHED
//   TAGS are installed into an empty directory and measured against the bytes
//   a stranger gets.
//
// WHAT THE MEASUREMENT FOUND:
//
//   v0.4.14 (the tag the README pinned until this release) carries the defect
//   on all THREE faces: a tampered receipt, a --store directory that does not
//   exist, and a store with objects/ but no receipts/ all exit 0 with rows
//   the report presents as an honest acquisition gap.
//
//   v0.4.15 refuses all three with a named reason (`store-reader-refused` /
//   `no-sememe-store`), while both controls — the genuine acquisition gap and
//   the real disagreement on an intact store — behave exactly as before.
//
// FALSIFICATION:
//   The artifact must show the OLD tag carrying the defect and the NEW tag
//   refusing it; a tag that could not be installed is never called clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'conform-store-damage-tag-2026-11-10.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

const byTag = Object.fromEntries(artifact.tags.map((t) => [t.tag, t]));
const DEFECT_FACES = ['damagedReceipt', 'missingStore', 'noReceiptsDir'];

test('the artifact carries both tags, none of them unmeasurable', () => {
  for (const tag of artifact.tags) {
    assert.equal(tag.error, undefined,
      `${tag.tag} must be measurable — an unmeasurable tag is never called clean`);
  }
  assert.ok(byTag['v0.4.14'], 'the artifact must cover the tag that carried the defect');
  assert.ok(byTag['v0.4.15'], 'the artifact must cover the tag that carries the fix');
  assert.equal(artifact.ok, true);
});

test('the OLD tag carries the defect on all three faces', () => {
  const old = byTag['v0.4.14'];
  assert.equal(old.verdict, 'carries-the-defect');
  assert.deepEqual(old.greenOverUnreadableStore, DEFECT_FACES,
    'all three faces of the defect must be visible on the old tag');
  assert.deepEqual(old.controlsBroken, [],
    'the old tag\'s controls must be intact — otherwise the defect comparison is meaningless');
  for (const name of DEFECT_FACES) {
    assert.equal(old.cases[name].exit, 0, `${name} must exit 0 on the old tag`);
    assert.equal(old.cases[name].refusalReason, null);
  }
  // The old tag still finds the REAL disagreement on an intact store: the
  // defect is the unreadable store, not a broken conformance path.
  assert.equal(old.cases.intactViolation.exit, 1);
  assert.deepEqual(old.cases.intactViolation.disagreementKinds,
    ['undeclared-signing-account']);
});

test('the NEW tag refuses all three faces and keeps both controls working', () => {
  const fresh = byTag['v0.4.15'];
  assert.equal(fresh.verdict, 'refuses');
  assert.deepEqual(fresh.greenOverUnreadableStore, [],
    'the new tag must never exit 0 over a store it could not read');
  assert.deepEqual(fresh.controlsBroken, [],
    'the honest gap and the real disagreement must keep their verdicts');
  const c = fresh.cases;
  assert.equal(c.damagedReceipt.exit, 1);
  assert.equal(c.damagedReceipt.refusalReason, 'store-reader-refused',
    'a tampered receipt is a reader refusal, named as such');
  assert.equal(c.missingStore.exit, 1);
  assert.equal(c.missingStore.refusalReason, 'no-sememe-store');
  assert.equal(c.noReceiptsDir.exit, 1);
  assert.equal(c.noReceiptsDir.refusalReason, 'no-sememe-store');
  // Controls: a program the store genuinely does not hold stays an honest
  // gap (exit 0), and a real disagreement on an intact store still exits 1.
  assert.equal(c.honestGap.exit, 0);
  assert.equal(c.intactViolation.exit, 1);
  assert.deepEqual(c.intactViolation.disagreementKinds,
    ['undeclared-signing-account']);
});

test('T-falsify: the roles of the two tags are not interchangeable', () => {
  // Tamper: pretend the old tag refuses and the new one is green.
  const swapped = {
    ...artifact,
    tags: artifact.tags.map((t) =>
      t.tag === 'v0.4.14' ? { ...t, verdict: 'refuses', greenOverUnreadableStore: [] }
                          : { ...t, verdict: 'carries-the-defect', greenOverUnreadableStore: DEFECT_FACES }),
  };
  const swappedByTag = Object.fromEntries(swapped.tags.map((t) => [t.tag, t]));
  assert.notEqual(swappedByTag['v0.4.14'].verdict, 'carries-the-defect');
  assert.notEqual(swappedByTag['v0.4.15'].verdict, 'refuses');
});

test('the artifact carries no host path (it is committed and read by others)', () => {
  const raw = readFileSync(ARTIFACT, 'utf8');
  for (const leak of ['/home/', '/tmp/', '/Users/', 'C:\\\\']) {
    assert.ok(!raw.includes(leak), `the artifact leaks a host path (${leak})`);
  }
});
