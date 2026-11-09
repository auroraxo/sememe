#!/usr/bin/env node
// tools/measure-conform-filter.mjs — DOES A FILTER THAT MATCHES NOTHING GET REFUSED?
//
// THE DEFECT THIS MEASURES (measured 2026-11-09, this host, from committed
// fixtures — no network):
//
// `sememe conform --only <program>` is a CI surface: exit 1 on any
// disagreement, exit 0 when the checked instructions agree with the store.
// Before the fix, `--only` could select ZERO instructions and still exit 0:
//
//   * `--only <program the transaction never invokes>` -> `rows: []`,
//     `summary.instructions: 0`, exit 0. The caller who mistyped the program
//     id they meant to gate on was told the transaction conformed.
//   * `--only <not-a-program-id>` -> the same empty green, and the value
//     could not even name a program: it was never validated as a program id.
//
// A gate that exits 0 over zero instructions is green over a check that
// never ran. This is the same class this repository has measured twice
// before (`sememe verify` green over a store the reader refuses, 2026-11-07;
// `conform` refusing unreadable shapes but not empty selections).
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/conform-filter-probe.mjs runs in the PRE-FIX tree — extracted
//      from git history with `git archive <prefix>`, the last commit before
//      the fix (stable forever, unlike "the previous commit"). The probe file
//      is COPIED into the extracted tree, so both trees run byte-identical
//      probe code; only the src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written: if
//      the refusals change because the code changed, the artifact changes.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * prefixGreenOverNothing — the pre-fix tree exits 0 with instructions 0
//     on a filter that selects nothing. Expected LARGE (that is the defect,
//     measured rather than asserted); the tool fails if it is 0, since a
//     baseline that shows no defect makes the fix unmeasurable.
//   * worktreeGreenOverNothing — the fixed tree exits 0 over a selection of
//     nothing. Must be 0: this is the green lie the fix exists to remove.
//   * worktreeRefusesMatchingFilter — the fixed tree refuses a filter that
//     DOES match an instruction, or refuses the unfiltered check. Must be 0:
//     the fix must not break the paths that were already correct.
//   * refusalReasonDrift — a case the worktree refuses for a DIFFERENT
//     reason than named in its own ladder test (reason names must stay
//     stable, or the CLI contract silently changes).
//   * guardRegression — the unfiltered run's exit code or instruction count
//     changed between trees (the fix must not touch the unfiltered path).
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-conform-filter.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'conform-filter-domain-2026-11-09.json'));
const PREFIX = flag('--prefix', '58d3228');

const PROBE = path.join(HERE, 'conform-filter-probe.mjs');
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
    // `git fetch origin <sha>` fails on servers that do not allow fetching a
    // raw SHA (GitHub answers "couldn't find remote ref"). A shallow checkout
    // — every CI runner starts with one — therefore cannot reach the prefix
    // commit by SHA: fetch the HISTORY, then recheck.
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
      throw new Unmeasurable(`the pre-fix commit ${commit} is neither local nor fetchable from origin (tried sha fetch, --unshallow, full fetch)`);
    }
  }
  const archive = spawnSync('git', ['archive', commit], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new Unmeasurable(`git archive ${commit} failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Unmeasurable(`extracting ${commit} failed: ${untar.stderr}`);
}

function runProbe(treeDir, label) {
  fs.mkdirSync(path.join(treeDir, 'tools'), { recursive: true });
  fs.copyFileSync(PROBE, path.join(treeDir, 'tools', 'conform-filter-probe.mjs'));
  const result = spawnSync(process.execPath, [path.join(treeDir, 'tools', 'conform-filter-probe.mjs')], {
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
  // keep only what the verdict depends on
  const cases = {};
  for (const [name, entry] of Object.entries(tree.cases ?? {})) {
    cases[name] = {
      library: { refused: entry.library.refused, reason: entry.library.reason },
      cli: { exit: entry.cli.exit, instructions: entry.cli.instructions, refusalReason: entry.cli.refusalReason },
    };
  }
  return { cases };
}

let prefixTree = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-prefix-'));
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

/** A case is "green over nothing" when the CLI printed no refusal and
 * reported zero checked instructions with a success exit. */
const greenOverNothing = (tree, name) => {
  const entry = tree.cases[name];
  return entry.cli.exit === 0 && (entry.cli.instructions ?? 0) === 0 && entry.library.refused === false;
};

const prefixGreenOverNothing = ['filterMiss', 'filterGarbage'].filter((n) => greenOverNothing(prefixTree, n));
const worktreeGreenOverNothing = ['filterMiss', 'filterGarbage'].filter((n) => greenOverNothing(worktree, n));

// The fixed tree must refuse both defect cases, with the reason its ladder names.
const expectedReasons = { filterMiss: 'filter-matched-no-instruction', filterGarbage: 'filter-is-not-a-program-id' };
const worktreeRefusals = {};
const refusalReasonDrift = [];
for (const [name, expected] of Object.entries(expectedReasons)) {
  const entry = worktree.cases[name];
  const refused = entry.library.refused && entry.cli.exit === 1;
  worktreeRefusals[name] = { refused, reason: entry.library.reason, cliReason: entry.cli.refusalReason };
  if (refused && entry.library.reason !== expected) refusalReasonDrift.push({ name, expected, got: entry.library.reason });
}

// Guards: paths that were already correct must still work in the fixed tree,
// and the unfiltered run must be untouched (same exit, same instruction count).
const matchCase = worktree.cases.match;
const noFilterCase = worktree.cases.noFilter;
const prefixNoFilter = prefixTree.cases.noFilter;
const worktreeRefusesMatchingFilter = matchCase.library.refused || matchCase.cli.exit !== 0;
const guardRegression =
  noFilterCase.cli.exit !== prefixNoFilter.cli.exit
  || (noFilterCase.cli.instructions ?? 0) !== (prefixNoFilter.cli.instructions ?? 0);

const prefixShowsNoDefect = prefixGreenOverNothing.length === 0;

const falsifications = {
  worktreeGreenOverNothingCount: worktreeGreenOverNothing.length,
  worktreeGreenOverNothing: worktreeGreenOverNothing,
  worktreeRefusesMatchingFilter,
  refusalReasonDrift,
  guardRegression,
  prefixShowsNoDefect,
};

const artifact = {
  tool: 'tools/measure-conform-filter.mjs',
  measuredAt: new Date().toISOString(),
  prefix: { commit: PREFIX, greenOverNothing: prefixGreenOverNothing },
  worktree: { greenOverNothing: worktreeGreenOverNothing, refusals: worktreeRefusals },
  cases: { prefix: prefixTree, worktree },
  falsifications,
  ok:
    falsifications.worktreeGreenOverNothingCount === 0
    && !falsifications.worktreeRefusesMatchingFilter
    && falsifications.refusalReasonDrift.length === 0
    && !falsifications.guardRegression
    && !falsifications.prefixShowsNoDefect,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({
  prefix: artifact.prefix,
  worktree: artifact.worktree,
  falsifications,
  ok: artifact.ok,
  out: path.relative(ROOT, OUT),
}, null, 2));

process.exit(artifact.ok ? 0 : 1);
