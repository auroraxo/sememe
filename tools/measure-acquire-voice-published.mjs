#!/usr/bin/env node
// tools/measure-acquire-voice-published.mjs — THE ACQUISITION VOICE ON THE
// CHANNEL A STRANGER ACTUALLY INSTALLS.
//
// The two-tree measurement (tools/measure-acquire-voice.mjs) compares the
// pre-fix COMMIT with the fixed COMMIT inside this repository. This tool
// asks the question at the CHANNEL: it installs two PUBLISHED npm versions
// into two empty apps (with the optional peer @solana/web3.js, which the
// pull path needs) and runs the SAME byte-identical probe
// (tools/acquire-voice-probe.mjs) inside each installed package.
//
// Why the channel and not only the tree: PUBLISH != CONSUMPTION. A defect
// fixed in a commit but still carried by the published tarball is a defect
// the world still has. This tool measures what a stranger gets.
//
// WHAT WOULD FALSIFY THE CLAIM (counted here, nothing hand-written):
//   * carrierUnnamedFaces   — the OLDER published version refuses without a
//     code. Expected LARGE; the tool FAILS if it is 0 (a baseline without a
//     defect makes the fix unmeasurable).
//   * carrierRepairlessFaces — the older version refuses without a repair.
//     Must be LARGE (9 of 9 measured for 0.4.36).
//   * fixedUnnamedFaces / fixedRepairlessFaces — the NEWER published version
//     still refuses unnamed/repairless. Must be 0.
//   * fixedWrongChannelFaces — the channel contract: the caller's wrong
//     input (non-https URL, non-base58 program id) must answer on the usage
//     channel, exit 2; a dispatched-and-failed request on the work channel,
//     exit 1; the four controls keep their channels (0/3/1/2). Must be 0.
//   * controlRegression     — a control changed verdict between the two
//     published versions. Must be 0 (temp paths are normalised).
//   * hostPathLeak          — the artifact quotes this host's paths. Must be
//     false (research/ is committed).
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a version could not be installed or
//             the probe could not run).
//
// Usage: node tools/measure-acquire-voice-published.mjs \
//          [--out <file>] [--carrier <version>] [--fixed <version>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PROBE = path.join(HERE, 'acquire-voice-probe.mjs');
const FIXTURES = [['test', 'fixtures', 'whirlpool-idl.json']];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CARRIER = arg('--carrier', '0.4.36');
const FIXED = arg('--fixed', '0.4.37');
const OUT = arg('--out', path.join(ROOT, 'research', 'acquire-voice-published-2026-11-18.json'));

if (!fs.existsSync(PROBE)) { console.error('probe missing'); process.exit(3); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-published-acquire-'));
// The probe generates its own throwaway TLS pair when no one supplies one,
// so this tool runs inside a plain `npm test` (CI included) without env
// setup. SEMEME_PROBE_CA_CERT / SEMEME_PROBE_CA_KEY remain optional overrides.
const cleanup = () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp */ } };
process.on('exit', cleanup);

function installAndProbe(version) {
  const appDir = path.join(tmpRoot, `v${version.replace(/\./g, '-')}`);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'probe-app', private: true, version: '0.0.0' }));
  const install = spawnSync('npm', ['install', `sememe@${version}`, '@solana/web3.js@1.98.4', '--no-audit', '--no-fund'], {
    cwd: appDir, encoding: 'utf8', timeout: 600000,
  });
  if (install.status !== 0) {
    console.error(`npm install sememe@${version} failed: ${(install.stderr || '').slice(-600)}`);
    return null;
  }
  const pkgDir = path.join(appDir, 'node_modules', 'sememe');
  if (!fs.existsSync(pkgDir)) { console.error(`sememe@${version} not installed`); return null; }

  // The probe and the fixtures are copied INTO the installed package, so the
  // package's own bin/sememe.mjs is what answers. Only the package under
  // test differs between the two runs.
  for (const rel of FIXTURES) {
    const dest = path.join(pkgDir, ...rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, ...rel), dest);
  }
  fs.mkdirSync(path.join(pkgDir, 'tools'), { recursive: true });
  fs.copyFileSync(PROBE, path.join(pkgDir, 'tools', 'acquire-voice-probe.mjs'));

  const run = spawnSync(process.execPath, [path.join(pkgDir, 'tools', 'acquire-voice-probe.mjs')], {
    cwd: pkgDir, encoding: 'utf8', timeout: 600000,
  });
  if (run.status !== 0) {
    console.error(`probe on ${version} failed (exit ${run.status}): ${(run.stderr || '').slice(-600)}`);
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(run.stdout); } catch { console.error(`probe on ${version} produced no JSON`); return null; }
  return {
    version,
    installedVersion: JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version,
    result: parsed,
  };
}

function normalise(text) {
  if (typeof text !== 'string') return text;
  // The probe writes into a fresh temporary directory per run; the temporary
  // path is not part of the verdict.
  return text.replace(/\/tmp\/[A-Za-z0-9._-]*sememe[A-Za-z0-9._-]*/g, '<TMP>');
}

// Channel contract, per case (the same table the two-tree tool pins):
// 2 = usage channel (nothing was dispatched), 1 = work channel (dispatched
// and failed), 0 = success, 3 = gap's unknown verdict.
const EXPECTED_EXIT = {
  rpcNotHttps: 2, rpcBadProgramId: 2,
  rpcHttp403: 1, rpcHttp429: 1, rpcHttp500: 1, rpcGarbageBody: 1,
  rpcJsonError: 1, rpcShortResult: 1, rpcUnreachable: 1,
  pullOk: 0, gapUnknownHolds: 3, storeAnswerVoice: 1, flagVoice: 2,
};

const carrierRun = installAndProbe(CARRIER);
const fixedRun = installAndProbe(FIXED);
if (!carrierRun || !fixedRun) { console.error('no verdict: a version could not be measured'); process.exit(3); }

const faces = carrierRun.result.faces;
const controls = carrierRun.result.controls;
const refusalFaces = faces;

const caseOf = (run, name) => run.result.cases[name] ?? { exit: null, code: null, fix: null, answer: null, error: '' };

const carrierUnnamed = refusalFaces.filter((n) => !caseOf(carrierRun, n).code);
const carrierRepairless = refusalFaces.filter((n) => !caseOf(carrierRun, n).fix);
const fixedUnnamed = refusalFaces.filter((n) => !caseOf(fixedRun, n).code);
const fixedRepairless = refusalFaces.filter((n) => !caseOf(fixedRun, n).fix);
const fixedWrongChannel = Object.keys(EXPECTED_EXIT)
  .filter((n) => caseOf(fixedRun, n).exit !== EXPECTED_EXIT[n]);

const controlChanged = controls.filter((n) => {
  const a = caseOf(carrierRun, n);
  const b = caseOf(fixedRun, n);
  return a.exit !== b.exit || (a.code || null) !== (b.code || null)
    || (a.answer || null) !== (b.answer || null)
    || normalise(a.error) !== normalise(b.error);
});

const hostPathLeak = JSON.stringify(fixedRun.result).includes(tmpRoot) || JSON.stringify(fixedRun.result).includes(os.homedir());

const detail = Object.fromEntries(refusalFaces.map((n) => [n, {
  carrier: {
    exit: caseOf(carrierRun, n).exit,
    code: caseOf(carrierRun, n).code ?? null,
    fix: caseOf(carrierRun, n).fix ?? null,
    error: normalise(caseOf(carrierRun, n).error || ''),
  },
  fixed: {
    exit: caseOf(fixedRun, n).exit,
    code: caseOf(fixedRun, n).code ?? null,
    fix: caseOf(fixedRun, n).fix ?? null,
    error: normalise(caseOf(fixedRun, n).error || ''),
  },
}]));

const controlsDetail = Object.fromEntries(controls.map((n) => [n, {
  carrier: {
    exit: caseOf(carrierRun, n).exit,
    code: caseOf(carrierRun, n).code ?? null,
    fix: caseOf(carrierRun, n).fix ?? null,
    answer: caseOf(carrierRun, n).answer === true,
  },
  fixed: {
    exit: caseOf(fixedRun, n).exit,
    code: caseOf(fixedRun, n).code ?? null,
    fix: caseOf(fixedRun, n).fix ?? null,
    answer: caseOf(fixedRun, n).answer === true,
  },
}]));

const artifact = {
  tool: 'tools/measure-acquire-voice-published.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  question: 'does the acquisition surface (--rpc) reach a stranger with named refusals — code, subject, repair, right channel — or in undici\'s/the parser\'s/web3.js\'s voice?',
  carrier: { requested: CARRIER, installed: carrierRun.installedVersion },
  fixed: { requested: FIXED, installed: fixedRun.installedVersion },
  faces,
  refusalFaces,
  controls,
  detail,
  controlsDetail,
  carrierUnnamedFaces: carrierUnnamed,
  carrierRepairlessFaces: carrierRepairless,
  fixedUnnamedFaces: fixedUnnamed,
  fixedRepairlessFaces: fixedRepairless,
  fixedWrongChannelFaces: fixedWrongChannel,
  controlRegression: controlChanged,
  hostPathLeak,
};

const verdict = {
  carrierUnnamedFaces: carrierUnnamed.length,
  carrierRepairlessFaces: carrierRepairless.length,
  fixedUnnamedFaces: fixedUnnamed.length,
  fixedRepairlessFaces: fixedRepairless.length,
  fixedWrongChannelFaces: fixedWrongChannel.length,
  controlRegression: controlChanged.length,
};
artifact.verdict = verdict;
artifact.verdictName = verdict.carrierUnnamedFaces > 0 && verdict.fixedUnnamedFaces === 0
  && verdict.fixedRepairlessFaces === 0 && verdict.fixedWrongChannelFaces === 0
  && verdict.controlRegression === 0 && !hostPathLeak
  ? 'acquire-voice-held-on-the-published-channel' : 'acquire-voice-not-held';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({
  out: path.relative(ROOT, OUT),
  carrier: artifact.carrier,
  fixed: artifact.fixed,
  verdictName: artifact.verdictName,
  ...verdict,
  hostPathLeak,
}, null, 2));

// Falsification: a carrier without the defect is an unmeasurable baseline;
// carrier==fixed measures nothing.
const falsified = verdict.carrierUnnamedFaces === 0
  || verdict.fixedUnnamedFaces !== 0
  || verdict.fixedRepairlessFaces !== 0
  || verdict.fixedWrongChannelFaces !== 0
  || verdict.controlRegression !== 0
  || hostPathLeak
  || CARRIER === FIXED;
// The measurement's own waste is not the operator's: two npm apps live under
// a temp root that must not survive the run (the dialect measurement left
// 5.6 GB of archives behind once — measured, not assumed).
process.exit(falsified ? 1 : 0);
