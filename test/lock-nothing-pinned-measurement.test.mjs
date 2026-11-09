// test/lock-nothing-pinned-measurement.test.mjs — the two-tree measurement
// of the lock-pins-nothing defect.
//
// This file pins the committed artifact of
// tools/measure-lock-nothing-pinned.mjs:
//
//   research/lock-nothing-pinned-2026-11-09.json
//
// WHAT THE MEASUREMENT FOUND (the defect this pins):
//
//   On the pre-fix tree (f22dbf5), `sememe lock` over a store with an empty
//   `receipts/` directory wrote `{"lockVersion":1,"programs":{}}` and exited
//   0, and `sememe verify --mode error` over that lock against the REAL
//   18-program fixture store exited 0 with `pinned: 0` — all three defect
//   cases green over a check that never ran. On this tree all three are
//   refused with `lock-pins-nothing`.
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
const TOOL = path.join(ROOT, 'tools', 'measure-lock-nothing-pinned.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'lock-nothing-pinned-2026-11-09.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact is what the tool derives right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.lock-nothing-pinned-fresh.json');
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
    'the fixed tree must never exit 0 over a lock pinning nothing');
  assert.deepEqual(f.worktreeGreenOverNothing, [],
    'no defect case may remain green over nothing');
  assert.equal(f.worktreeRefusalsMissingCount, 0,
    'every defect case must be refused in the fixed tree');
  assert.deepEqual(f.refusalReasonDrift, [],
    'the refusal reasons must match the ladder contract');
  assert.equal(f.guardRegression, false,
    'the ordinary lock-then-verify journey must not change exit code or pinned count');
  assert.equal(f.prefixShowsNoDefect, false,
    'the pre-fix tree MUST show the defect — otherwise there is nothing to measure');
  assert.equal(artifact.ok, true);
});

test('the baseline is honest: pre-fix really was green over nothing, on all three faces', () => {
  assert.deepEqual(artifact.prefix.greenOverNothing,
    ['lockEmptyStore', 'verifyEmptyLock', 'verifyEmptyLockWarn'],
    'the pre-fix tree must show all three faces of the defect');
  const pre = artifact.prefix.cases;
  assert.equal(pre.lockEmptyStore.exit, 0);
  assert.equal(pre.lockEmptyStore.lockFileWritten, true);
  assert.equal(pre.lockEmptyStore.lockPinnedPrograms, 0,
    'the pre-fix lock file pinned ZERO programs');
  assert.equal(pre.verifyEmptyLock.exit, 0);
  assert.equal(pre.verifyEmptyLock.pinned, 0,
    'the pre-fix verify claimed 0 pinned programs over a real store');
  assert.equal(pre.verifyEmptyLockWarn.exit, 0);
});

test('the fixed tree refuses all three faces with the stable reason name', () => {
  for (const name of ['lockEmptyStore', 'verifyEmptyLock', 'verifyEmptyLockWarn']) {
    const entry = artifact.worktree.refusals[name];
    assert.equal(entry.refused, true, `${name} must be refused`);
    assert.equal(entry.reason, 'lock-pins-nothing', `${name} must carry the stable reason`);
    assert.equal(entry.exit, 1, `${name} must exit 1`);
  }
  assert.equal(artifact.worktree.cases.lockEmptyStore.lockFileWritten, false,
    'a refused lock must leave no file behind');
});
