#!/usr/bin/env node
// tools/measure-lock-voice.mjs — DOES THE LOCK SURFACE (THE CI GATE) NAME
// ITS REFUSALS, OR SPEAK PROSE?
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, this tree, and
// reproduced against the PUBLISHED sememe@0.4.34 installed into an empty
// app):
//
// The lock is the product's own CI gate — the README tells a stranger to run
// `npx sememe verify` after checkout. Every other refusal class in the
// product answers {error, code, fix} on a branchable channel; the lock
// answered prose only:
//
//   sememe verify --lock bad.lock  -> {"error":"sememe lock file bad.lock is
//                                      not JSON (lock-v1-parse)"}  exit 1
//   sememe verify --lock drift.lock -> {"error":"store does not match
//                                      sememe.lock (1 drifted, …)"} exit 1
//
// Three faults, the same three the path and damage classifiers ended:
// NO BRANCHABLE NAME (the reason sits inside the prose, or is absent
// altogether), NO REPAIR (nothing says what to run), and for the gate — the
// product's own CI answer — NO STRUCTURED DETAIL AT ALL (a pipeline must
// parse the sentence to tell "the store drifted" from "a receipt is
// damaged"). A fourth, narrower one: the receipt-integrity refusals minted a
// code but no repair, and the CLI prints code+fix only when BOTH are
// present, so the code was minted and dropped.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/lock-voice-probe.mjs runs in the PRE-FIX tree — extracted from
//      git history with `git archive <prefix>`, the last commit before the
//      fix (stable forever, unlike "the previous commit"). The probe file is
//      COPIED into the extracted tree, so both trees run byte-identical
//      probe code; only the src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * preFixUnnamedFaces     — the pre-fix tree has no branchable code.
//                              Expected LARGE; fails if 0 (a baseline with
//                              no defect makes the fix unmeasurable).
//   * preFixRepairlessFaces  — pre-fix refusals with no repair. Must be > 0
//                              for a meaningful baseline.
//   * fixedUnnamedFaces      — must be 0.
//   * fixedRepairlessFaces   — must be 0.
//   * fixedWrongChannelFaces — the work channel must hold (exit 1); the
//                              caller-path control stays out of this class.
//                              Must be 0.
//   * silentCodeFaces        — a code minted at the library without a
//                              repair (so the CLI drops it). Must be 0.
//   * controlRegression      — a control changed verdict between the trees.
//                              Must be 0.
//   * hostPathLeak           — the artifact quotes this host's paths.
//                              Must be 0 (research/ is committed).
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-lock-voice.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'lock-voice-2026-11-17.json'));
// The last commit BEFORE the fix: c356ab4 is the published v0.4.34 verify
// tree, the one the probe was measured against first.
const PREFIX = flag('--prefix', 'c356ab4');

const PROBE = path.join(HERE, 'lock-voice-probe.mjs');
if (!fs.existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(2);
}

/** The 13 lock-surface refusals. Each must stay on the WORK channel
 *  (exit 1): the file WAS read, the work ran, and the bytes were wrong. */
const FACES = [
  'lockDocNotJson', 'lockDocNotADocument', 'lockDocBadVersion', 'lockDocNoPrograms',
  'lockPinsNothing', 'lockEntryNotObject', 'lockBadFingerprint', 'lockBadOrigin',
  'storeMismatch', 'storeMissingProgram', 'storeUnverified',
  'lockTamperedReceipt', 'lockRelabelledReceipt',
];
/** The library-only class: a refusal whose code is minted without a repair
 *  (so the CLI channel, which prints code+fix only when BOTH are present,
 *  drops the code). */
const LIBRARY_FACES = ['tamperedReceipt', 'relabelledReceipt'];
/** Controls: they must answer the SAME way in both trees. */
const CONTROLS = ['greenGate', 'lockWrites', 'noStoreAnswer'];

function runProbe(tree) {
  const result = spawnSync(process.execPath, [path.join(tree, 'tools', 'lock-voice-probe.mjs')], {
    cwd: tree, encoding: 'utf8', timeout: 600000,
  });
  if (result.status !== 0) {
    return { ok: false, detail: `probe exited ${result.status}: ${String(result.stderr ?? '').slice(0, 300)}` };
  }
  try {
    const parsed = JSON.parse(String(result.stdout));
    return { ok: true, cases: parsed.cases, libraryFaces: parsed.libraryFaces ?? {} };
  } catch (error) {
    return { ok: false, detail: `probe output unreadable: ${String(error?.message ?? error)}` };
  }
}

/** Tally the refusal faces: which are unnamed, which carry no repair, which
 *  travelled on the wrong channel. */
function tally(cases) {
  const unnamed = [];
  const repairless = [];
  const wrongChannel = [];
  const detail = {};
  for (const name of FACES) {
    const face = cases[name];
    if (!face) { unnamed.push(name); repairless.push(name); wrongChannel.push(name); continue; }
    detail[name] = { exit: face.exit, code: face.code, fix: face.fix ?? null };
    if (!face.code) unnamed.push(name);
    if (!face.fix) repairless.push(name);
    // The contract: a lock document fault or a gate failure is the WORK
    // channel. Nothing ran only when the caller's PATH was wrong, and that
    // is a different classifier (src/file-input.mjs, exit 2).
    if (face.exit !== 1) wrongChannel.push(name);
  }
  return { unnamed, repairless, wrongChannel, detail };
}

/** The library class: code minted but repairless (so the CLI drops it). */
function tallyLibrary(libraryFaces) {
  const silent = [];
  const detail = {};
  for (const name of LIBRARY_FACES) {
    const face = libraryFaces[name];
    if (!face) { silent.push(name); continue; }
    detail[name] = { refused: face.refused, code: face.code, fix: face.fix, exitCode: face.exitCode };
    if (face.refused && face.code && !face.fix) silent.push(name);
  }
  return { silent, detail };
}

/** Controls answer the SAME way in both trees: same exit, same code, same
 *  answered verdict.
 *
 *  The one documented exception is the ANSWER controls' `code`: pre-fix the
 *  CLI dropped the minted code (null), post-fix it prints it
 *  (no-sememe-store) — that transition is the CLAIM of
 *  research/answer-voice-2026-11-17.json, measured by its own tool, not a
 *  regression of this one. The allowance is one-directional and exact: only
 *  null → the control's own answer code. Everything else here still fails —
 *  a repair appearing, the sentence disappearing, the channel moving, or a
 *  DIFFERENT code arriving. */
const ANSWER_CONTROL_CODES = { noStoreAnswer: 'no-sememe-store' };

function controlRegression(pre, post) {
  const changed = [];
  for (const name of CONTROLS) {
    const a = pre[name];
    const b = post[name];
    if (!a || !b) { changed.push(name); continue; }
    if (a.exit !== b.exit) changed.push(name);
    if ((a.code ?? null) !== (b.code ?? null)) {
      const expected = ANSWER_CONTROL_CODES[name];
      const documented = expected !== undefined
        && (a.code ?? null) === null && b.code === expected
        && (a.fix ?? null) === null && (b.fix ?? null) === null;
      if (!documented) changed.push(name);
    }
    if ((a.fix ?? null) !== (b.fix ?? null)) changed.push(name);
    if (a.answered !== b.answered) changed.push(name);
  }
  return [...new Set(changed)];
}

// --- 1. the pre-fix tree, extracted by commit -------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-lock-pre-'));
const preTree = path.join(work, 'pre');
fs.mkdirSync(preTree, { recursive: true });
const archive = spawnSync('git', ['archive', PREFIX], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
if (archive.status !== 0) {
  console.error(`git archive ${PREFIX} failed: ${String(archive.stderr).slice(0, 300)}`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(3);
}
spawnSync('tar', ['-x', '-C', preTree], { input: archive.stdout });
// The probe is COPIED in: both trees run byte-identical probe code, so the
// only thing that can differ between the runs is the src/ under test.
fs.copyFileSync(PROBE, path.join(preTree, 'tools', 'lock-voice-probe.mjs'));

// --- 2. both trees asked the same question ---------------------------------

const pre = runProbe(preTree);
const post = runProbe(ROOT);
fs.rmSync(work, { recursive: true, force: true });

if (!pre.ok || !post.ok) {
  console.error(`NO VERDICT: pre=${pre.ok ? 'ok' : pre.detail}; post=${post.ok ? 'ok' : post.detail}`);
  process.exit(3);
}

const preTally = tally(pre.cases);
const postTally = tally(post.cases);
const preLib = tallyLibrary(pre.libraryFaces);
const postLib = tallyLibrary(post.libraryFaces);
const controls = controlRegression(pre.cases, post.cases);

const artifact = {
  tool: 'tools/measure-lock-voice.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  prefix: PREFIX,
  question: 'does the lock surface — the product\'s own CI gate — name its refusals with a code and a repair, like every other refusal class in the product?',
  faces: FACES,
  libraryFaces: LIBRARY_FACES,
  controls: CONTROLS,
  preFix: {
    unnamedFaces: preTally.unnamed,
    repairlessFaces: preTally.repairless,
    wrongChannelFaces: preTally.wrongChannel,
    silentCodeFaces: preLib.silent,
    detail: preTally.detail,
    library: preLib.detail,
    controls: Object.fromEntries(CONTROLS.map((n) => [n, pre.cases[n]])),
  },
  fixed: {
    unnamedFaces: postTally.unnamed,
    repairlessFaces: postTally.repairless,
    wrongChannelFaces: postTally.wrongChannel,
    silentCodeFaces: postLib.silent,
    detail: postTally.detail,
    library: postLib.detail,
    controls: Object.fromEntries(CONTROLS.map((n) => [n, post.cases[n]])),
  },
  controlRegression: controls,
};

const verdict = {
  preFixUnnamedFaces: preTally.unnamed.length,
  preFixRepairlessFaces: preTally.repairless.length,
  preFixSilentCodeFaces: preLib.silent.length,
  fixedUnnamedFaces: postTally.unnamed.length,
  fixedRepairlessFaces: postTally.repairless.length,
  fixedWrongChannelFaces: postTally.wrongChannel.length,
  fixedSilentCodeFaces: postLib.silent.length,
  controlRegression: controls.length,
};
artifact.verdict = verdict;
artifact.verdictName = verdict.preFixUnnamedFaces > 0 && verdict.preFixRepairlessFaces > 0
  && verdict.fixedUnnamedFaces === 0 && verdict.fixedRepairlessFaces === 0
  && verdict.fixedWrongChannelFaces === 0 && verdict.fixedSilentCodeFaces === 0
  && verdict.controlRegression === 0
  ? 'lock-voice-closed' : 'lock-voice-open';

// Leak guard: research/ is committed, so a host path in it would be a
// committed leak. Two guards: the operator's HOME must not appear, and no
// absolute temp path may be committed either. The scrubbed text is what gets
// WRITTEN — the artifact on disk is the sanitized one.
const raw = JSON.stringify(artifact);
const hostLeak = raw.includes(os.homedir()) ? 1 : 0;
const sanitized = raw
  .replaceAll(os.homedir(), '<home>')
  .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>');
const hostPathLeak = sanitized.includes(os.homedir()) ? 1 : 0;
const tempPathLeak = (sanitized.match(/\/tmp\/[A-Za-z0-9._-]+/g) ?? []).length;
artifact.hostPathLeak = hostPathLeak;
artifact.tempPathLeak = tempPathLeak;
artifact.scrubbedTempPaths = (raw.match(/\/tmp\/[A-Za-z0-9._-]+/g) ?? []).length;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const finalText = `${JSON.stringify(artifact, null, 2)
  .replaceAll(os.homedir(), '<home>')
  .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>')}\n`;
fs.writeFileSync(OUT, finalText);

console.log(JSON.stringify({
  out: path.relative(ROOT, OUT),
  verdictName: artifact.verdictName,
  ...verdict,
  hostPathLeak,
  tempPathLeak,
  scrubbedTempPaths: artifact.scrubbedTempPaths,
}, null, 2));

const falsified = verdict.preFixUnnamedFaces === 0 // baseline shows no defect: unmeasurable
  || verdict.preFixRepairlessFaces === 0
  || verdict.fixedUnnamedFaces !== 0
  || verdict.fixedRepairlessFaces !== 0
  || verdict.fixedWrongChannelFaces !== 0
  || verdict.fixedSilentCodeFaces !== 0
  || verdict.controlRegression !== 0
  || hostPathLeak !== 0
  || tempPathLeak !== 0;
process.exit(falsified ? 1 : 0);
