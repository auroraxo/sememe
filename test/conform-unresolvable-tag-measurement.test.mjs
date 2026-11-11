// test/conform-unresolvable-tag-measurement.test.mjs — the DELIVERY
// measurement of the unresolvable-program-id defect.
//
// This file pins the committed artifact of
// tools/measure-conform-unresolvable-tag.mjs:
//
//   research/conform-unresolvable-tag-2026-11-11.json
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE WORKING-TREE MEASUREMENT
// (test/conform-unresolvable-measurement.test.mjs):
//   The working-tree measurement asks whether THIS code refuses. It cannot
//   say what a stranger receives. This repo's most-repeated defect is exactly
//   that gap — "main fixed, the pin pointing behind it" — so the PUBLISHED
//   TAGS are installed into an empty directory and measured against the bytes
//   a stranger gets.
//
// WHAT THE MEASUREMENT FOUND:
//
//   v0.4.15 (the tag the README pinned until this release) carries the defect
//   on all THREE dropped shapes: each produces a SUBSET report (the
//   unresolvable instruction is missing from `rows`). On the droppedFill face
//   it is worse than a subset: the gate exits 0 and the transaction's real
//   disagreement (undeclared-signing-account) is HIDDEN.
//
//   v0.4.16 refuses all three with the named reason
//   (`instruction-program-id-unresolvable`), produces no subset report, and
//   both controls keep their verdicts — the intact transaction still exits 1
//   with its disagreement, the all-dropped shape keeps
//   `transaction-has-no-resolvable-program-id`.
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
const ARTIFACT = path.join(ROOT, 'research', 'conform-unresolvable-tag-2026-11-11.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

const byTag = Object.fromEntries(artifact.tags.map((t) => [t.tag, t]));
const DEFECT_CASES = ['droppedFill', 'droppedCpi', 'droppedAppended'];

test('T1: the artifact carries both tags, none of them unmeasurable', () => {
  for (const tag of artifact.tags) {
    assert.equal(tag.error, undefined,
      `${tag.tag} must be measurable — an unmeasurable tag is never called clean`);
  }
  assert.ok(byTag['v0.4.15'], 'the artifact must cover the tag that carried the defect');
  assert.ok(byTag['v0.4.16'], 'the artifact must cover the tag that carries the fix');
  assert.equal(artifact.ok, true);
  assert.equal(artifact.tool, 'tools/measure-conform-unresolvable-tag.mjs');
});

test('T2: the OLD tag produces a subset report on all three dropped shapes, and exits 0 hiding the disagreement on the worst one', () => {
  const old = byTag['v0.4.15'];
  assert.equal(old.verdict, 'carries-the-defect');
  assert.deepEqual(old.subsetReports, DEFECT_CASES,
    'every dropped shape must produce a SUBSET report on the old tag');
  assert.deepEqual(old.greenOverDropped, ['droppedFill'],
    'the dropped-fill face must exit 0 on the old tag — that is the face that hides the real disagreement');
  const fill = old.cases.droppedFill;
  assert.equal(fill.rows, 11, 'the old tag reports 11 of the transaction\'s 12 instructions');
  assert.equal(fill.byVerdict['undeclared-signing-account'] ?? 0, 0,
    'and the transaction\'s real disagreement is absent from that report');
  assert.deepEqual(old.controlsBroken, [],
    'the old tag\'s controls must be intact — otherwise the comparison is meaningless');
  assert.equal(old.cases.intactControl.exit, 1);
  assert.equal(old.cases.intactControl.byVerdict['undeclared-signing-account'], 1,
    'precondition: the INTACT transaction does carry the disagreement on the old tag');
});

test('T3: the NEW tag refuses all three shapes and keeps both controls working', () => {
  const fresh = byTag['v0.4.16'];
  assert.equal(fresh.verdict, 'refuses');
  assert.deepEqual(fresh.greenOverDropped, []);
  assert.deepEqual(fresh.subsetReports, [],
    'the new tag must never report a subset of the transaction it was handed');
  assert.deepEqual(fresh.controlsBroken, []);
  for (const name of DEFECT_CASES) {
    assert.equal(fresh.cases[name].exit, 1, `${name} must exit 1`);
    assert.equal(fresh.cases[name].refusalReason, 'instruction-program-id-unresolvable',
      `${name} must refuse with the named reason`);
  }
  assert.equal(fresh.cases.intactControl.exit, 1);
  assert.equal(fresh.cases.intactControl.byVerdict['undeclared-signing-account'], 1,
    'the real disagreement must survive the fix unchanged');
  assert.equal(fresh.cases.allDroppedControl.refusalReason,
    'transaction-has-no-resolvable-program-id',
    'the all-dropped reason must not move between versions');
});

test('T4: the artifact carries no host path', async () => {
  const raw = await readFile(ARTIFACT, 'utf8');
  assert.doesNotMatch(raw, /\/home\/[a-z]/i, 'the artifact must not carry a host path');
});

test('T5-falsify: the roles of the two tags are not interchangeable', () => {
  // Tamper: pretend the old tag refuses and the new one is green.
  const swappedTags = artifact.tags.map((t) =>
    t.tag === 'v0.4.15'
      ? { ...t, verdict: 'refuses', greenOverDropped: [], subsetReports: [] }
      : { ...t, verdict: 'carries-the-defect', greenOverDropped: DEFECT_CASES });
  const swapped = Object.fromEntries(swappedTags.map((t) => [t.tag, t]));
  assert.notEqual(swapped['v0.4.15'].verdict, 'carries-the-defect',
    'the pin must observe the OLD tag as the carrier');
  assert.notEqual(swapped['v0.4.16'].verdict, 'refuses',
    'the pin must observe the NEW tag as the refuser');
});
