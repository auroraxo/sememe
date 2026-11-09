#!/usr/bin/env node
// tools/measure-lock-nothing-pinned.mjs — DOES LOCK/VERIFY GO GREEN OVER A
// LOCK THAT PINS NOTHING? (two-tree measurement)
//
// THE DEFECT THIS MEASURES (measured 2026-11-09, this host, from committed
// fixtures — no network):
//
// `sememe lock` + `sememe verify --mode error` is the CI gate the README
// tells a stranger to run after checkout. Two faces of ONE defect made that
// gate able to pass without checking anything:
//
//   * `sememe lock` on a store whose `receipts/` exists but is empty wrote
//     `{"lockVersion":1,"programs":{}}` and exited 0 — a lock file that
//     pins nothing and therefore can never detect drift.
//   * `sememe verify --mode error` against such a lock exited 0 with
//     `pinned: 0, violations: 0` against the REAL 18-program fixture store:
//     every program appeared as an `extra`, and extras are never violations,
//     so the report even LOOKED informative while certifying nothing.
//
// This is the same class this repository has measured three times:
// `verify` green over a store the reader refuses (2026-11-07), `conform
// --only` green over a filter selecting nothing (fixed in v0.4.13), and now
// `lock`/`verify` green over a lock pinning nothing.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/lock-nothing-pinned-probe.mjs runs in the PRE-FIX tree —
//      extracted from git history with `git archive <prefix>`, the last
//      commit before the fix (stable forever, unlike "the previous commit").
//      The probe file is COPIED into the extracted tree, so both trees run
//      byte-identical probe code; only the src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written: if
//      the refusals change because the code changed, the artifact changes.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * prefixShowsNoDefect — the pre-fix tree already refuses everything.
//     Expected FALSE (the defect exists); the tool fails if TRUE, since a
//     baseline that shows no defect makes the fix unmeasurable.
//   * worktreeGreenOverNothing — the fixed tree still exits 0 over a lock
//     pinning nothing (either face). Must be 0: this is the green lie.
//   * worktreeRefusalsMissing — a defect case that is NOT refused with
//     `lock-pins-nothing` in the fixed tree. Must be 0.
//   * refusalReasonDrift — a case the worktree refuses for a DIFFERENT
//     reason than named in its ladder test. Must be 0 (the reason name is
//     part of the CLI contract).
//   * guardRegression — the ordinary lock-then-verify journey changed exit
//     code or pinned count between trees. Must be false: the fix must not
//     break the path that was already correct.
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-lock-nothing-pinned.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'lock-nothing-pinned-2026-11-09.json'));
const PREFIX = flag('--prefix', 'f22dbf5');

const PROBE = path.join(HERE, 'lock-nothing-pinned-probe.mjs');
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
  fs.copyFileSync(PROBE, path.join(treeDir, 'tools', 'lock-nothing-pinned-probe.mjs'));
  const result = spawnSync(process.execPath, [path.join(treeDir, 'tools', 'lock-nothing-pinned-probe.mjs')], {
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
  const pick = (c) => ({
    exit: c.exit,
    reason: c.reason ?? null,
    pinned: c.pinned ?? null,
    violations: c.violations ?? null,
    ...(c.lockFileWritten === undefined ? {} : { lockFileWritten: c.lockFileWritten }),
    ...(c.lockPinnedPrograms === undefined ? {} : { lockPinnedPrograms: c.lockPinnedPrograms }),
  });
  const g = tree.cases.guardRealLock;
  return {
    cases: {
      lockEmptyStore: pick(tree.cases.lockEmptyStore),
      verifyEmptyLock: pick(tree.cases.verifyEmptyLock),
      verifyEmptyLockWarn: pick(tree.cases.verifyEmptyLockWarn),
      guardRealLock: { lock: pick(g.lock), verify: pick(g.verify) },
    },
  };
}

let prefixTree = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-lockpin-prefix-'));
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

/** Face 1: `sememe lock` succeeded over an empty store and wrote a file
 * pinning nothing. */
const lockGreenOverNothing = (tree) => {
  const c = tree.cases.lockEmptyStore;
  return c.exit === 0 && c.lockFileWritten === true && (c.lockPinnedPrograms ?? 0) === 0;
};
/** Face 2/3: `sememe verify` exited 0 over a lock pinning nothing. */
const verifyGreenOverNothing = (tree, key) => {
  const c = tree.cases[key];
  return c.exit === 0 && (c.pinned ?? 0) === 0 && (c.violations ?? 0) === 0;
};

const prefixGreenOverNothing = [
  ...(lockGreenOverNothing(prefixTree) ? ['lockEmptyStore'] : []),
  ...(verifyGreenOverNothing(prefixTree, 'verifyEmptyLock') ? ['verifyEmptyLock'] : []),
  ...(verifyGreenOverNothing(prefixTree, 'verifyEmptyLockWarn') ? ['verifyEmptyLockWarn'] : []),
];
const worktreeGreenOverNothing = [
  ...(lockGreenOverNothing(worktree) ? ['lockEmptyStore'] : []),
  ...(verifyGreenOverNothing(worktree, 'verifyEmptyLock') ? ['verifyEmptyLock'] : []),
  ...(verifyGreenOverNothing(worktree, 'verifyEmptyLockWarn') ? ['verifyEmptyLockWarn'] : []),
];

// The fixed tree must refuse all three defect cases with the reason its
// ladder test names.
const expectedReason = 'lock-pins-nothing';
const worktreeRefusals = {};
const worktreeRefusalsMissing = [];
const refusalReasonDrift = [];
for (const name of ['lockEmptyStore', 'verifyEmptyLock', 'verifyEmptyLockWarn']) {
  const c = worktree.cases[name];
  const refused = c.exit === 1 && c.reason !== null;
  worktreeRefusals[name] = { refused, reason: c.reason, exit: c.exit };
  if (!refused) worktreeRefusalsMissing.push({ name, exit: c.exit, reason: c.reason });
  else if (c.reason !== expectedReason) refusalReasonDrift.push({ name, expected: expectedReason, got: c.reason });
}

// Guards: the ordinary journey must keep working, in both trees.
const prefixGuard = prefixTree.cases.guardRealLock;
const worktreeGuard = worktree.cases.guardRealLock;
const guardRegression =
  worktreeGuard.lock.exit !== prefixGuard.lock.exit
  || worktreeGuard.verify.exit !== prefixGuard.verify.exit
  || (worktreeGuard.lock.lockPinnedPrograms ?? 0) !== (prefixGuard.lock.lockPinnedPrograms ?? 0)
  || worktreeGuard.lock.exit !== 0 || worktreeGuard.verify.exit !== 0;

const prefixShowsNoDefect = prefixGreenOverNothing.length === 0;

const falsifications = {
  worktreeGreenOverNothingCount: worktreeGreenOverNothing.length,
  worktreeGreenOverNothing,
  worktreeRefusalsMissingCount: worktreeRefusalsMissing.length,
  worktreeRefusalsMissing,
  refusalReasonDrift,
  guardRegression,
  prefixShowsNoDefect,
};

const artifact = {
  tool: 'tools/measure-lock-nothing-pinned.mjs',
  measuredAt: new Date().toISOString(),
  prefix: { commit: PREFIX, greenOverNothing: prefixGreenOverNothing, cases: prefixTree.cases },
  worktree: { greenOverNothing: worktreeGreenOverNothing, refusals: worktreeRefusals, cases: worktree.cases },
  falsifications,
  ok: !(
    falsifications.worktreeGreenOverNothingCount > 0
    || falsifications.worktreeRefusalsMissingCount > 0
    || falsifications.refusalReasonDrift.length > 0
    || falsifications.guardRegression
    || falsifications.prefixShowsNoDefect
  ),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.ok ? 0 : 1);
