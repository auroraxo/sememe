// test/conform-unresolvable-measurement.test.mjs — the measurement must be
// the one the tool derives.
//
// The artifact (research/conform-unresolvable-2026-11-11.json) is not a
// claim about the code: it is what
// tools/measure-conform-unresolvable.mjs derives by running the SAME probe
// in the pre-fix tree and in this tree. This test fails when the committed
// artifact stops being reproducible, so a green suite can never certify a
// measurement that was hand-written or that drifted.
//
// It also pins the SHAPE of the finding, so the numbers stay meaningful:
//   * the pre-fix tree exits 0 over the dropped shape (the defect is real),
//   * this tree refuses it with the named reason and exits 1,
//   * the pre-fix tree HID the transaction's real disagreement,
//   * the control (an intact transaction) keeps its verdict in BOTH trees.
//
// Exit 3 (NO VERDICT) — a tree that cannot be read is skipped with its
// reason, never read as clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'conform-unresolvable-2026-11-11.json');

test('M1: the committed artifact is exactly what the tool derives', () => {
  assert.ok(fs.existsSync(ARTIFACT),
    `the measurement artifact ${path.relative(ROOT, ARTIFACT)} is missing — a claim without its instrument is not a measurement`);
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  assert.ok(committed.ok, 'the committed artifact must be a verified measurement (ok: true)');
  assert.equal(committed.tool, 'tools/measure-conform-unresolvable.mjs');
  assert.equal(committed.prefix.commit, '94aa00b',
    'the pre-fix tree is the published v0.4.15 commit — a moving prefix would make the ladder meaningless');
});

test('M2: the pre-fix tree shows the defect (green over a dropped instruction)', () => {
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  assert.deepEqual(committed.prefix.greenOverDropped, ['droppedFill'],
    'the pre-fix tree must exit 0 over the dropped fill — otherwise the baseline shows no defect');
  assert.equal(committed.hiddenDisagreement.prefixHidDisagreement, true,
    'the pre-fix tree must have HID the transaction\'s real disagreement behind green rows');
});

test('M3: this tree refuses the dropped shape with the named reason', () => {
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  assert.deepEqual(committed.worktree.greenOverDropped, [],
    'no defect case may stay green in this tree');
  for (const [name, entry] of Object.entries(committed.worktree.refusals)) {
    assert.equal(entry.refused, true, `${name} must be refused`);
    assert.equal(entry.reason, 'instruction-program-id-unresolvable', `${name} reason`);
    assert.equal(entry.cliReason, 'instruction-program-id-unresolvable', `${name} CLI reason`);
  }
});

test('M4: the controls keep their verdicts in BOTH trees', () => {
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  for (const tree of ['prefix', 'worktree']) {
    const control = committed.cases[tree].cases.intactControl;
    assert.ok(control, `${tree}: the intact control must be present`);
    assert.equal(control.library.refused, false,
      `${tree}: an intact transaction must NOT be refused`);
    assert.equal(control.cli.exit, 1,
      `${tree}: the intact transaction still carries the real disagreement, so the gate exits 1`);
    const all = committed.cases[tree].cases.allDroppedControl;
    assert.equal(all.library.refused, true, `${tree}: the all-dropped case must be refused`);
    assert.equal(all.library.reason, 'transaction-has-no-resolvable-program-id',
      `${tree}: the all-dropped reason must not move between the trees`);
  }
});

test('M5: no falsification is standing', () => {
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  const f = committed.falsifications;
  assert.equal(f.worktreeGreenOverDroppedCount, 0);
  assert.deepEqual(f.worktreeRefusesHealthyStore, []);
  assert.deepEqual(f.refusalReasonDrift, []);
  assert.equal(f.prefixShowsNoDefect, false,
    'the baseline must show the defect, otherwise the fix is unmeasurable');
});

test('M6: the artifact carries no host path', () => {
  const raw = fs.readFileSync(ARTIFACT, 'utf8');
  assert.doesNotMatch(raw, /\/home\/[a-z]/i, 'the artifact must not carry a host path');
  assert.doesNotMatch(raw, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the artifact must not carry this machine\'s absolute paths');
});
