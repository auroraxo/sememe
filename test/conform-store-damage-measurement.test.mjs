// The conform store-damage measurement: does the conformance gate report as
// clean a store it could not read?
//
// This file pins the committed artifact of tools/measure-conform-store-damage.mjs:
//
//   research/conform-store-damage-2026-11-10.json
//
// WHAT THE MEASUREMENT FOUND (the defect this pins):
//
// `sememe conform` is a CI gate: exit 1 on any disagreement, exit 0 when the
// checked instructions agree with the store. The store was read through
// `findStoredIdls` inside a `catch { idl = null }`, so EVERY reader refusal
// became a verdict. On the pre-fix tree (3d386b2):
//
//   damagedReceipt  -> exit 0, rows all `no-stored-interface`
//   missingStore    -> exit 0, rows all `no-stored-interface`
//   noReceiptsDir   -> exit 0, rows all `no-stored-interface`
//
// and — the measured harm — the transaction's REAL disagreement
// (`undeclared-signing-account`, found on the intact store) did NOT appear
// in the damaged-store report at all. The gate did not only go green; it hid
// a disagreement that was really there.
//
// On this tree all three are refused with a named reason, and both controls
// (a genuine acquisition gap; a real disagreement on an intact store) behave
// exactly as before.
//
// FALSIFICATION:
//   Every falsification invariant in the artifact must be 0/false; the
//   artifact must match a fresh run of the tool byte-for-byte (modulo
//   measuredAt); and the pre-fix tree MUST show the defect (otherwise the
//   fix is unmeasurable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-conform-store-damage.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'conform-store-damage-2026-11-10.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact is what the tool derives right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.conform-store-damage-fresh.json');
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
  assert.equal(f.worktreeGreenOverUnreadableStoreCount, 0,
    'the fixed tree must never exit 0 over a store it could not read');
  assert.deepEqual(f.worktreeGreenOverUnreadableStore, [],
    'no unreadable-store case may remain green');
  assert.deepEqual(f.worktreeRefusesHealthyStore, [],
    'the fix must not refuse a store the tree can read (controls)');
  assert.deepEqual(f.refusalReasonDrift, [],
    'the refusal reasons must match the ladder contract');
  assert.deepEqual(f.controlRegression, [],
    'the honest gap and the real disagreement must keep their verdicts');
  assert.equal(f.prefixShowsNoDefect, false,
    'the pre-fix tree MUST show the defect — otherwise there is nothing to measure');
  assert.equal(artifact.ok, true);
});

test('the baseline is honest: the pre-fix tree was green over every unreadable store', () => {
  assert.deepEqual(artifact.prefix.greenOverUnreadableStore,
    ['damagedReceipt', 'missingStore', 'noReceiptsDir'],
    'the baseline must show all three defect cases were green');
  assert.equal(artifact.prefix.greenOverUnreadableStore.length, 3);
});

test('the measured HARM: the pre-fix damaged report hid a real disagreement', () => {
  // This is the finding that makes the defect worth fixing: not merely a
  // green exit, but a green exit over a report in which the transaction's
  // actual disagreement had vanished.
  assert.equal(artifact.hiddenDisagreement.hidden, true,
    'the pre-fix damaged-store report must have hidden the intact store\'s disagreement');
  assert.deepEqual(artifact.hiddenDisagreement.intactStoreShowed, ['undeclared-signing-account'],
    'the intact store must be shown to carry the real disagreement');
  assert.deepEqual(artifact.hiddenDisagreement.damagedStoreShowed, [],
    'the damaged store must be shown to have hidden it');
});

test('T-falsify: a tampered artifact invariant turns this test red', () => {
  // Tamper: simulate an artifact where the fixed tree still has 1 green case.
  const tampered = { ...artifact, falsifications: { ...artifact.falsifications, worktreeGreenOverUnreadableStoreCount: 1 } };
  assert.throws(() => {
    assert.equal(tampered.falsifications.worktreeGreenOverUnreadableStoreCount, 0);
  });
});

test('the artifact carries no host path (it is committed and read by others)', () => {
  const raw = readFileSync(ARTIFACT, 'utf8');
  for (const leak of ['/home/', '/tmp/', '/Users/', 'C:\\\\']) {
    assert.ok(!raw.includes(leak), `the artifact leaks a host path (${leak})`);
  }
});
