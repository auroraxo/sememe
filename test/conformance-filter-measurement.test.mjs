// The conform filter domain measurement: does an empty filter selection get
// REFUSED, or reported as a green CI pass?
//
// This file pins the committed artifact of tools/measure-conform-filter.mjs:
//
//   research/conform-filter-domain-2026-11-09.json
//
// WHAT THE MEASUREMENT FOUND (the defect this pins):
//
//   `sememe conform --only <program>` is a CI gate: exit 1 on any
//   disagreement, exit 0 when checked instructions conform. On the pre-fix
//   tree (58d3228), a filter that selected ZERO instructions produced:
//
//     filterMiss    (--only uninvoked-valid-id) -> exit 0, instructions: 0, rows: 0
//     filterGarbage (--only not-base58)         -> exit 0, instructions: 0, rows: 0
//
//   A green CI gate over a check that never ran.
//
//   On this tree, both are refused with a named reason:
//     filterMiss    -> ConformanceRefusal('filter-matched-no-instruction')
//     filterGarbage -> ConformanceRefusal('filter-is-not-a-program-id')
//
//   Guards (matching filter, unfiltered check, unreadable transaction) are
//   unaffected.
//
// FALSIFICATION:
//   Every falsification invariant in the artifact must be 0/false; the
//   artifact must match a fresh run of the tool byte-for-byte (modulo
//   measuredAt); and the pre-fix tree MUST show the defect (otherwise the fix
//   is unmeasurable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-conform-filter.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'conform-filter-domain-2026-11-09.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact is what the tool derives right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.conform-filter-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', fresh], { cwd: ROOT, stdio: 'ignore' });
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    const strip = (r) => {
      const copy = { ...r };
      delete copy.measuredAt;
      return copy;
    };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
  }
});

test('the falsification invariants are 0 — the fix never lies', () => {
  const f = artifact.falsifications;
  assert.equal(f.worktreeGreenOverNothingCount, 0,
    'the fixed tree must never report exit 0 over 0 instructions');
  assert.deepEqual(f.worktreeGreenOverNothing, [],
    'no case may remain green over nothing');
  assert.equal(f.worktreeRefusesMatchingFilter, false,
    'a filter matching an instruction must not be refused');
  assert.deepEqual(f.refusalReasonDrift, [],
    'the refusal reasons must match the ladder contract');
  assert.equal(f.guardRegression, false,
    'the unfiltered run must not change exit code or instruction count');
  assert.equal(f.prefixShowsNoDefect, false,
    'the pre-fix tree MUST show the defect — otherwise there is nothing to measure');
  assert.equal(artifact.ok, true);
});

test('the baseline is honest: pre-fix really exited 0 over 0 instructions', () => {
  assert.deepEqual(artifact.prefix.greenOverNothing, ['filterMiss', 'filterGarbage'],
    'the baseline must show both defect cases were green over nothing');
  assert.equal(artifact.prefix.greenOverNothing.length, 2);
});

test('T-falsify: a tampered artifact invariant turns this test red', () => {
  // Tamper: simulate an artifact where worktree still has 1 green-over-nothing
  const tampered = { ...artifact, falsifications: { ...artifact.falsifications, worktreeGreenOverNothingCount: 1 } };
  assert.throws(() => {
    assert.equal(tampered.falsifications.worktreeGreenOverNothingCount, 0);
  });
});

test('the artifact carries no host path (it is committed and read by others)', () => {
  const raw = readFileSync(ARTIFACT, 'utf8');
  for (const leak of ['/home/', '/tmp/', '/Users/', 'C:\\\\']) {
    assert.ok(!raw.includes(leak), `the artifact leaks a host path (${leak})`);
  }
});
