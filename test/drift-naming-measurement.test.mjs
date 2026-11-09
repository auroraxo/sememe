// The drift-naming measurement: is a field-name spelling difference reported
// as NAMING, or as a disagreement about the DATA?
//
// This file pins the committed artifact of tools/measure-drift-naming.mjs:
//
//   research/drift-naming-2026-11-09.json
//
// WHAT THE MEASUREMENT FOUND (the point of pinning it):
//
//   Two verified copies of the same program can spell the same field
//   differently — the on-chain Anchor copy says `inAmount`, the published SDK
//   copy says `in_amount` — and both decode the SAME bytes to the SAME
//   values. Before the normalised-pairing rule, the union compared the two
//   decoded argument trees with RAW JSON equality, so a spelling difference
//   produced the verdict `layout_drift`: "the two copies disagree about the
//   data", said about a field both copies agreed on.
//
//   Measured over the committed mainnet harvests, with the SAME probe file
//   copied into the pre-fix tree (git archive 74ca535) and into this tree:
//
//     instruction payloads   3529      prefix drift rows   731 -> worktree    88
//     unjustified drift rows  prefix    630 (now 643)    -> worktree     0
//     hidden real differences                                    worktree     0
//     account rows              39      prefix drift rows    17 -> worktree    17
//     account real paths named  prefix     31              -> worktree    64
//     account real paths CROWDED OUT by the 20-path cap
//                               prefix     33              -> worktree     0
//
//   The account half is the part a reader should not take on trust: on the
//   pre-fix tree every one of the 11 meteora-damm-v1 account rows hit the
//   20-path cap (220 paths in total), and because the cap filled with
//   SPELLING differences, 33 REAL differences were crowded out of the report
//   entirely — the report did not under-report them, it did not contain them.
//
// THE INVARIANTS are the falsification half, and they must stay 0:
//   * unjustifiedDriftRows — the tree says `layout_drift` while the
//     INDEPENDENT oracle (implemented in the probe, not in src/drift.mjs)
//     finds only naming differences. A green alarm about nothing.
//   * hiddenRealDiffRows — the tree says `agree` while the oracle finds a
//     real value/shape/one-sided difference. The green lie the fix must not
//     introduce.
//   * drift rows lost or gained — a row may move from layout_drift to agree
//     and nowhere else; the fixed tree must not refuse what the prefix tree
//     decoded.
//   * the pre-fix tree MUST show the defect — a baseline that shows no
//     defect makes the fix unmeasurable, so the tool fails if it is 0.
//
// The suite's job: keep the fixed tree fixed AND keep the artifact honest —
// a hand-edited artifact that claimed a narrower defect than the tool derives
// would make this file prove nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-drift-naming.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'drift-naming-2026-11-09.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
const byName = Object.fromEntries(artifact.worktree.programs.map((p) => [p.name, p]));

test('the artifact is the one the tool produces right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.drift-naming-fresh.json');
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
  assert.equal(f.worktreeUnjustifiedDriftRows, 0,
    'the tree must never report layout_drift for a difference that is only a spelling difference');
  assert.equal(f.worktreeHiddenRealDiffRows, 0,
    'the tree must never report agree for a row that really differs');
  assert.deepEqual(f.driftRowsLostWithoutAgree, [],
    'no row may disappear from the report');
  assert.deepEqual(f.driftRowsGained, [],
    'no row may appear that the pre-fix tree did not report');
  assert.equal(f.fixedRowsNamingNoField, 0,
    'a fixed row must still name the field whose spelling differs');
  assert.equal(f.oracleDisagreesBetweenRuns, false,
    'the two runs must have used the same oracle');
  assert.equal(f.prefixShowsNoDefect, false,
    'the pre-fix tree MUST show the defect — otherwise there is nothing to measure');
  assert.equal(artifact.ok, true);
});

test('the headline is honest: the pre-fix tree really did lie about the data', () => {
  // The defect, as measured — not as asserted.
  assert.ok(artifact.delta.instructionUnjustifiedDriftRows.prefix >= 600,
    `expected the pre-fix tree to report hundreds of unjustified drift rows, got ${artifact.delta.instructionUnjustifiedDriftRows.prefix}`);
  assert.equal(artifact.delta.instructionUnjustifiedDriftRows.worktree, 0);
  assert.ok(artifact.delta.instructionDriftRows.prefix > artifact.delta.instructionDriftRows.worktree,
    'the fix must reduce the number of drift rows');
});

test('the account half: the real differences were crowded out, and now they are not', () => {
  assert.equal(artifact.delta.accountRealPathsCrowdedOut.prefix, 33,
    'on the pre-fix tree the 20-path cap hid 33 REAL account differences');
  assert.equal(artifact.delta.accountRealPathsCrowdedOut.worktree, 0,
    'the fixed tree must not crowd out a real difference');
  assert.equal(artifact.delta.accountRealPathsUnnamed.worktree, 0,
    'no real difference may go unnamed in the fixed tree');
  assert.ok(artifact.delta.accountRealPathsNamed.worktree > artifact.delta.accountRealPathsNamed.prefix,
    'the fixed tree must name MORE real differences than the pre-fix tree');
  assert.ok(artifact.delta.accountSpellingOnly.worktree > 0,
    'the naming differences must still be visible — moved to spellingOnly, not discarded');
});

test('the measurement covers every program with a two-copy interface', () => {
  assert.ok(artifact.worktree.programs.length >= 3,
    `expected several programs in the measurement, got ${artifact.worktree.programs.length}`);
  for (const name of ['pump.fun', 'meteora-damm-v1']) {
    assert.ok(byName[name], `the artifact must cover ${name}`);
    assert.ok(artifact.prefix.programs.some((p) => p.name === name),
      `the pre-fix tree must cover ${name} too — the same question, both trees`);
  }
});

test('the naming differences are still visible — moved to spellingOnly, not discarded', () => {
  // The fix must not trade a lie for a silence. On the fixed tree the rows
  // that used to be `layout_drift` are `agree`, and the naming difference
  // they carried is still reported, under `spellingOnly`.
  assert.ok(artifact.worktree.totals.instructionAgreeRowsNamingFieldDifferences > 0,
    'the fixed tree must report the naming differences on the rows it now calls agree');
  assert.ok(artifact.worktree.totals.instructionAgreeRowSpellingOnly > 0,
    'the naming differences must be listed, not dropped');
  assert.equal(artifact.worktree.totals.instructionHiddenRealDiffRows, 0);
});
