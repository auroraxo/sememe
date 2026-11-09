// The published-install measurement of the conform filter refusal.
//
// WHY A SECOND MEASUREMENT (tools/measure-conform-filter.mjs is the first):
//   The working-tree measurement asks whether THIS code refuses. It cannot
//   say what a stranger receives. This repo has measured that gap nine times
//   — "main fixed, the pin pointing behind it" — so the delivery is measured
//   against the PUBLISHED TAGS, installed into an empty directory.
//
// WHAT IT SHOWS (research/conform-filter-tag-2026-11-09.json):
//
//   v0.4.12 (the tag that was published when the defect was found)
//     --only <real program id the transaction never invokes>
//       -> exit 0, instructions 0, rows 0     <- a green gate over nothing
//     --only not-a-program-id
//       -> exit 0, instructions 0, rows 0     <- the same empty green
//
//   v0.4.13 (the tag that carries the fix)
//     --only <the same real program id>
//       -> exit 1, "conformance refused: filter-matched-no-instruction"
//     --only not-a-program-id
//       -> exit 1, "conformance refused: filter-is-not-a-program-id"
//
//   Controls on BOTH tags: a filter that matches still runs (5 rows, exit 0)
//   and the unfiltered check still checks every instruction (12 rows, exit 1
//   over the real disagreement). The fix did not break the working paths.
//
// FALSIFICATION:
//   The tool exits 3 (NO VERDICT) if a tag cannot be installed — an
//   unmeasured tag is never called clean. It exits 1 if the fix is not
//   demonstrably in the delivery (no tag refuses) or if no tag is shown to
//   have carried the defect (nothing was measured, so nothing was fixed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-conform-filter-tag.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'conform-filter-tag-2026-11-09.json');

const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
const tag = (name) => artifact.tags.find((t) => t.tag === name);

test('the published tag that carried the defect really exits 0 over nothing', () => {
  const before = tag('v0.4.12');
  assert.ok(before, 'the artifact must record the pre-fix tag');
  assert.equal(before.verdict, 'carries-the-defect');
  for (const name of ['filterMiss', 'filterGarbage']) {
    assert.equal(before.cases[name].exit, 0, `${name} on the published pre-fix tag must have exited 0`);
    assert.equal(before.cases[name].instructions, 0, `${name} on the published pre-fix tag must have checked 0 instructions`);
  }
});

test('the published tag that carries the fix refuses both, by name', () => {
  const after = tag('v0.4.13');
  assert.ok(after, 'the artifact must record the tag that carries the fix');
  assert.equal(after.verdict, 'refuses');
  assert.deepEqual(after.greenOverNothing, []);
  assert.deepEqual(after.controlsBroken, []);
  assert.equal(after.cases.filterMiss.exit, 1);
  assert.equal(after.cases.filterMiss.refusalReason, 'filter-matched-no-instruction');
  assert.equal(after.cases.filterGarbage.exit, 1);
  assert.equal(after.cases.filterGarbage.refusalReason, 'filter-is-not-a-program-id');
});

test('the controls work on BOTH tags — the fix did not break the working paths', () => {
  for (const name of ['v0.4.12', 'v0.4.13']) {
    const entry = tag(name);
    assert.ok(entry, `the artifact must record ${name}`);
    assert.equal(entry.cases.match.exit, 0, `${name}: a matching filter must still run`);
    assert.ok(entry.cases.match.instructions > 0, `${name}: a matching filter must still check instructions`);
    assert.ok(entry.cases.noFilter.instructions > 0, `${name}: the unfiltered check must still check instructions`);
  }
});

test('the artifact is what the tool derives right now (no hand-edited numbers)', { skip: process.env.SEMEME_TAG_MEASUREMENT === '1' ? false : 'network install: set SEMEME_TAG_MEASUREMENT=1' }, () => {
  const out = path.join(ROOT, 'research', '.conform-filter-tag-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', out], { cwd: ROOT, stdio: 'ignore', timeout: 900_000 });
    const produced = JSON.parse(readFileSync(out, 'utf8'));
    const strip = (r) => {
      const copy = JSON.parse(JSON.stringify(r));
      delete copy.measuredAt;
      return copy;
    };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    rmSync(out, { force: true });
  }
});
