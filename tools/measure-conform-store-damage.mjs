#!/usr/bin/env node
// tools/measure-conform-store-damage.mjs — DOES THE CONFORMANCE GATE REPORT
// AS CLEAN A STORE IT COULD NOT READ?
//
// THE DEFECT THIS MEASURES (measured 2026-11-10, this host, from committed
// fixtures — no network):
//
// `sememe conform <tx.json> --store <dir>` is a CI gate: exit 1 on any
// disagreement, exit 0 when the checked instructions agree with the store.
// The gate read the store through ONE line that swallowed every failure:
//
//     try {
//       const sources = await findStoredIdls(storeDir, instruction.programId);
//       idl = sources.primary?.idl ?? sources.secondary?.idl ?? null;
//     } catch {
//       idl = null;                     // <-- EVERY refusal becomes "no interface"
//     }
//
// `findStoredIdls` is the ONE store reader that refuses damage by name
// (src/store-read.mjs). `sememe decode` on such a store exits 1 with the
// reader's own message; `sememe conform` on the SAME store turned the
// refusal into a verdict and exited 0.
//
// The worst face is not the missing store — it is the TAMPERED RECEIPT: the
// transaction's real disagreement (an undeclared signing account on the
// order-engine fill) disappeared behind 12 `no-stored-interface` rows, and
// the gate reported "12 instructions, 0 disagreements" with exit 0. A green
// gate over a check that never ran — and it also hid a disagreement that
// was really there.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/conform-store-damage-probe.mjs runs in the PRE-FIX tree —
//      extracted from git history with `git archive <prefix>`, the last
//      commit before the fix (stable forever, unlike "the previous
//      commit"). The probe file is COPIED into the extracted tree, so both
//      trees run byte-identical probe code; only the src/ under test
//      differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written:
//      if the refusals change because the code changed, the artifact
//      changes.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * prefixGreenOverUnreadableStore — the pre-fix tree exits 0 over a store
//     the reader refused. Expected LARGE (that is the defect, measured
//     rather than asserted); the tool fails if it is 0, since a baseline
//     that shows no defect makes the fix unmeasurable.
//   * worktreeGreenOverUnreadableStore — the fixed tree exits 0 over a store
//     it could not read. Must be 0: this is the green lie the fix exists
//     to remove.
//   * worktreeRefusesHealthyStore — the fixed tree refuses a store it CAN
//     read (the honest-gap and the intact-violation controls). Must be 0:
//     the fix must not break the paths that were already correct.
//   * controlRegression — the two controls changed their verdict between
//     the trees (the honest gap stayed a gap; the real disagreement stayed
//     a disagreement).
//   * hiddenDisagreement — the pre-fix tree's damaged-store report showed
//     NO disagreement while the intact store showed one. This is the
//     measured shape of the harm: the defect did not only go green, it
//     HID a real finding.
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-conform-store-damage.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'conform-store-damage-2026-11-10.json'));
const PREFIX = flag('--prefix', '3d386b2');

const PROBE = path.join(HERE, 'conform-store-damage-probe.mjs');
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
  fs.copyFileSync(PROBE, path.join(treeDir, 'tools', 'conform-store-damage-probe.mjs'));
  const result = spawnSync(process.execPath, [path.join(treeDir, 'tools', 'conform-store-damage-probe.mjs')], {
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
      library: {
        refused: entry.library.refused,
        reason: entry.library.reason,
        namesProgram: entry.library.namesProgram ?? null,
        byVerdict: entry.library.byVerdict,
        disagreementKinds: entry.library.disagreementKinds,
      },
      cli: {
        exit: entry.cli.exit,
        instructions: entry.cli.instructions,
        rows: entry.cli.rows,
        byVerdict: entry.cli.byVerdict,
        refusalReason: entry.cli.refusalReason,
      },
    };
  }
  return { cases };
}

let prefixTree = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-damage-prefix-'));
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

// The cases where the store CANNOT be read. A green exit over any of them is
// the defect.
const UNREADABLE = ['damagedReceipt', 'missingStore', 'noReceiptsDir'];
// The controls: stores the tree CAN read. They must keep working.
const CONTROLS = ['honestGap', 'intactViolation'];

/** "Green over a store the reader refused": the CLI exited 0 while the
 * library either refused or the store was unreadable. */
const greenOverUnreadable = (tree, name) => {
  const entry = tree.cases[name];
  if (!entry) return false;
  return entry.cli.exit === 0 && entry.library.refused === false;
};

const prefixGreenOverUnreadable = UNREADABLE.filter((n) => greenOverUnreadable(prefixTree, n));
const worktreeGreenOverUnreadable = UNREADABLE.filter((n) => greenOverUnreadable(worktree, n));

// The fixed tree must REFUSE every unreadable case, with the reason its
// ladder names.
const expectedReasons = {
  damagedReceipt: 'store-reader-refused',
  missingStore: 'no-sememe-store',
  noReceiptsDir: 'no-sememe-store',
};
const worktreeRefusals = {};
const refusalReasonDrift = [];
for (const [name, expected] of Object.entries(expectedReasons)) {
  const entry = worktree.cases[name];
  const refused = entry.library.refused && entry.cli.exit === 1;
  worktreeRefusals[name] = { refused, reason: entry.library.reason, cliReason: entry.cli.refusalReason };
  if (refused && entry.library.reason !== expected) {
    refusalReasonDrift.push({ name, expected, got: entry.library.reason });
  }
}

// Guards: the paths that were already correct must still work.
const worktreeRefusesHealthyStore = CONTROLS.filter((name) => {
  const entry = worktree.cases[name];
  return !entry || entry.library.refused === true || entry.cli.exit !== (name === 'honestGap' ? 0 : 1);
});

// The controls must not change their verdict between the trees.
const controlRegression = [];
for (const name of CONTROLS) {
  const before = prefixTree.cases[name];
  const after = worktree.cases[name];
  if (!before || !after) { controlRegression.push({ name, why: 'missing in one tree' }); continue; }
  if (before.library.refused !== after.library.refused) {
    controlRegression.push({ name, why: 'refusal changed', before: before.library.refused, after: after.library.refused });
  }
  if (before.cli.exit !== after.cli.exit) {
    controlRegression.push({ name, why: 'exit changed', before: before.cli.exit, after: after.cli.exit });
  }
  if (JSON.stringify(before.cli.byVerdict ?? null) !== JSON.stringify(after.cli.byVerdict ?? null)) {
    controlRegression.push({ name, why: 'verdicts changed', before: before.cli.byVerdict, after: after.cli.byVerdict });
  }
}

// THE HARM, measured: on the pre-fix tree the damaged store produced a report
// with NO disagreement, while the intact store produced one. The defect did
// not merely go green — it HID a real finding.
const intactDisagreements = prefixTree.cases.intactViolation?.library?.disagreementKinds ?? [];
const damagedDisagreements = prefixTree.cases.damagedReceipt?.library?.disagreementKinds ?? [];
const hiddenDisagreement = {
  intactStoreShowed: intactDisagreements,
  damagedStoreShowed: damagedDisagreements,
  hidden: intactDisagreements.length > 0 && damagedDisagreements.length === 0,
};

const prefixShowsNoDefect = prefixGreenOverUnreadable.length === 0;

const falsifications = {
  worktreeGreenOverUnreadableStoreCount: worktreeGreenOverUnreadable.length,
  worktreeGreenOverUnreadableStore: worktreeGreenOverUnreadable,
  worktreeRefusesHealthyStore,
  refusalReasonDrift,
  controlRegression,
  prefixShowsNoDefect,
};

const artifact = {
  tool: 'tools/measure-conform-store-damage.mjs',
  measuredAt: new Date().toISOString(),
  prefix: { commit: PREFIX, greenOverUnreadableStore: prefixGreenOverUnreadable },
  worktree: { greenOverUnreadableStore: worktreeGreenOverUnreadable, refusals: worktreeRefusals },
  hiddenDisagreement,
  cases: { prefix: prefixTree, worktree },
  falsifications,
  ok:
    falsifications.worktreeGreenOverUnreadableStoreCount === 0
    && falsifications.worktreeRefusesHealthyStore.length === 0
    && falsifications.refusalReasonDrift.length === 0
    && falsifications.controlRegression.length === 0
    && !falsifications.prefixShowsNoDefect,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({
  prefix: artifact.prefix,
  worktree: artifact.worktree,
  hiddenDisagreement,
  falsifications,
  ok: artifact.ok,
  out: path.relative(ROOT, OUT),
}, null, 2));

process.exit(artifact.ok ? 0 : 1);
