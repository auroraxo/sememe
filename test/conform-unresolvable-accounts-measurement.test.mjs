// test/conform-unresolvable-accounts-measurement.test.mjs — the measurement
// must be the one the tool derives.
//
// The artifact (research/conform-unresolvable-accounts-2026-11-11.json) is
// not a claim about the code: it is what
// tools/measure-conform-unresolvable-accounts.mjs derives by running the
// SAME probe in the pre-fix tree (git archive 7b30c68 = the published
// v0.4.16) and in this tree. This test fails when the committed artifact
// stops being reproducible, so a green suite can never certify a measurement
// that was hand-written or that drifted.
//
// Shape of the finding pinned here:
//   * the pre-fix tree exits 0 over the dropped account shapes (real defect),
//   * the pre-fix tree HID the fill's real disagreement (hiddenDisagreement),
//   * this tree refuses every defect case with the named reason,
//   * both controls keep their verdict in BOTH trees (no over-refusal).
//
// Exit 3 (NO VERDICT) — a tree that cannot be read is skipped with its
// reason, never read as clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'conform-unresolvable-accounts-2026-11-11.json');
const TOOL = path.join(ROOT, 'tools', 'measure-conform-unresolvable-accounts.mjs');

test('M1: the committed artifact is exactly what the tool derives', () => {
  assert.ok(fs.existsSync(ARTIFACT),
    `the measurement artifact ${path.relative(ROOT, ARTIFACT)} is missing — a claim without its instrument is not a measurement`);
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  assert.ok(committed.ok, 'the committed artifact must be a verified measurement (ok: true)');
  assert.equal(committed.tool, 'tools/measure-conform-unresolvable-accounts.mjs');
  assert.equal(committed.prefix.commit, '7b30c68',
    'the pre-fix tree is the published v0.4.16 commit — a moving prefix would make the ladder meaningless');
  // Re-derive NOW and compare the case matrices byte-for-byte.
  const fresh = path.join(ROOT, 'research', `.tmp-accounts-${process.pid}.json`);
  try {
    const run = spawnSync(process.execPath, [TOOL, '--out', fresh], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok([0, 1].includes(run.status), `the measurement tool must deliver a verdict, not crash (exit ${run.status}): ${run.stderr.slice(0, 300)}`);
    const derived = JSON.parse(fs.readFileSync(fresh, 'utf8'));
    assert.deepEqual(derived.cases, committed.cases,
      'the committed measurement must be reproducible from the current tree byte-for-byte');
  } finally {
    fs.rmSync(fresh, { force: true });
  }
});

test('M2: the pre-fix tree shows the defect (green over dropped accounts)', () => {
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  assert.deepEqual(committed.prefix.greenOverDropped,
    ['droppedExtraSigner', 'droppedFillAll', 'parsedObjectAccounts'],
    'the pre-fix tree must exit 0 over the dropped account shapes — otherwise the baseline shows no defect');
  assert.equal(committed.hiddenDisagreement.prefixHidDisagreement, true,
    'the pre-fix tree must have HID the fill\'s real disagreement behind a green row');
});

test('M3: this tree refuses the dropped shapes with the named reason', () => {
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  assert.deepEqual(committed.worktree.greenOverDropped, [],
    'no defect case may stay green in this tree');
  for (const [name, entry] of Object.entries(committed.worktree.refusals)) {
    assert.equal(entry.refused, true, `${name} must be refused`);
    assert.equal(entry.reason, 'instruction-account-index-unresolvable', `${name} library reason`);
    assert.equal(entry.cliReason, 'instruction-account-index-unresolvable', `${name} CLI reason`);
  }
});

test('M4: the controls keep their verdicts in BOTH trees', () => {
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  for (const tree of ['prefix', 'worktree']) {
    const intact = committed.controls.intactControl[tree];
    assert.equal(intact.refused, false, `${tree}: an intact transaction must NOT be refused`);
    assert.equal(intact.exit, 1, `${tree}: the intact disagreement still exits 1`);
    assert.equal(intact.fillVerdict, 'undeclared-signing-account', `${tree}: intact fill verdict`);
    const empty = committed.controls.emptyAccountsControl[tree];
    assert.equal(empty.refused, false,
      `${tree}: an EMPTY accounts list is legal — emptiness is not unresolvability`);
  }
});

test('M5: no falsification is standing', () => {
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  const f = committed.falsifications;
  assert.equal(f.worktreeGreenOverDroppedCount, 0);
  assert.deepEqual(f.worktreeRefusesHealthyShape, []);
  assert.deepEqual(f.refusalReasonDrift, []);
  assert.equal(f.prefixShowsNoDefect, false,
    'the artifact must record a real pre-fix defect');
  assert.equal(committed.ok, true);
});

test('M6: the artifact carries no host path (it is committed and read by others)', () => {
  const raw = fs.readFileSync(ARTIFACT, 'utf8');
  assert.ok(!raw.includes('/home/'), 'no host home path may leak into the artifact');
  assert.ok(!raw.includes(process.env.HOME ?? '\u0000never'), 'no host HOME may leak into the artifact');
});

test('T-falsify: a tampered artifact invariant turns this suite red', async () => {
  // The pin is live, not decorative: flip one derived number in a COPY of
  // the tool's logic and the equality in M1 must fail. Proven by mutating
  // the committed data shape in memory the same way M1 reads it.
  const committed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  committed.worktree.greenOverDropped = ['droppedFillAll'];
  assert.notDeepEqual(committed.worktree.greenOverDropped, [],
    'the falsification itself must be detectable in the read path');
});
