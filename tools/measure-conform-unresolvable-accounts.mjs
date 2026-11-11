#!/usr/bin/env node
// tools/measure-conform-unresolvable-accounts.mjs — DOES THE CONFORMANCE
// GATE REPORT A TRANSACTION WHEN AN ACCOUNT INDEX DOES NOT RESOLVE?
//
// THE DEFECT THIS MEASURES (measured 2026-11-11, this host, from committed
// fixtures — no network):
//
// `sememe conform <tx.json> --store <dir>` resolves an instruction's account
// list by INDEX into the canonical key list (`keys[index]`). In the pre-fix
// tree (git archive 7b30c68 = the published v0.4.16) an index past the end
// resolved to `{address: null, signer: null, writable: null}`, and
// `checkAccountList` files a null signer under `unknownSigner` — a note,
// never a violation.
//
// The worst face: on the order-engine fixture, breaking the fill's ONE
// signing-extra account index downgraded
// `undeclared-signing-account` (exit 1) to `remaining-accounts` (exit 0) —
// the transaction's real disagreement HIDDEN behind a green report. The
// object-shaped (`jsonParsed`) transaction did the same for the whole file.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same question):
//   1. tools/conform-unresolvable-accounts-probe.mjs runs in the PRE-FIX
//      tree — extracted from git history with `git archive <prefix>`.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written:
//      if the numbers change because the code changed, the artifact changes.
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-conform-unresolvable-accounts.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'conform-unresolvable-accounts-2026-11-11.json'));
const PREFIX = flag('--prefix', '7b30c68');

const PROBE = path.join(HERE, 'conform-unresolvable-accounts-probe.mjs');
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
  fs.copyFileSync(PROBE, path.join(treeDir, 'tools', 'conform-unresolvable-accounts-probe.mjs'));
  const result = spawnSync(process.execPath, [path.join(treeDir, 'tools', 'conform-unresolvable-accounts-probe.mjs')], {
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
        fillVerdict: entry.library.fillVerdict ?? null,
        unknownSignerPositions: entry.library.unknownSignerPositions ?? null,
        byVerdict: entry.library.byVerdict,
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-accounts-prefix-'));
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

// The defect cases: account references that do not resolve.
// Pre-fix: green over the broken shape (exit 0, disagreement hidden).
// Post-fix: refused with the named reason.
const DEFECT_CASES = ['droppedExtraSigner', 'droppedFillAll', 'droppedCpi', 'parsedObjectAccounts'];
// Controls: shapes that must keep working in BOTH trees.
const CONTROLS = ['intactControl', 'emptyAccountsControl'];

const greenOverDropped = (tree, name) => {
  const entry = tree.cases[name];
  if (!entry) return false;
  return entry.cli?.exit === 0 && entry.library?.refused === false;
};

const prefixGreenOverDropped = DEFECT_CASES.filter((n) => greenOverDropped(prefixTree, n));
const worktreeGreenOverDropped = DEFECT_CASES.filter((n) => greenOverDropped(worktree, n));

// The fixed tree must REFUSE every defect case with the named reason.
const expectedReason = 'instruction-account-index-unresolvable';
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

// Guards: controls must not regress (no over-refusal, no verdict loss).
const worktreeRefusesHealthyShape = CONTROLS.filter((name) => {
  const entry = worktree.cases[name];
  return !entry || entry.library.refused === true;
});

// The harm, measured: on the pre-fix tree, breaking the signing extra's
// index turned exit 1 (undeclared-signing-account) into exit 0.
const prefixHiddenDisagreement = (() => {
  const intact = prefixTree.cases.intactControl;
  const broken = prefixTree.cases.droppedExtraSigner;
  return Boolean(
    intact?.cli?.exit === 1
    && intact?.library?.fillVerdict === 'undeclared-signing-account'
    && broken?.cli?.exit === 0
    && broken?.library?.fillVerdict !== 'undeclared-signing-account',
  );
})();

const prefixShowsNoDefect = prefixGreenOverDropped.length === 0;

const falsifications = {
  worktreeGreenOverDroppedCount: worktreeGreenOverDropped.length,
  worktreeGreenOverDropped,
  worktreeRefusesHealthyShape,
  refusalReasonDrift,
  prefixShowsNoDefect,
};

const ok = falsifications.worktreeGreenOverDroppedCount === 0
  && falsifications.worktreeRefusesHealthyShape.length === 0
  && falsifications.refusalReasonDrift.length === 0
  && !falsifications.prefixShowsNoDefect;

const artifact = {
  ok,
  tool: 'tools/measure-conform-unresolvable-accounts.mjs',
  measuredAt: new Date().toISOString().slice(0, 10),
  prefix: { commit: PREFIX, greenOverDropped: prefixGreenOverDropped },
  worktree: { greenOverDropped: worktreeGreenOverDropped, refusals: worktreeRefusals },
  hiddenDisagreement: {
    prefixHidDisagreement: prefixHiddenDisagreement,
    description: 'pre-fix: breaking the fill\'s signing-extra account index downgraded '
      + 'undeclared-signing-account (exit 1) to remaining-accounts (exit 0)',
  },
  controls: Object.fromEntries(CONTROLS.map((name) => [name, {
    prefix: prefixTree.cases[name] ? {
      refused: prefixTree.cases[name].library.refused,
      exit: prefixTree.cases[name].cli?.exit,
      fillVerdict: prefixTree.cases[name].library.fillVerdict,
    } : null,
    worktree: worktree.cases[name] ? {
      refused: worktree.cases[name].library.refused,
      exit: worktree.cases[name].cli?.exit,
      fillVerdict: worktree.cases[name].library.fillVerdict,
    } : null,
  }])),
  cases: { prefix: prefixTree, worktree },
  falsifications,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  ok,
  out: path.relative(ROOT, OUT),
  prefixGreenOverDropped,
  worktreeGreenOverDropped,
  prefixHiddenDisagreement,
  falsifications,
}, null, 2));
process.exit(ok ? 0 : 1);
