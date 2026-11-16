#!/usr/bin/env node
// tools/measure-file-input-voice.mjs — DOES THE PRODUCT ANSWER A CALLER'S
// WRONG PATH IN ITS OWN VOICE, OR IN THE KERNEL'S?
//
// THE DEFECT THIS MEASURES (measured 2026-11-16, this host, the PUBLISHED
// sememe@0.4.30 installed into an empty app):
//
// A caller names a FILE — the interface to adopt, the transaction to check,
// the lock to verify against, the file to write the lock to. When that path
// is wrong, the product answered with the KERNEL's error, verbatim, and on
// the channel reserved for "the work actually failed":
//
//   sememe conform /tmp/nope.json --store ./store
//     -> {"error":"ENOENT: no such file or directory, open '/tmp/nope.json'"}
//        exit 1
//
// Three measurable faults in one answer:
//   1. NO NAME — a syscall's prose, no code a script can branch on.
//   2. NO SUBJECT — `conform` did not even say WHICH argument was bad.
//   3. WRONG CHANNEL — a mistyped path shares exit 1 with a real refusal
//      (a drifted store, a tampered receipt), so a CI script cannot tell
//      "you pointed me at nothing" from "your store drifted".
//
// This is the one input class the product had not yet closed: every other
// refusal it makes is named (flags by src/cli-surface.mjs, stores and
// receipts by src/store-read.mjs, lock documents by src/lock.mjs), and this
// repo's sibling measured the same defect class on the sibling product's
// input files and fixed it the same way.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/file-input-voice-probe.mjs runs in the PRE-FIX tree — extracted
//      from git history with `git archive <prefix>`, the last commit before
//      the fix (stable forever, unlike "the previous commit"). The probe file
//      is COPIED into the extracted tree, so both trees run byte-identical
//      probe code; only the src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written:
//      if a refusal changes because the code changed, the artifact changes.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * preFixLeakedErrno — the pre-fix tree answers a wrong path with a raw
//     kernel errno. Expected LARGE (that is the defect); the tool fails if
//     it is 0, since a baseline showing no defect makes the fix unmeasurable.
//   * fixedLeakedErrno — the fixed tree still leaks an errno. Must be 0.
//   * fixedUnnamedFaces — a refusal with no product code. Must be 0.
//   * fixedRepairlessFaces — a refusal with no repair. Must be 0.
//   * fixedWrongChannelFaces — an IO refusal (nothing ran) still travelling
//     on exit 1. Must be 0.
//   * controlRegression — a control changed verdict between the trees.
//     Must be 0: the fix must not break the paths that already worked.
//   * hostPathLeak — the artifact quotes this host's absolute paths. Must
//     be 0 (the usual leak guard: research/ is committed).
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-file-input-voice.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'file-input-voice-2026-11-16.json'));
const PREFIX = flag('--prefix', '3ef9ca8');

const PROBE = path.join(HERE, 'file-input-voice-probe.mjs');
if (!fs.existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(2);
}

/** The 12 caller-named faces. `io` = nothing ran (usage/IO channel);
 *  `work` = the work ran and found the wrong bytes (work channel). */
const IO_FACES = [
  'adoptMissing', 'adoptDirectory', 'adoptUnreadable',
  'conformMissing', 'conformDirectory', 'conformUnreadable',
  'lockOutDirectory', 'verifyMissing', 'verifyDirectory', 'verifyUnreadable',
];
const WORK_FACES = ['adoptNotJson', 'conformNotJson'];
const CONTROLS = ['lockOutOk', 'conformOk', 'adoptOk'];
const FACES = [...IO_FACES, ...WORK_FACES];

function runProbe(tree) {
  const result = spawnSync(process.execPath, [path.join(tree, 'tools', 'file-input-voice-probe.mjs')], {
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

/** Tally what a set of faces did: which refusals leaked the kernel, which
 *  are unnamed, which carry no repair, which travelled on the wrong channel. */
function tally(cases) {
  const leakedErrno = [];
  const unnamed = [];
  const repairless = [];
  const wrongChannel = [];
  const detail = {};
  for (const name of FACES) {
    const face = cases[name];
    if (!face) { unnamed.push(name); continue; }
    detail[name] = {
      exit: face.exit,
      code: face.code,
      leakedErrno: face.leakedErrno,
      fix: face.fix ?? null,
    };
    if (face.leakedErrno.length) leakedErrno.push(name);
    if (!face.code) unnamed.push(name);
    if (!face.fix) repairless.push(name);
    // An IO refusal means NOTHING ran. Sharing exit 1 with the work's own
    // failures is the channel fault: a script cannot tell the two apart.
    if (IO_FACES.includes(name) && face.exit === 1) wrongChannel.push(name);
  }
  return { leakedErrno, unnamed, repairless, wrongChannel, detail };
}

/** The controls must answer the SAME way in both trees. */
function controlRegression(pre, post) {
  const changed = [];
  for (const name of CONTROLS) {
    const a = pre[name];
    const b = post[name];
    if (!a || !b) { changed.push(name); continue; }
    if (a.exit !== b.exit) changed.push(name);
    if (a.leakedErrno?.length !== b.leakedErrno?.length) changed.push(name);
    for (const key of ['lockWrote', 'verifyExit', 'answered', 'stored']) {
      if ((a[key] !== undefined || b[key] !== undefined) && a[key] !== b[key]) changed.push(name);
    }
  }
  return [...new Set(changed)];
}

// --- 1. the pre-fix tree, extracted by commit -------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-file-voice-pre-'));
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
fs.copyFileSync(PROBE, path.join(preTree, 'tools', 'file-input-voice-probe.mjs'));

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
  tool: 'tools/measure-file-input-voice.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  prefix: PREFIX,
  question: 'does a caller-named path that cannot be used get the product\'s own named refusal, or the kernel\'s errno?',
  faces: FACES,
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

// The falsification counts, stated as the artifact's own verdict.
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
  ? 'file-input-voice-closed' : 'file-input-voice-open';

// Leak guard: research/ is committed, so a host path in it would be a
// committed leak. Every path the artifact quotes is under a temp dir.
const serialized = JSON.stringify(artifact);
const hostLeak = serialized.includes(os.homedir()) ? 1 : 0;
artifact.hostPathLeak = hostLeak;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({ out: path.relative(ROOT, OUT), verdictName: artifact.verdictName, ...verdict, hostPathLeak: hostLeak }, null, 2));

const falsified = verdict.preFixLeakedErrno === 0 // the baseline shows no defect: unmeasurable
  || verdict.fixedLeakedErrno !== 0
  || verdict.fixedUnnamedFaces !== 0
  || verdict.fixedRepairlessFaces !== 0
  || verdict.fixedWrongChannelFaces !== 0
  || verdict.controlRegression !== 0
  || hostLeak !== 0;
process.exit(falsified ? 1 : 0);
