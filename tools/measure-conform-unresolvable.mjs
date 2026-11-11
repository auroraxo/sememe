#!/usr/bin/env node
// tools/measure-conform-unresolvable.mjs — DOES THE CONFORMANCE GATE REPORT
// A TRANSACTION SUBSET WHEN AN INSTRUCTION HAS AN UNRESOLVABLE PROGRAM ID?
//
// THE DEFECT THIS MEASURES (measured 2026-11-11, this host, from committed
// fixtures — no network):
//
// `sememe conform <tx.json> --store <dir>` resolves an instruction's program
// either from `instruction.programId` or by index (`instruction.programIdIndex`)
// into the canonical key list. An out-of-range index resolves to null.
//
// In the pre-fix tree (git archive 94aa00b), the loop over instructions did:
//     for (const instruction of instructions) {
//       if (!instruction.programId) continue;
//
// The unresolvable instruction simply disappeared from `rows`, from
// `summary.instructions`, and from every verdict count.
//
// The worst face: on the order-engine fixture, pushing the fill
// instruction's index past the key list made the gate exit 0 over 11 of 12
// instructions, with `byVerdict {no-stored-interface: 11}`. The transaction's
// REAL finding (an undeclared signing account on the fill) was HIDDEN behind
// a report that looked complete.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same question):
//   1. tools/conform-unresolvable-probe.mjs runs in the PRE-FIX tree —
//      extracted from git history with `git archive <prefix>`.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written:
//      if the numbers change because the code changed, the artifact changes.
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-conform-unresolvable.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'conform-unresolvable-2026-11-11.json'));
const PREFIX = flag('--prefix', '94aa00b');

const PROBE = path.join(HERE, 'conform-unresolvable-probe.mjs');
if (!fs.existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(3);
}

class Unmeasurable extends Error {}

function extractPrefix(commit, dir) {
  const probe = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
  if (probe.status !== 0) {
    spawnSync('git', ['fetch', '--depth=50', 'origin', commit], { cwd: ROOT, stdio: 'ignore' });
    let recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    if (recheck.status !== 0) {
      spawnSync('git', ['fetch', '--unshallow', 'origin'], { cwd: ROOT, stdio: 'ignore' });
      recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    }
    if (recheck.status !== 0) {
      spawnSync('git', ['fetch', 'origin'], { cwd: ROOT, stdio: 'ignore' });
      recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    }
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
  fs.copyFileSync(PROBE, path.join(treeDir, 'tools', 'conform-unresolvable-probe.mjs'));
  const result = spawnSync(process.execPath, [path.join(treeDir, 'tools', 'conform-unresolvable-probe.mjs')], {
    cwd: treeDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Unmeasurable(`${label} probe failed (exit ${result.status}): ${String(result.stderr || '').slice(0, 400)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Unmeasurable(`${label} probe did not produce JSON: ${String(result.stdout || '').slice(0, 200)}`);
  }
}

function strip(tree) {
  const cases = {};
  for (const [name, entry] of Object.entries(tree.cases ?? {})) {
    cases[name] = {
      library: {
        refused: entry.library.refused,
        reason: entry.library.reason,
        rows: entry.library.rows,
        instructions: entry.library.instructions,
        droppedVisible: entry.library.droppedVisible ?? null,
      },
      cli: entry.cli ? {
        exit: entry.cli.exit,
        instructions: entry.cli.instructions,
        rows: entry.cli.rows,
        byVerdict: entry.cli.byVerdict,
        refusalReason: entry.cli.refusalReason,
      } : null,
      transactionInstructionCount: entry.transactionInstructionCount ?? null,
    };
  }
  return { cases };
}

let prefixTree = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-unresolvable-prefix-'));
try {
  extractPrefix(PREFIX, tmp);
  prefixTree = strip(runProbe(tmp, 'prefix'));
} catch (error) {
  if (error instanceof Unmeasurable) {
    console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: error.message }));
    process.exit(3);
  }
  throw error;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const worktree = strip(runProbe(ROOT, 'worktree'));

// --- derive the verdicts -------------------------------------------------

// The defect cases: transactions where at least one instruction cannot resolve.
// Pre-fix: silent partial report (exit 0). Post-fix: refused with exit 1.
const DEFECT_CASES = ['droppedFill', 'droppedCpi', 'droppedAppended'];
// Controls: transactions that must keep working.
const CONTROLS = ['intactControl', 'allDroppedControl'];

/** "Green over dropped instructions": the CLI exited 0 while the library
 * either did not refuse or dropped an instruction from the report. */
const greenOverDropped = (tree, name) => {
  const entry = tree.cases[name];
  if (!entry) return false;
  return entry.cli?.exit === 0 && entry.library?.refused === false;
};

const prefixGreenOverDropped = DEFECT_CASES.filter((n) => greenOverDropped(prefixTree, n));
const worktreeGreenOverDropped = DEFECT_CASES.filter((n) => greenOverDropped(worktree, n));

// The fixed tree must REFUSE every defect case with the named reason.
const expectedReason = 'instruction-program-id-unresolvable';
const worktreeRefusals = {};
const refusalReasonDrift = [];
for (const name of DEFECT_CASES) {
  const entry = worktree.cases[name];
  const refused = entry.library.refused && entry.cli?.exit === 1;
  worktreeRefusals[name] = { refused, reason: entry.library.reason, cliReason: entry.cli?.refusalReason };
  if (refused && entry.library.reason !== expectedReason) {
    refusalReasonDrift.push({ name, expected: expectedReason, got: entry.library.reason });
  }
}

// Guards: controls must not regress.
const worktreeRefusesHealthyStore = CONTROLS.filter((name) => {
  const entry = worktree.cases[name];
  if (name === 'intactControl') return !entry || entry.library.refused === true;
  if (name === 'allDroppedControl') {
    return !entry || entry.library.refused !== true
      || entry.library.reason !== 'transaction-has-no-resolvable-program-id';
  }
  return false;
});

// The harm, measured: on the pre-fix tree, breaking the fill instruction's
// index hid the undeclared-signing-account disagreement behind 11 green rows.
const prefixHiddenDisagreement =
  prefixTree.cases.droppedFill?.cli?.exit === 0
  && !prefixTree.cases.droppedFill?.cli?.byVerdict?.['undeclared-signing-account'];

const prefixShowsNoDefect = prefixGreenOverDropped.length === 0;

const falsifications = {
  worktreeGreenOverDroppedCount: worktreeGreenOverDropped.length,
  worktreeGreenOverDropped,
  worktreeRefusesHealthyStore,
  refusalReasonDrift,
  prefixShowsNoDefect,
};

const artifact = {
  tool: 'tools/measure-conform-unresolvable.mjs',
  measuredAt: new Date().toISOString(),
  prefix: { commit: PREFIX, greenOverDropped: prefixGreenOverDropped },
  worktree: { greenOverDropped: worktreeGreenOverDropped, refusals: worktreeRefusals },
  hiddenDisagreement: { prefixHidDisagreement: prefixHiddenDisagreement },
  cases: { prefix: prefixTree, worktree },
  falsifications,
  ok:
    falsifications.worktreeGreenOverDroppedCount === 0
    && falsifications.worktreeRefusesHealthyStore.length === 0
    && falsifications.refusalReasonDrift.length === 0
    && !falsifications.prefixShowsNoDefect,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({
  prefix: artifact.prefix,
  worktree: artifact.worktree,
  hiddenDisagreement: artifact.hiddenDisagreement,
  falsifications,
  ok: artifact.ok,
  out: path.relative(ROOT, OUT),
}, null, 2));

process.exit(artifact.ok ? 0 : 1);
