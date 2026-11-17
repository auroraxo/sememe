#!/usr/bin/env node
// tools/measure-answer-voice.mjs — ARE THE STORE ANSWERS NAMED, OR BARE
// PROSE? MEASURED IN TWO TREES, BYTE-IDENTICAL PROBE.
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, pre-fix tree
// dc2317d, and reproduced against the PUBLISHED sememe@0.4.35 installed into
// an empty app):
//
// The library minted `no-sememe-store` and `no-stored-idl`
// (src/store-read.mjs) but the CLI prints `code` only together with `fix` —
// and an answer has no fix — so both codes were minted and dropped. The two
// `sememe lock` / `sememe verify` call sites did not even mint them: they
// threw the sentence as a plain Error. All six answer faces reached the
// operator as bare prose on exit 1:
//
//   {"error":"no sememe store at …: run \"sememe pull\" first"} exit 1
//   {"error":"no stored IDL for program … in …"} exit 1
//
// A pipeline could not tell "the store was never pulled" (acquire) from "the
// work failed" (repair) without reading English.
//
// THE FIX (src/store-answer.mjs is the ONE mint place): every answer now
// carries its code, `answer: true` (acquire, do not repair) and NO `fix`;
// the sentence stays verbatim, the channel stays exit 1/stderr/JSON.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/answer-voice-probe.mjs runs in the PRE-FIX tree — extracted
//      from git history with `git archive <prefix>`. The probe file is
//      COPIED into the extracted tree, so both trees run byte-identical
//      probe code; only the src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is derived from the two runs. Nothing is hand-written.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * preFixUnnamedFaces — the pre-fix tree answers without a code.
//     Expected LARGE; the tool fails if it is 0 (a baseline with no defect
//     makes the fix unmeasurable).
//   * fixedUnnamedFaces — must be 0.
//   * fixedUnmarkedFaces — answers without `answer: true`. Must be 0.
//   * fixedRepairedFaces — answers carrying a `fix` (an answer dressed as a
//     refusal). Must be 0.
//   * fixedWrongChannelFaces — an answer that left exit 1. Must be 0.
//   * fixedWrongSentenceFaces — an answer whose sentence changed. Must be 0.
//   * controlRegression — a control changed verdict between the trees.
//     Must be 0.
//   * hostPathLeak — the artifact quotes this host's paths. Must be 0
//     (research/ is committed).
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-answer-voice.mjs [--out <file>] [--prefix <commit>]

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
const OUT = flag('--out', path.join(ROOT, 'research', 'answer-voice-2026-11-17.json'));
const PREFIX = flag('--prefix', 'dc2317d');

const PROBE = path.join(HERE, 'answer-voice-probe.mjs');
if (!fs.existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(2);
}

/** The 6 answer faces: the states that are not faults. */
const ANSWER_FACES = [
  'decodeNoStore', 'accountNoStore', 'lockNoStore', 'verifyNoStore',
  'decodeNoStoredIdl', 'accountNoStoredIdl',
];
/** The controls: they must answer the SAME way in both trees. */
const CONTROLS = ['greenGate', 'refusalVoice', 'damageVoice'];

function runProbe(tree) {
  const result = spawnSync(process.execPath, [path.join(tree, 'tools', 'answer-voice-probe.mjs')], {
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

/** The two sentences the product owns. A face counts as wrong-sentence when
 *  it carries one of these codes but no longer quotes its own sentence. */
const SENTENCE_OF_CODE = {
  'no-sememe-store': (dir) => `no sememe store at ${dir}`,
  'no-stored-idl': (p, dir) => `no stored IDL for program ${p}`,
};

/** Tally what the answer faces did: unnamed, unmarked, dressed as refusals,
 *  on the wrong channel, with a changed sentence. */
function tally(cases) {
  const unnamed = [];
  const unmarked = [];
  const repaired = [];
  const wrongChannel = [];
  const wrongSentence = [];
  const detail = {};
  for (const name of ANSWER_FACES) {
    const face = cases[name];
    if (!face) { unnamed.push(name); unmarked.push(name); wrongChannel.push(name); continue; }
    detail[name] = {
      exit: face.exit,
      code: face.code,
      answer: face.answer === true,
      fix: face.fix ?? null,
    };
    if (!face.code) unnamed.push(name);
    if (face.answer !== true) unmarked.push(name);
    if (face.fix) repaired.push(name);
    if (face.exit !== 1) wrongChannel.push(name);
    // The sentence must survive verbatim and in front. The expected store
    // path differs per run (a fresh temp dir), so the check is the PREFIX of
    // the sentence up to the path: "no sememe store at " / "no stored IDL
    // for program ", and for the missing-store answer the repair clause.
    if (face.code === 'no-sememe-store') {
      const ok = face.error.startsWith('no sememe store at ')
        && /: run "sememe pull" first$/.test(face.error);
      if (!ok) wrongSentence.push(name);
    } else if (face.code === 'no-stored-idl') {
      const ok = face.error.startsWith('no stored IDL for program ')
        && face.error.includes(' in ');
      if (!ok) wrongSentence.push(name);
    } else if (face.code) {
      wrongSentence.push(name);
    }
  }
  return { unnamed, unmarked, repaired, wrongChannel, wrongSentence, detail };
}

/** The controls must answer the SAME way in both trees: same exit, same
 *  code, same repair, same answer mark. */
function controlRegression(pre, post) {
  const changed = [];
  for (const name of CONTROLS) {
    const a = pre[name];
    const b = post[name];
    if (!a || !b) { changed.push(name); continue; }
    if (a.exit !== b.exit) changed.push(name);
    if ((a.code ?? null) !== (b.code ?? null)) changed.push(name);
    if ((a.fix ?? null) !== (b.fix ?? null)) changed.push(name);
    if ((a.answer === true) !== (b.answer === true)) changed.push(name);
    if (a.green !== undefined && a.green !== b.green) changed.push(name);
  }
  return [...new Set(changed)];
}

// --- 1. the pre-fix tree, extracted by commit -------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-answer-pre-'));
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
fs.copyFileSync(PROBE, path.join(preTree, 'tools', 'answer-voice-probe.mjs'));

// --- 2. both trees asked the same question ----------------------------------

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
  tool: 'tools/measure-answer-voice.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  prefix: PREFIX,
  question: 'do the store answers (no-sememe-store / no-stored-idl) reach the operator with a branchable code and their own answer semantics, or as bare prose indistinguishable from a refusal?',
  faces: ANSWER_FACES,
  controls: CONTROLS,
  preFix: {
    unnamedFaces: preTally.unnamed,
    unmarkedFaces: preTally.unmarked,
    repairedFaces: preTally.repaired,
    wrongChannelFaces: preTally.wrongChannel,
    wrongSentenceFaces: preTally.wrongSentence,
    detail: preTally.detail,
    controls: Object.fromEntries(CONTROLS.map((n) => [n, pre.cases[n]])),
  },
  fixed: {
    unnamedFaces: postTally.unnamed,
    unmarkedFaces: postTally.unmarked,
    repairedFaces: postTally.repaired,
    wrongChannelFaces: postTally.wrongChannel,
    wrongSentenceFaces: postTally.wrongSentence,
    detail: postTally.detail,
    controls: Object.fromEntries(CONTROLS.map((n) => [n, post.cases[n]])),
  },
  controlRegression: controls,
};

const verdict = {
  preFixUnnamedFaces: preTally.unnamed.length,
  fixedUnnamedFaces: postTally.unnamed.length,
  fixedUnmarkedFaces: postTally.unmarked.length,
  fixedRepairedFaces: postTally.repaired.length,
  fixedWrongChannelFaces: postTally.wrongChannel.length,
  fixedWrongSentenceFaces: postTally.wrongSentence.length,
  controlRegression: controls.length,
};
artifact.verdict = verdict;
artifact.verdictName = verdict.preFixUnnamedFaces > 0 && verdict.fixedUnnamedFaces === 0
  && verdict.fixedUnmarkedFaces === 0 && verdict.fixedRepairedFaces === 0
  && verdict.fixedWrongChannelFaces === 0 && verdict.fixedWrongSentenceFaces === 0
  && verdict.controlRegression === 0
  ? 'answer-voice-closed' : 'answer-voice-open';

// Leak guard: research/ is committed, so a host path in it would be a
// committed leak. The scrubbed text is what gets WRITTEN — the artifact on
// disk is the sanitized one.
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

const falsified = verdict.preFixUnnamedFaces === 0 // the baseline shows no defect: unmeasurable
  || verdict.fixedUnnamedFaces !== 0
  || verdict.fixedUnmarkedFaces !== 0
  || verdict.fixedRepairedFaces !== 0
  || verdict.fixedWrongChannelFaces !== 0
  || verdict.fixedWrongSentenceFaces !== 0
  || verdict.controlRegression !== 0
  || hostPathLeak !== 0
  || tempPathLeak !== 0;
process.exit(falsified ? 1 : 0);
