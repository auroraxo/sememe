#!/usr/bin/env node
// tools/measure-argument-voice.mjs — DOES A CALLER WHO FORGETS AN ARGUMENT
// GET THE PRODUCT'S OWN NAMED REFUSAL, OR A CODELESS PROSE ON THE WORK
// CHANNEL?
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/argument-voice-probe.mjs runs in the PRE-FIX tree — extracted
//      from git history with `git archive <prefix>`, the last commit before
//      the fix (stable forever, unlike "the previous commit"). The probe
//      file is COPIED into the extracted tree, so both trees run
//      byte-identical probe code; only the src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written:
//      if a refusal changes because the code changed, the artifact changes.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * preFixUnnamedFaces   — the pre-fix tree answers a forgotten argument
//                             with no product code. Expected LARGE (that is
//                             the defect); the tool FAILS if it is 0, since
//                             a baseline showing no defect makes the fix
//                             unmeasurable.
//   * preFixRepairlessFaces — same for the repair. Expected LARGE.
//   * preFixWrongChannelFaces — the pre-fix tree puts the caller's mistake
//                             on the WORK channel (exit 1), where it shares
//                             the code with a real refusal (a drifted store,
//                             a tampered receipt). Expected LARGE.
//   * fixedUnnamedFaces     — a refusal with no product code. Must be 0.
//   * fixedRepairlessFaces  — must be 0.
//   * fixedWrongChannelFaces — an argument refusal (nothing ran) still
//                             travelling on exit 1. Must be 0.
//   * controlRegression     — a control answered differently between the
//                             trees. Must be 0: the fix must not break the
//                             paths that already worked.
//   * hostPathLeak          — research/ is committed: an artifact that
//                             quotes this host's absolute paths must never
//                             be committed. Must be 0.
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-argument-voice.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'argument-voice-2026-11-18.json'));
// The last commit before the fix: the tree a stranger installs today.
const PREFIX = flag('--prefix', '55a5114');

const PROBE = path.join(HERE, 'argument-voice-probe.mjs');
if (!fs.existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(2);
}

/** The 26 argument faces. Each is a caller mistake about the INVOCATION.
 *  The list must cover EVERY row of src/argument-voice.mjs: a face that is
 *  declared but never probed is a face nobody measures. */
const FACES = [
  'pullMissingId', 'gapMissingId',
  'adoptMissingId', 'adoptMissingFile',
  'decodeMissingId', 'decodeMissingPayload',
  'decodeTrailingBadValue', 'decodeAbsentBadValue',
  'conformMissingFile',
  'decodeNativeTrailingBadValue', 'decodeTokenTrailingBadValue',
  'decodeRaydiumTrailingBadValue', 'decodeAtaTrailingBadValue',
  'decodeNativeMissingId', 'decodeNativeMissingPayload',
  'decodeTokenMissingId', 'decodeTokenMissingPayload',
  'decodeRaydiumMissingId', 'decodeRaydiumMissingPayload',
  'decodeAtaMissingId', 'decodeAtaMissingPayload', 'decodeAtaBothPayloads',
  'accountMissingId', 'accountMissingData', 'accountTrailingBadValue',
  'verifyModeBadValue',
];
const CONTROLS = [
  'absentHelpOk', 'nativeProvenanceOk', 'ataEmptyOk',
  'conformOnlyValid', 'conformOnlyMissingValue',
];

function runProbe(tree) {
  const result = spawnSync(process.execPath, [path.join(tree, 'tools', 'argument-voice-probe.mjs')], {
    cwd: tree, encoding: 'utf8', timeout: 600000,
  });
  if (result.status !== 0) {
    return { ok: false, detail: `probe exited ${result.status}: ${String(result.stderr ?? '').slice(0, 300)}` };
  }
  try {
    const parsed = JSON.parse(String(result.stdout));
    return { ok: true, cases: parsed.cases, controls: parsed.controls };
  } catch (error) {
    return { ok: false, detail: `probe output unreadable: ${String(error?.message ?? error)}` };
  }
}

/** Tally what a set of faces did: which refusals carry no code, which name no
 *  repair, which travelled on the wrong channel. */
function tally(cases) {
  const unnamed = [];
  const repairless = [];
  const wrongChannel = [];
  const detail = {};
  for (const name of FACES) {
    const face = cases[name];
    if (!face) { unnamed.push(name); continue; }
    detail[name] = { exit: face.exit, code: face.hasCode, fix: face.hasFix };
    if (!face.hasCode) unnamed.push(name);
    if (!face.hasFix) repairless.push(name);
    // An argument refusal means NOTHING ran. Sharing exit 1 with the work's
    // own failures is the channel fault: a script cannot tell "you called me
    // wrong" from "the store drifted".
    if (face.exit === 1) wrongChannel.push(name);
  }
  return { unnamed, repairless, wrongChannel, detail };
}

/** The controls must answer the SAME way in both trees. */
function controlRegression(pre, post) {
  const changed = [];
  for (const name of CONTROLS) {
    const a = pre[name];
    const b = post[name];
    if (!a || !b) { changed.push(name); continue; }
    if (a.exit !== b.exit) changed.push(name);
    if ((a.stderr ?? '') !== (b.stderr ?? '')) changed.push(name);
  }
  return [...new Set(changed)];
}

// --- 1. the pre-fix tree, extracted by commit -------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-arg-voice-pre-'));
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
fs.copyFileSync(PROBE, path.join(preTree, 'tools', 'argument-voice-probe.mjs'));

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
const controls = controlRegression(pre.controls, post.controls);

const artifact = {
  tool: 'tools/measure-argument-voice.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  prefix: PREFIX,
  question: 'does a forgotten or wrong argument get the product\'s own named refusal on the usage channel, or a codeless prose on the work channel?',
  faces: FACES,
  controls: CONTROLS,
  preFix: {
    unnamedFaces: preTally.unnamed,
    repairlessFaces: preTally.repairless,
    wrongChannelFaces: preTally.wrongChannel,
    detail: preTally.detail,
    controls: pre.controls,
  },
  fixed: {
    unnamedFaces: postTally.unnamed,
    repairlessFaces: postTally.repairless,
    wrongChannelFaces: postTally.wrongChannel,
    detail: postTally.detail,
    controls: post.controls,
  },
  controlRegression: controls,
};

const verdict = {
  preFixUnnamedFaces: preTally.unnamed.length,
  preFixRepairlessFaces: preTally.repairless.length,
  preFixWrongChannelFaces: preTally.wrongChannel.length,
  fixedUnnamedFaces: postTally.unnamed.length,
  fixedRepairlessFaces: postTally.repairless.length,
  fixedWrongChannelFaces: postTally.wrongChannel.length,
  controlRegression: controls.length,
};
artifact.verdict = verdict;
artifact.verdictName = verdict.preFixUnnamedFaces > 0
  && verdict.fixedUnnamedFaces === 0
  && verdict.fixedRepairlessFaces === 0
  && verdict.fixedWrongChannelFaces === 0
  && verdict.controlRegression === 0
  ? 'argument-voice-closed' : 'argument-voice-open';

// Leak guard: research/ is committed, so a host path in it would be a
// committed leak.
const serialized = JSON.stringify(artifact);
const hostLeak = serialized.includes(os.homedir()) ? 1 : 0;
artifact.hostPathLeak = hostLeak;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({ out: path.relative(ROOT, OUT), verdictName: artifact.verdictName, ...verdict, hostPathLeak: hostLeak }, null, 2));

const falsified = verdict.preFixUnnamedFaces === 0 // the baseline shows no defect: unmeasurable
  || verdict.fixedUnnamedFaces !== 0
  || verdict.fixedRepairlessFaces !== 0
  || verdict.fixedWrongChannelFaces !== 0
  || verdict.controlRegression !== 0
  || hostLeak !== 0;
process.exit(falsified ? 1 : 0);
