#!/usr/bin/env node
// tools/measure-store-damage-voice.mjs — DOES DAMAGE THE PRODUCT FINDS
// ITSELF GET THE PRODUCT'S NAMED REFUSAL, OR THE KERNEL'S ERRNO?
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, this tree, and
// reproduced against the PUBLISHED sememe@0.4.32 installed into an empty
// app):
//
// The caller-named PATH was closed twice (src/file-input.mjs on 2026-11-16,
// src/store-input.mjs on 2026-11-17): a wrong path gets a named code, a
// subject, a repair and the usage/IO channel. What stayed behind is the
// input the product finds ITSELF: the store path was right and the store
// turned out to be damaged. The reader refused it in the KERNEL's voice,
// with no code and no repair, and with the operator's home path in the
// message:
//
//   sememe decode <program> <payload> --store <store>
//     -> {"error":"store receipt <name>.json is unreadable: EACCES: permission
//         denied, open '/home/<user>/…/receipts/<name>.json'"}
//        exit 1
//
// Three faults, the same three the path classifiers ended: NO NAME (no code
// a script can branch on, no repair), NO SUBJECT (receipt damage and object
// damage told apart only by prose, though they have different repairs), and
// THE WRONG VOCABULARY (the kernel's errno quoted verbatim, plus a host
// path in a CI log).
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/store-damage-voice-probe.mjs runs in the PRE-FIX tree —
//      extracted from git history with `git archive <prefix>`, the last
//      commit before the fix (stable forever, unlike "the previous commit").
//      The probe file is COPIED into the extracted tree, so both trees run
//      byte-identical probe code; only the src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * preFixLeakedErrno — the pre-fix tree quotes the kernel. Expected
//     LARGE; the tool fails if it is 0 (a baseline with no defect makes the
//     fix unmeasurable).
//   * fixedLeakedErrno — the fixed tree still quotes the kernel. Must be 0.
//   * fixedUnnamedFaces — a refusal with no product code. Must be 0.
//   * fixedRepairlessFaces — a refusal with no repair. Must be 0.
//   * fixedWrongChannelFaces — a face on the wrong channel: a DAMAGE
//     refusal must keep exit 1 (the work ran and found broken bytes), and
//     the CALLER-PATH control must keep exit 2. Must be 0.
//   * controlRegression — a control changed verdict between the trees.
//     Must be 0.
//   * hostPathLeak — the artifact quotes this host's paths. Must be 0.
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-store-damage-voice.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'store-damage-voice-2026-11-17.json'));
const PREFIX = flag('--prefix', '9fe90e5');

const PROBE = path.join(HERE, 'store-damage-voice-probe.mjs');
if (!fs.existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(2);
}

/** The 11 damage faces. Each must stay on the WORK channel (exit 1): the
 *  store path the caller named was usable and the product found broken
 *  bytes in it. */
const DAMAGE_FACES = [
  'receiptIsFile', 'receiptUnreadable', 'receiptNotJson', 'receiptForeign',
  'receiptMalformed', 'objectIsFile', 'objectUnreadable', 'objectNotJson',
  'objectNoInstructions', 'objectMissing', 'objectRehash',
];
/** The controls: they must answer the SAME way in both trees. `exit`
 *  records the channel each control is expected to hold in BOTH trees. */
const CONTROLS = ['decodeOk', 'noStoreAnswer', 'noStoredIdlAnswer', 'callerPathVoice'];

function runProbe(tree) {
  const result = spawnSync(process.execPath, [path.join(tree, 'tools', 'store-damage-voice-probe.mjs')], {
    cwd: tree, encoding: 'utf8', timeout: 600000,
  });
  if (result.status !== 0) {
    return { ok: false, detail: `probe exited ${result.status}: ${String(result.stderr ?? '').slice(0, 300)}` };
  }
  try {
    return { ok: true, cases: JSON.parse(String(result.stdout)).cases };
  } catch (error) {
    return { ok: false, detail: `probe output unreadable: ${String(error?.message ?? error)}` };
  }
}

/** Tally what a set of damage faces did: which quoted the kernel, which are
 *  unnamed, which carry no repair, which travelled on the wrong channel. */
function tally(cases) {
  const leakedErrno = [];
  const unnamed = [];
  const repairless = [];
  const wrongChannel = [];
  const detail = {};
  for (const name of DAMAGE_FACES) {
    const face = cases[name];
    if (!face) { unnamed.push(name); wrongChannel.push(name); continue; }
    detail[name] = {
      exit: face.exit,
      code: face.code,
      fix: face.fix ?? null,
      leakedErrno: face.leakedErrno,
    };
    if (face.leakedErrno.length) leakedErrno.push(name);
    if (!face.code) unnamed.push(name);
    if (!face.fix) repairless.push(name);
    // The contract: damage is the WORK channel. A refusal that drifts onto
    // exit 2 would collide with "you pointed me at nothing" — the split the
    // store-input classifier established.
    if (face.exit !== 1) wrongChannel.push(name);
  }
  return { leakedErrno, unnamed, repairless, wrongChannel, detail };
}

/** The controls must answer the SAME way in both trees: same exit, same
 *  errno, same answer mark — and (for the CLI-channel controls) the same
 *  named code.
 *
 *  The one documented exception is the ANSWER controls' `code`: pre-fix the
 *  CLI dropped the minted code (null), post-fix it prints it — that
 *  transition is the CLAIM of research/answer-voice-2026-11-17.json,
 *  measured by its own tool, not a regression of this one. The allowance is
 *  one-directional and exact: only null → the control's own answer code,
 *  with no repair on either side. Everything else still fails — a repair
 *  appearing, the sentence or channel moving, a different code arriving. */
const ANSWER_CONTROL_CODES = {
  noStoreAnswer: 'no-sememe-store',
  noStoredIdlAnswer: 'no-stored-idl',
};

function controlRegression(pre, post) {
  const changed = [];
  for (const name of CONTROLS) {
    const a = pre[name];
    const b = post[name];
    if (!a || !b) { changed.push(name); continue; }
    if (a.exit !== b.exit) changed.push(name);
    if ((a.leakedErrno?.length ?? 0) !== (b.leakedErrno?.length ?? 0)) changed.push(name);
    if ((a.code ?? null) !== (b.code ?? null)) {
      const expected = ANSWER_CONTROL_CODES[name];
      const documented = expected !== undefined
        && (a.code ?? null) === null && b.code === expected
        && (a.fix ?? null) === null && (b.fix ?? null) === null;
      if (!documented) changed.push(name);
    }
    if ((a.answered !== undefined || b.answered !== undefined) && a.answered !== b.answered) changed.push(name);
  }
  return [...new Set(changed)];
}

// --- 1. the pre-fix tree, extracted by commit -------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-store-damage-pre-'));
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
fs.copyFileSync(PROBE, path.join(preTree, 'tools', 'store-damage-voice-probe.mjs'));

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
const controls = controlRegression(pre.cases, post.cases);

const artifact = {
  tool: 'tools/measure-store-damage-voice.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  prefix: PREFIX,
  question: 'does damage the store reader finds in a correctly named store get the product\'s own named refusal, or the kernel\'s errno?',
  faces: DAMAGE_FACES,
  controls: CONTROLS,
  preFix: {
    leakedErrnoFaces: preTally.leakedErrno,
    unnamedFaces: preTally.unnamed,
    repairlessFaces: preTally.repairless,
    wrongChannelFaces: preTally.wrongChannel,
    detail: preTally.detail,
    controls: Object.fromEntries(CONTROLS.map((n) => [n, pre.cases[n]])),
  },
  fixed: {
    leakedErrnoFaces: postTally.leakedErrno,
    unnamedFaces: postTally.unnamed,
    repairlessFaces: postTally.repairless,
    wrongChannelFaces: postTally.wrongChannel,
    detail: postTally.detail,
    controls: Object.fromEntries(CONTROLS.map((n) => [n, post.cases[n]])),
  },
  controlRegression: controls,
};

const verdict = {
  preFixLeakedErrno: preTally.leakedErrno.length,
  fixedLeakedErrno: postTally.leakedErrno.length,
  fixedUnnamedFaces: postTally.unnamed.length,
  fixedRepairlessFaces: postTally.repairless.length,
  fixedWrongChannelFaces: postTally.wrongChannel.length,
  controlRegression: controls.length,
};
artifact.verdict = verdict;
artifact.verdictName = verdict.preFixLeakedErrno > 0 && verdict.fixedLeakedErrno === 0
  && verdict.fixedUnnamedFaces === 0 && verdict.fixedRepairlessFaces === 0
  && verdict.fixedWrongChannelFaces === 0 && verdict.controlRegression === 0
  ? 'store-damage-voice-closed' : 'store-damage-voice-open';

// Leak guard: research/ is committed, so a host path in it would be a
// committed leak. Two guards: the operator's HOME must not appear (the
// store lives there), and no absolute temp path may be committed either
// (the controls quote the temp store they were asked about). The scrubbed
// text is what gets WRITTEN — the artifact on disk is the sanitized one.
const raw = JSON.stringify(artifact);
const hostLeak = raw.includes(os.homedir()) ? 1 : 0;
const sanitized = raw
  .replaceAll(os.homedir(), '<home>')
  .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>');
// The flags describe what the COMMITTED text still carries after the scrub:
// a non-zero value would mean a host path survived it.
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

const falsified = verdict.preFixLeakedErrno === 0 // the baseline shows no defect: unmeasurable
  || verdict.fixedLeakedErrno !== 0
  || verdict.fixedUnnamedFaces !== 0
  || verdict.fixedRepairlessFaces !== 0
  || verdict.fixedWrongChannelFaces !== 0
  || verdict.controlRegression !== 0
  || hostPathLeak !== 0
  || tempPathLeak !== 0;
process.exit(falsified ? 1 : 0);
