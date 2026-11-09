#!/usr/bin/env node
// tools/measure-drift-naming.mjs — IS A NAMING DIFFERENCE A LAYOUT DRIFT?
//
// THE DEFECT THIS MEASURES — measured 2026-11-09, on this host, from the
// committed fixtures (no network):
//
// Two verified copies of the same program can spell the same field
// differently: the on-chain Anchor copy says `lpMint`, `inAmount`,
// `totalAmount`; the published SDK copy says `lp_mint`, `in_amount`,
// `total_amount`. Both decode the SAME bytes to the SAME values.
//
// Before the normalised-pairing rule, `unionDecode`/`unionAccountDecode`
// compared the two decoded argument trees with RAW JSON equality. A spelling
// difference therefore produced the verdict `layout_drift` — "the two copies
// disagree about the data" — about a field that both copies agreed on:
//
//   * the instruction union reported `layout_drift` with ZERO differing
//     fields named (the report named no field at all);
//   * the account union listed the spelling differences among its paths, and
//     the 20-path cap filled with them, so the REAL differences on the same
//     rows never appeared in the report.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/drift-naming-probe.mjs runs in the PRE-FIX tree — extracted from
//      git history with `git archive 74ca535`, the last commit before the fix
//      (stable forever, unlike "the previous commit"). The probe file is
//      COPIED into the extracted tree, so both trees run byte-identical probe
//      code; only the src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written:
//      if the counts change because the code changed, the artifact changes.
//
// WHAT WOULD FALSIFY THE FIX (the probe counts these directly):
//
//   unjustifiedDriftRows — the tree says `layout_drift` while the INDEPENDENT
//     oracle (pairing by normalised spelling, implemented in the probe, not in
//     src/drift.mjs) finds only naming differences: a green alarm about
//     nothing. Must be 0 in the worktree.
//   hiddenRealDiffRows — the tree says `agree` while the oracle finds a real
//     value/shape/one-sided difference: the green lie the fix must not
//     introduce. Must be 0 in the worktree.
//   lostDriftRows / gainedDriftRows / refusals — a row may move from
//     layout_drift to agree and nowhere else; the fixed tree must not refuse
//     what the prefix tree decoded.
// On the PREFIX tree unjustifiedDriftRows is expected to be large — that is
// the defect, measured rather than asserted; the tool fails if it is 0, since
// a baseline that shows no defect makes the fix unmeasurable.
// The ladder in test/drift-naming.test.mjs pins individual cases; the account
// rows that still drift with named paths cover "a real difference stays a
// difference".
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
// 3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-drift-naming.mjs [--out <file>] [--prefix <commit>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};
const OUT = flag('--out', path.join(ROOT, 'research', 'drift-naming-2026-11-09.json'));
const PREFIX = flag('--prefix', '74ca535');

const PROBE = path.join(HERE, 'drift-naming-probe.mjs');
if (!fs.existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(3);
}

/** A tree that could not be read. Not a measurement failure: the caller
 * reports it as a named skip so CI never turns green over an unmeasured claim. */
class Unmeasurable extends Error {}

function extractPrefix(commit, dir) {
  const probe = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
  if (probe.status !== 0) {
    spawnSync('git', ['fetch', '--depth=50', 'origin', commit], { cwd: ROOT, stdio: 'ignore' });
    const recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    if (recheck.status !== 0) {
      throw new Unmeasurable(`the pre-fix commit ${commit} is neither local nor fetchable from origin`);
    }
  }
  const archive = spawnSync('git', ['archive', commit], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new Unmeasurable(`git archive ${commit} failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Unmeasurable(`extracting ${commit} failed: ${untar.stderr}`);
}

function runProbe(treeDir, label) {
  fs.mkdirSync(path.join(treeDir, 'tools'), { recursive: true });
  fs.copyFileSync(PROBE, path.join(treeDir, 'tools', 'drift-naming-probe.mjs'));
  const result = spawnSync(process.execPath, [path.join(treeDir, 'tools', 'drift-naming-probe.mjs')], {
    cwd: treeDir,
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, SEMEME_TREE_LABEL: label },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Unmeasurable(`the probe failed in the ${label} tree (exit ${result.status}): ${(result.stderr ?? '').slice(0, 400)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Unmeasurable(`the ${label} tree produced no parseable verdict: ${result.stdout.slice(0, 200)}`);
  }
}

// A row may move from layout_drift to agree and NOWHERE ELSE. The two runs
// must also have compared the SAME inputs, and the fixed tree must not refuse
// what the prefix tree decoded.
function verdictDrift(before, after) {
  const lost = [];
  const gained = [];
  for (let i = 0; i < before.programs.length; i += 1) {
    const b = before.programs[i];
    const a = after.programs[i];
    if (!a || b.name !== a.name) throw new Unmeasurable('the two runs covered different program sets');
    for (const half of ['instructions', 'accounts']) {
      const bh = b[half];
      const ah = a[half];
      const key = half === 'instructions' ? 'payloads' : 'accounts';
      if (bh[key] !== ah[key]) throw new Unmeasurable(`${b.name}/${half}: the runs compared different inputs (${bh[key]} vs ${ah[key]})`);
      const driftLost = (bh.driftRows ?? 0) - (ah.driftRows ?? 0);
      const driftGained = (ah.driftRows ?? 0) - (bh.driftRows ?? 0);
      const agreeGained = (ah.verdictCounts.agree ?? 0) - (bh.verdictCounts.agree ?? 0);
      if (driftGained > 0) gained.push(`${b.name}/${half}: ${driftGained} row(s) gained layout_drift`);
      if (driftLost > agreeGained) {
        lost.push(`${b.name}/${half}: ${driftLost} drift row(s) left layout_drift but only ${agreeGained} arrived at agree`);
      }
      if ((ah.refused ?? 0) > (bh.refused ?? 0)) {
        gained.push(`${b.name}/${half}: the fixed tree refused ${ah.refused - bh.refused} more input(s)`);
      }
    }
  }
  return { lost, gained };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-drift-prefix-'));
let report;
let exitCode = 0;
try {
  extractPrefix(PREFIX, scratch);
  const before = runProbe(scratch, `prefix-${PREFIX}`);
  const after = runProbe(ROOT, 'worktree');

  const changes = verdictDrift(before, after);

  // The probe's own ground truth, per tree.
  const prefixUnjustified = before.totals.instructionUnjustifiedDriftRows + before.totals.accountUnjustifiedDriftRows;
  const worktreeUnjustified = after.totals.instructionUnjustifiedDriftRows + after.totals.accountUnjustifiedDriftRows;
  const worktreeHidden = after.totals.instructionHiddenRealDiffRows + after.totals.accountHiddenRealDiffRows;

  // The oracle must be the SAME oracle in both runs: the probe file is
  // byte-copied, and its counts must agree between the two trees, or the two
  // runs were not asked the same question about the same inputs.
  const oracleIdentical = ['instructionOracleNamingOnly', 'instructionOracleRealDiff',
    'accountOracleNamingOnly', 'accountOracleRealDiff']
    .every((k) => before.totals[k] === after.totals[k]);

  const falsifications = {
    driftRowsLostWithoutAgree: changes.lost,
    driftRowsGained: changes.gained,
    worktreeUnjustifiedDriftRows: worktreeUnjustified,
    worktreeHiddenRealDiffRows: worktreeHidden,
    oracleDisagreesBetweenRuns: !oracleIdentical,
    prefixShowsNoDefect: prefixUnjustified === 0 && prefix.totals.instructionSpellingOnly === 0,
  };

  // Every drift row the FIXED tree still reports must name at least one
  // differing field — the green lie must not survive the fix.
  const fixedRowsNamingNoField = after.programs.reduce((n, p) =>
    n + p.instructions.driftRowsNamingNoField + p.accounts.driftRowsNamingNoField, 0);

  const ok = falsifications.driftRowsLostWithoutAgree.length === 0
    && falsifications.driftRowsGained.length === 0
    && falsifications.worktreeUnjustifiedDriftRows === 0
    && falsifications.worktreeHiddenRealDiffRows === 0
    && !falsifications.oracleDisagreesBetweenRuns
    && !falsifications.prefixShowsNoDefect
    && fixedRowsNamingNoField === 0
    // Every REAL difference the oracle finds must be NAMED by the fixed
    // tree's report: a real difference the report does not name is a
    // difference the reader never learns about.
    && after.totals.accountRealPathsUnnamed === 0
    && after.totals.instructionRealPathsUnnamed === 0;

  report = {
    measuredAt: new Date().toISOString(),
    claim: 'a field-name spelling difference is reported as NAMING, not as a disagreement about the data — measured on both trees with the same probe',
    method: {
      probe: 'tools/drift-naming-probe.mjs, byte-identical file copied into both trees',
      prefixTree: { commit: PREFIX, tree: 'extracted from git history with `git archive`' },
      worktreeTree: 'this working tree',
      fixtures: 'test/fixtures (committed), no network',
      store: 'on-chain copy as a pulled receipt under a synthetic slot, published copy via sememe adopt',
      slotKind: 'synthetic',
      slot: 466833000,
    },
    prefix: before,
    worktree: after,
    delta: {
      instructionDriftRows: {
        prefix: before.totals.instructionDriftRows,
        worktree: after.totals.instructionDriftRows,
      },
      instructionUnjustifiedDriftRows: {
        prefix: before.totals.instructionUnjustifiedDriftRows,
        worktree: after.totals.instructionUnjustifiedDriftRows,
      },
      instructionSpellingOnly: {
        prefix: before.totals.instructionSpellingOnly,
        worktree: after.totals.instructionSpellingOnly,
      },
      accountDriftRows: {
        prefix: before.totals.accountDriftRows,
        worktree: after.totals.accountDriftRows,
      },
      accountReportedPaths: {
        prefix: before.totals.accountReportedPaths,
        worktree: after.totals.accountReportedPaths,
      },
      accountSpellingOnly: {
        prefix: before.totals.accountSpellingOnly,
        worktree: after.totals.accountSpellingOnly,
      },
      accountRealPathsNamed: {
        prefix: before.totals.accountRealPathsNamed,
        worktree: after.totals.accountRealPathsNamed,
      },
      accountRealPathsCrowdedOut: {
        prefix: before.totals.accountRealPathsCrowdedOut,
        worktree: after.totals.accountRealPathsCrowdedOut,
      },
      accountRealPathsUnnamed: {
        prefix: before.totals.accountRealPathsUnnamed,
        worktree: after.totals.accountRealPathsUnnamed,
      },
    },
    falsifications: { ...falsifications, fixedRowsNamingNoField },    ok,
    limits: [
      'fixture bytes from the harvests named in the fixtures, not a live pull: this measures the decoder rule, not the current state of the chain',
      'the pairing normalises case and leading underscores; it does not decide which spelling is the CORRECT one — both spellings are reported',
      'a field only one copy declares is still a real difference and is still reported: naming normalisation does not make a missing field present',
      'the probe counts verdicts and report shapes; the ladder tests (test/drift-naming.test.mjs) pin the behaviour of individual cases',
      'pre-fix tree 74ca535 keeps its behaviour: tags and history are immutable, this measures what changed between two trees',
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`written: ${path.relative(ROOT, OUT)}`);
  console.log(`instruction drift rows: prefix ${report.delta.instructionDriftRows.prefix} -> worktree ${report.delta.instructionDriftRows.worktree}`);
  console.log(`instruction unjustified drift rows: prefix ${report.delta.instructionUnjustifiedDriftRows.prefix} -> worktree ${report.delta.instructionUnjustifiedDriftRows.worktree}`);
  console.log(`account drift rows: prefix ${report.delta.accountDriftRows.prefix} -> worktree ${report.delta.accountDriftRows.worktree}`);
  console.log(`account reported paths: prefix ${report.delta.accountReportedPaths.prefix} -> worktree ${report.delta.accountReportedPaths.worktree}`);
  console.log(`oracle: namingOnly ${after.totals.instructionOracleNamingOnly + after.totals.accountOracleNamingOnly}, realDiff ${after.totals.instructionOracleRealDiff + after.totals.accountOracleRealDiff}`);
  console.log(`unjustified drift rows: prefix ${prefixUnjustified} -> worktree ${worktreeUnjustified} (oracle says: naming only)`);
  console.log(`hidden real differences: worktree ${worktreeHidden}`);
  console.log(`real differences named by the report: prefix ${before.totals.accountRealPathsNamed + before.totals.instructionRealPathsNamed} -> worktree ${after.totals.accountRealPathsNamed + after.totals.instructionRealPathsNamed}`);
  console.log(`real differences crowded out by the path cap: prefix ${before.totals.accountRealPathsCrowdedOut + before.totals.instructionRealPathsCrowdedOut} -> worktree ${after.totals.accountRealPathsCrowdedOut + after.totals.instructionRealPathsCrowdedOut}`);
  console.log(`real differences the report never names: worktree ${after.totals.accountRealPathsUnnamed + after.totals.instructionRealPathsUnnamed}`);
  console.log(`falsifications: lost=${falsifications.driftRowsLostWithoutAgree.length} gained=${falsifications.driftRowsGained.length} unjustified=${worktreeUnjustified} hidden=${worktreeHidden}`);
  if (!ok) {
    console.error('NO VERDICT: a falsification count is non-zero — see the artifact');
    exitCode = 1;
  }
} catch (error) {
  if (error instanceof Unmeasurable) {
    console.error(`NO VERDICT: ${error.message}`);
    exitCode = 3;
  } else {
    console.error(`NO VERDICT: ${error.stack ?? error}`);
    exitCode = 3;
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
