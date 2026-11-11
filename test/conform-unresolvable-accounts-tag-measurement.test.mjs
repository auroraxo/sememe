// test/conform-unresolvable-accounts-tag-measurement.test.mjs — the DELIVERY
// measurement of the unresolvable-account-index defect.
//
// This file pins the committed artifact of
// tools/measure-conform-unresolvable-accounts-tag.mjs:
//
//   research/conform-unresolvable-accounts-tag-2026-11-11.json
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE WORKING-TREE MEASUREMENT
// (test/conform-unresolvable-accounts-measurement.test.mjs):
//   The working-tree measurement asks whether THIS code refuses. It cannot
//   say what a stranger receives. This repo's most-repeated defect is exactly
//   that gap — "main fixed, the pin pointing behind it" — so the PUBLISHED
//   TAGS are installed into an empty directory and measured against the bytes
//   a stranger gets.
//
// WHAT THE MEASUREMENT FOUND:
//
//   v0.4.16 (the tag the README pinned until this release) carries the
//   account defect on THREE dropped shapes: each exits 0. On the
//   droppedExtraSigner face it is worse than a partial report: the fill's
//   real disagreement (undeclared-signing-account) is GONE and the verdict is
//   `remaining-accounts` — the green gate hid it.
//
//   v0.4.17 refuses all four with the named reason
//   (`instruction-account-index-unresolvable`) and both controls keep their
//   verdicts — the intact transaction still exits 1 with its disagreement,
//   and the LEGAL empty-accounts shape is not refused (the over-refusal
//   detector).
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
const ARTIFACT = path.join(ROOT, 'research', 'conform-unresolvable-accounts-tag-2026-11-11.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

const byTag = Object.fromEntries(artifact.tags.map((t) => [t.tag, t]));
const DEFECT_CASES = ['droppedExtraSigner', 'droppedFillAll', 'droppedCpi', 'parsedObjectAccounts'];
const REASON = 'instruction-account-index-unresolvable';

test('T1: the artifact carries both tags, none of them unmeasurable', () => {
  for (const tag of artifact.tags) {
    assert.equal(tag.error, undefined,
      `${tag.tag} must be measurable — an unmeasurable tag is never called clean`);
  }
  assert.ok(byTag['v0.4.16'], 'the artifact must cover the tag that carried the defect');
  assert.ok(byTag['v0.4.17'], 'the artifact must cover the tag that carries the fix');
  assert.equal(artifact.ok, true);
  assert.equal(artifact.tool, 'tools/measure-conform-unresolvable-accounts-tag.mjs');
  assert.equal(byTag['v0.4.16'].installedVersion, '0.4.16', 'installed bytes match the tag name');
  assert.equal(byTag['v0.4.17'].installedVersion, '0.4.17', 'installed bytes match the tag name');
});

test('T2: the OLD tag exits 0 over the dropped shapes and hides the disagreement', () => {
  const old = byTag['v0.4.16'];
  assert.deepEqual(old.greenOverDropped,
    ['droppedExtraSigner', 'droppedFillAll', 'parsedObjectAccounts'],
    'v0.4.16 must show the defect — otherwise this delivery measurement proves nothing');
  assert.equal(old.verdict, 'carries-the-defect');
  const worst = old.cases.droppedExtraSigner;
  assert.equal(worst.exit, 0, 'the dropped signing-extra face exits 0 on the old tag');
  assert.notEqual(worst.fillVerdict, 'undeclared-signing-account',
    'the old tag HID the fill\'s real disagreement behind remaining-accounts');
});

test('T3: the NEW tag refuses all four shapes with the named reason', () => {
  const fresh = byTag['v0.4.17'];
  assert.deepEqual(fresh.greenOverDropped, [], 'no defect case may stay green on the new tag');
  assert.deepEqual(fresh.refusedWithNamedReason, DEFECT_CASES,
    'every defect case refuses with the exact reason name on the published bytes');
  assert.equal(fresh.verdict, 'refuses');
  for (const name of DEFECT_CASES) {
    assert.equal(fresh.cases[name].exit, 1, `${name}: exit 1 on the published v0.4.17`);
    assert.equal(fresh.cases[name].refusalReason, REASON, `${name}: reason name on the published bytes`);
  }
});

test('T4: both controls keep their verdicts on BOTH tags (no over-refusal)', () => {
  for (const tag of ['v0.4.16', 'v0.4.17']) {
    const cases = byTag[tag].cases;
    assert.equal(cases.intactControl.exit, 1, `${tag}: the intact disagreement still exits 1`);
    assert.equal(cases.intactControl.fillVerdict, 'undeclared-signing-account',
      `${tag}: intact fill verdict`);
    assert.notEqual(cases.emptyAccountsControl.refusalReason, REASON,
      `${tag}: an EMPTY accounts list is legal — emptiness is not unresolvability`);
    assert.deepEqual(byTag[tag].controlsBroken, [], `${tag}: no control may break`);
  }
});

test('T5: the artifact records a real old/new split, not two identical tags', () => {
  const old = byTag['v0.4.16'].verdict;
  const fresh = byTag['v0.4.17'].verdict;
  assert.equal(old, 'carries-the-defect');
  assert.equal(fresh, 'refuses');
  assert.notEqual(old, fresh, 'the delivery measurement must show the split it claims');
});
