#!/usr/bin/env node
// tools/measure-acquire-voice.mjs — DOES THE ACQUISITION SURFACE NAME ITS
// REFUSALS, OR DOES THE NETWORK'S FAILURE REACH THE OPERATOR IN UNDICI'S
// VOICE?
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, pre-fix tree
// af0a8d2, and reproduced against the PUBLISHED sememe@0.4.36):
//
// Every other classifier in the product closed its surface: the caller's
// file (file-input v0.4.31), the caller's store path (store-input v0.4.32),
// damage the reader finds (store-damage v0.4.33), the lock gate
// (lock-voice v0.4.35), the answers themselves (answer-voice v0.4.36). The
// ONE surface never classified is the network the caller named with --rpc.
// Measured on pre-fix af0a8d2, all nine failure faces of `sememe pull`
// reached the operator as bare prose: no code, no repair, exit 1.
//
//   {"error":"RPC unavailable: HTTP 403"}                 <- rate limit
//   {"error":"RPC unavailable: HTTP 429"}                 <- forbidden
//   {"error":"RPC unavailable: HTTP 500"}                 <- outage
//   {"error":"RPC unavailable: Unexpected token 'o',…"}   <- parser's words
//   {"error":"RPC unavailable: RPC error -32005"}         <- message DROPPED
//   {"error":"RPC unavailable: malformed RPC response"}   <- nothing named
//   {"error":"RPC unavailable: fetch failed"}             <- undici's words
//   {"error":"HTTPS RPC URL required"}                    <- no code
//   {"error":"Non-base58 character"}                      <- web3.js's words
//
// Three faults, the same three the other classifiers ended: NO NAME (a
// script cannot tell retry-later from fix-your-flag), NO SUBJECT (which
// endpoint, what the endpoint actually said), THE WRONG VOCABULARY (undici,
// the JSON parser, web3.js quoted verbatim; the JSON-RPC error object's own
// message thrown away, only its number kept).
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question):
//
//   1. tools/acquire-voice-probe.mjs starts a LOCAL TLS mock RPC — no real
//      network, no real endpoint — runs nine failure faces and four
//      controls through THAT tree's bin/sememe.mjs, and reports exit codes
//      and the parsed stderr fields. Byte-identical in both trees; it is
//      copied into the extracted pre-fix tree.
//   2. The pre-fix tree is the last commit BEFORE the fix, extracted with
//      `git archive` (stable forever, unlike "the previous commit").
//   3. The verdict is derived from the two runs. Nothing is hand-written.
//
// WHAT WOULD FALSIFY THE FIX (counted directly by this tool):
//   * preFixUnnamedFaces — the pre-fix tree names none of them. Expected
//     LARGE; the tool fails if it is 0 (a baseline without a defect makes
//     the fix unmeasurable).
//   * fixedUnnamedFaces — every face carries a product code. Must be 0.
//   * preFixRepairlessFaces / fixedRepairlessFaces — same for the repair.
//   * fixedWrongChannelFaces — channel contract: the caller's wrong input
//     (program id, non-https URL) is usage, exit 2; a failing endpoint is
//     the work channel, exit 1 (sememe did run and its network failed);
//     pullOk stays 0; gapUnknownHolds stays 3 (the unknown-verdict contract
//     pinned by test/acquisition-gap.test.mjs T4); storeAnswerVoice and
//     flagVoice keep their channels. Must be 0.
//   * controlRegression — a control changed verdict between the trees.
//     Must be 0 (store paths normalised; they are fresh temp dirs per run).
//   * hostPathLeak — the artifact quotes this host's paths. Must be 0.
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-acquire-voice.mjs [--out <file>] [--prefix <commit>]

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};
const OUT = flag('--out', path.join(ROOT, 'research', 'acquire-voice-2026-11-17.json'));
const PREFIX = flag('--prefix', 'af0a8d2');

const PROBE = path.join(HERE, 'acquire-voice-probe.mjs');
const CA_CERT = process.env.SEMEME_PROBE_CA_CERT;
const CA_KEY = process.env.SEMEME_PROBE_CA_KEY;
if (!existsSync(PROBE)) { console.error('probe missing'); process.exit(2); }
// The probe generates its own throwaway TLS pair when none is supplied —
// the env vars are an OVERRIDE for callers that want to pin the pair (a
// long-validity fixture cert, for example), not a requirement.
const env = (CA_CERT && CA_KEY && existsSync(CA_CERT) && existsSync(CA_KEY))
  ? { ...process.env, SEMEME_PROBE_CA_CERT: CA_CERT, SEMEME_PROBE_CA_KEY: CA_KEY }
  : { ...process.env, SEMEME_PROBE_CA_CERT: undefined, SEMEME_PROBE_CA_KEY: undefined };

function runProbe(root) {
  const run = spawnSync(process.execPath, [path.join(root, 'tools', 'acquire-voice-probe.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 600000, env,
  });
  if (run.status !== 0) {
    console.error(`probe in ${root} failed (exit ${run.status}): ${(run.stderr || '').slice(-800)}`);
    return null;
  }
  try { return JSON.parse(run.stdout); } catch { console.error(`probe in ${root} produced no JSON`); return null; }
}

// --- the pre-fix tree: extracted from git history --------------------------
const preTree = mkdtempSync(path.join(os.tmpdir(), 'sememe-acquire-prefix-'));
let preFixRun = null;
try {
  const tar = execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', PREFIX], { maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', preTree], { input: tar });
  // The probe is copied IN, so both trees run byte-identical probe code; only
  // the src/ under test differs. The peer (@solana/web3.js) is needed by
  // pull/gap — symlink the working tree's node_modules (never committed).
  copyFileSync(PROBE, path.join(preTree, 'tools', 'acquire-voice-probe.mjs'));
  if (!existsSync(path.join(preTree, 'node_modules'))) {
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(preTree, 'node_modules'), 'dir');
  }
  preFixRun = runProbe(preTree);
} catch (error) {
  console.error(`pre-fix probe could not run: ${String(error?.message ?? error).slice(0, 400)}`);
}

// --- the fixed tree: this working tree -------------------------------------
const fixedRun = runProbe(ROOT);

if (!preFixRun || !fixedRun) {
  console.error('no verdict: a tree could not be measured');
  rmSync(preTree, { recursive: true, force: true });
  process.exit(3);
}

const has = (run, name) => run.cases[name];
const FACES = preFixRun.faces;
const CONTROLS = preFixRun.controls;

const unnamed = (run, name) => { const c = has(run, name); return Boolean(c && !c.code); };
const repairless = (run, name) => { const c = has(run, name); return Boolean(c && !c.fix); };

const preUnnamed = FACES.filter((n) => unnamed(preFixRun, n));
const fixedUnnamed = FACES.filter((n) => unnamed(fixedRun, n));
const preRepairless = FACES.filter((n) => repairless(preFixRun, n));
const fixedRepairless = FACES.filter((n) => repairless(fixedRun, n));

// Channel contract, per case (see header): 1 = work channel, 2 = usage
// channel, 0 = success, 3 = gap's unknown verdict.
const EXPECTED_EXIT = {
  rpcNotHttps: 2, rpcBadProgramId: 2,
  rpcHttp403: 1, rpcHttp429: 1, rpcHttp500: 1, rpcGarbageBody: 1,
  rpcJsonError: 1, rpcShortResult: 1, rpcUnreachable: 1,
  pullOk: 0, gapUnknownHolds: 3, storeAnswerVoice: 1, flagVoice: 2,
};
const wrongChannel = (run) => Object.entries(EXPECTED_EXIT)
  .filter(([name, expected]) => (has(run, name)?.exit ?? null) !== expected)
  .map(([name]) => name);
const fixedWrongChannel = wrongChannel(fixedRun);
const preWrongChannel = wrongChannel(preFixRun);

// Controls: verdict = (exit, code, answer, normalised text).
const normalise = (text) => (typeof text !== 'string') ? text
  : text.replace(/\/tmp\/[A-Za-z0-9._-]*sememe[A-Za-z0-9._-]*/g, '<TMP>');
const controlRegression = CONTROLS.filter((name) => {
  const a = has(preFixRun, name); const b = has(fixedRun, name);
  if (!a || !b) return true;
  return a.exit !== b.exit || (a.code || null) !== (b.code || null)
    || (a.answer || null) !== (b.answer || null)
    || normalise(a.error) !== normalise(b.error);
});

const serialised = JSON.stringify(fixedRun);
const hostPathLeak = serialised.includes(os.homedir())
  || /\/home\/[a-z]+\//.test(serialised);

const report = {
  tool: 'measure-acquire-voice',
  measuredAt: new Date().toISOString(),
  question: 'does the acquisition surface (--rpc) answer a failing endpoint in the product\'s named voice?',
  preFix: { prefix: PREFIX },
  faces: FACES.length,
  controlCount: CONTROLS.length,
  preFixUnnamedFaces: preUnnamed.length,
  fixedUnnamedFaces: fixedUnnamed.length,
  preFixRepairlessFaces: preRepairless.length,
  fixedRepairlessFaces: fixedRepairless.length,
  preFixWrongChannelFaces: preWrongChannel.length,
  fixedWrongChannelFaces: fixedWrongChannel.length,
  controlRegression: controlRegression.length,
  controlRegressionNames: controlRegression,
  hostPathLeak,
  fixedCodes: Object.fromEntries(FACES.map((n) => [n, has(fixedRun, n)?.code ?? null])),
  fixedExits: Object.fromEntries(Object.keys(EXPECTED_EXIT).map((n) => [n, has(fixedRun, n)?.exit ?? null])),
  fixedRepairs: Object.fromEntries(FACES.map((n) => [n, has(fixedRun, n)?.fix ?? null])),
  preFixSamples: Object.fromEntries(preUnnamed.slice(0, 3).map((n) => [n, normalise(has(preFixRun, n)?.error)])),
  fixedSamples: Object.fromEntries(FACES.slice(0, 3).map((n) => [n, normalise(has(fixedRun, n)?.error)])),
  controls: Object.fromEntries(CONTROLS.map((n) => [n, {
    exit: has(fixedRun, n)?.exit, code: has(fixedRun, n)?.code ?? null,
    exitPre: has(preFixRun, n)?.exit, codePre: has(preFixRun, n)?.code ?? null,
  }])),
  verdict: null,
};

report.verdict = (
  report.preFixUnnamedFaces > 0
  && report.fixedUnnamedFaces === 0
  && report.preFixRepairlessFaces > 0
  && report.fixedRepairlessFaces === 0
  && report.fixedWrongChannelFaces === 0
  && report.controlRegression === 0
  && report.hostPathLeak === false
) ? 'acquire-voice-closed' : 'not-held';

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

rmSync(preTree, { recursive: true, force: true });

console.log(`pre-fix unnamed ${report.preFixUnnamedFaces}/${report.faces}, repairless ${report.preFixRepairlessFaces}/${report.faces}`);
console.log(`fixed unnamed ${report.fixedUnnamedFaces}/${report.faces}, repairless ${report.fixedRepairlessFaces}/${report.faces}`);
console.log(`wrong channel: pre ${report.preFixWrongChannelFaces}, fixed ${report.fixedWrongChannelFaces}; control regressions ${report.controlRegression}; hostPathLeak ${report.hostPathLeak}`);
console.log(`verdict: ${report.verdict}`);
process.exit(report.verdict === 'acquire-voice-closed' ? 0 : 1);
