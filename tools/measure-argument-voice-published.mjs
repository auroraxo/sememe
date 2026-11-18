#!/usr/bin/env node
// tools/measure-argument-voice-published.mjs — THE FORGOTTEN-ARGUMENT VOICE
// ON THE CHANNEL A STRANGER ACTUALLY INSTALLS.
//
// The two-tree measurement (tools/measure-argument-voice.mjs) compares the
// pre-fix COMMIT with the fixed COMMIT inside this repository. This tool
// asks the question at the CHANNEL: it installs two PUBLISHED npm versions
// into two empty apps and runs the SAME byte-identical probe
// (tools/argument-voice-probe.mjs) inside each installed package.
//
// Why the channel and not only the tree: PUBLISH != CONSUMPTION. A defect
// fixed in a commit but still carried by the published tarball is a defect
// the world still has. This tool measures what a stranger gets.
//
// WHAT WOULD FALSIFY THE CLAIM (counted here, nothing hand-written):
//   * carrierUnnamedFaces   — the OLDER published version answers a forgot-
//     ten or wrong argument without a code. Expected LARGE (the defect);
//     the tool FAILS if it is 0 (a baseline without a defect makes the fix
//     unmeasurable).
//   * carrierRepairlessFaces — the older version gives no repair. Must be
//     LARGE (26 of 26 measured for 0.4.37).
//   * carrierWrongChannelFaces — the caller's mistake travels on the WORK
//     channel (exit 1) on the older version. Must be LARGE.
//   * fixedUnnamedFaces / fixedRepairlessFaces — the NEWER published version
//     still refuses unnamed/repairless. Must be 0.
//   * fixedWrongChannelFaces — an argument refusal (nothing ran) still on
//     exit 1 on the newer version. Must be 0 (usage channel = exit 2).
//   * controlRegression     — a control changed between the two published
//     versions. Must be 0 (temp paths are normalised).
//   * hostPathLeak          — the artifact quotes this host's paths. Must be
//     0 (research/ is committed).
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a version could not be installed or
//             the probe could not run).
//
// Usage: node tools/measure-argument-voice-published.mjs \
//          [--out <file>] [--carrier <version>] [--fixed <version>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PROBE = path.join(HERE, 'argument-voice-probe.mjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CARRIER = arg('--carrier', '0.4.37');
const FIXED = arg('--fixed', '0.4.38');
const OUT = arg('--out', path.join(ROOT, 'research', 'argument-voice-published-2026-11-18.json'));

if (!fs.existsSync(PROBE)) { console.error('probe missing'); process.exit(3); }

/** The 26 argument faces + the 5 controls — the same names the two-tree
 *  measurement and test/argument-voice.test.mjs carry. */
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-published-arg-voice-'));

function installAndProbe(version) {
  const appDir = path.join(tmpRoot, `v${version.replace(/\./g, '-')}`);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'probe-app', private: true, version: '0.0.0' }));
  const install = spawnSync('npm', ['install', `sememe@${version}`, '--no-audit', '--no-fund'], {
    cwd: appDir, encoding: 'utf8', timeout: 300000,
  });
  if (install.status !== 0) {
    console.error(`npm install sememe@${version} failed: ${String(install.stderr || '').slice(-600)}`);
    return null;
  }
  const pkgDir = path.join(appDir, 'node_modules', 'sememe');
  if (!fs.existsSync(pkgDir)) { console.error(`sememe@${version} not installed`); return null; }

  // The probe is copied INTO the installed package, so the package's own
  // bin/ and src/ are what answer. Only the package under test differs
  // between the two runs; the probe bytes are identical.
  fs.mkdirSync(path.join(pkgDir, 'tools'), { recursive: true });
  fs.copyFileSync(PROBE, path.join(pkgDir, 'tools', 'argument-voice-probe.mjs'));

  const run = spawnSync(process.execPath, [path.join(pkgDir, 'tools', 'argument-voice-probe.mjs')], {
    cwd: pkgDir, encoding: 'utf8', timeout: 600000,
  });
  if (run.status !== 0) {
    console.error(`probe on ${version} failed (exit ${run.status}): ${String(run.stderr || '').slice(-600)}`);
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(run.stdout); }
  catch { console.error(`probe on ${version} produced no JSON`); return null; }
  return {
    version,
    installedVersion: JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version,
    result: parsed,
  };
}

const carrierRun = installAndProbe(CARRIER);
const fixedRun = installAndProbe(FIXED);
if (!carrierRun || !fixedRun) {
  console.error('no verdict: a version could not be measured');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(3);
}

const code = (run, n) => run.result.cases[n]?.hasCode ? 'present' : null;
const fix = (run, n) => run.result.cases[n]?.hasFix ? 'present' : null;
const exit = (run, n) => run.result.cases[n]?.exit ?? null;
const stderr = (run, n) => run.result.cases[n]?.stderr ?? '';

const carrierUnnamed = FACES.filter((n) => !code(carrierRun, n));
const carrierRepairless = FACES.filter((n) => !fix(carrierRun, n));
// An argument refusal means NOTHING ran. On the carrier the caller's
// mistake travelled on the WORK channel (exit 1); that is the channel fault.
const carrierWrongChannel = FACES.filter((n) => exit(carrierRun, n) === 1);
const fixedUnnamed = FACES.filter((n) => !code(fixedRun, n));
const fixedRepairless = FACES.filter((n) => !fix(fixedRun, n));
const fixedWrongChannel = FACES.filter((n) => exit(fixedRun, n) !== 2);

// Controls: identical question, identical answer expected between the two
// published versions (temp paths normalised — they differ per install run).
const normalize = (s) => String(s)
  .replaceAll(os.homedir(), '<home>')
  .replaceAll(tmpRoot, '<tmp>')
  .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>');
const controlRegression = CONTROLS.filter((n) => {
  const a = carrierRun.result.controls[n];
  const b = fixedRun.result.controls[n];
  if (!a || !b) return true;
  return a.exit !== b.exit || normalize(a.stderr) !== normalize(b.stderr);
});

const detail = {};
for (const n of FACES) {
  detail[n] = {
    carrier: { exit: exit(carrierRun, n), code: code(carrierRun, n), fix: fix(carrierRun, n), error: stderr(carrierRun, n) },
    fixed: { exit: exit(fixedRun, n), code: code(fixedRun, n), fix: fix(fixedRun, n), error: stderr(fixedRun, n) },
  };
}
const controlsDetail = Object.fromEntries(CONTROLS.map((n) => [n, {
  carrier: carrierRun.result.controls[n],
  fixed: fixedRun.result.controls[n],
}]));

const verdict = {
  carrierUnnamedFaces: carrierUnnamed.length,
  carrierRepairlessFaces: carrierRepairless.length,
  carrierWrongChannelFaces: carrierWrongChannel.length,
  fixedUnnamedFaces: fixedUnnamed.length,
  fixedRepairlessFaces: fixedRepairless.length,
  fixedWrongChannelFaces: fixedWrongChannel.length,
  controlRegression: controlRegression.length,
};

const holds = verdict.carrierUnnamedFaces > 0 && verdict.carrierRepairlessFaces > 0
  && verdict.carrierWrongChannelFaces > 0
  && verdict.fixedUnnamedFaces === 0 && verdict.fixedRepairlessFaces === 0
  && verdict.fixedWrongChannelFaces === 0
  && verdict.controlRegression === 0;

const artifact = {
  tool: 'tools/measure-argument-voice-published.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  question: 'does a forgotten or wrong argument get the product\'s own named refusal on the usage channel, on the package a stranger installs?',
  method: 'npm install <version> into an empty app -> byte-identical probe run inside the installed package',
  carrier: { requested: CARRIER, installed: carrierRun.installedVersion },
  fixed: { requested: FIXED, installed: fixedRun.installedVersion },
  faces: FACES,
  controls: CONTROLS,
  detail,
  controlsDetail,
  verdict,
};
artifact.verdictName = holds
  ? 'argument-voice-held-on-the-published-channel'
  : 'argument-voice-not-held-on-the-published-channel';

// Leak guard: research/ is committed.
const raw = JSON.stringify(artifact);
const hostPathLeak = raw.includes(os.homedir()) ? 1 : 0;
const sanitized = raw.replaceAll(os.homedir(), '<home>').replaceAll(tmpRoot, '<tmp>').replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>');
const tempPathLeak = (sanitized.match(/\/tmp\/[A-Za-z0-9._-]+/g) ?? []).length;
artifact.hostPathLeak = hostPathLeak;
artifact.tempPathLeak = tempPathLeak;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)
  .replaceAll(os.homedir(), '<home>')
  .replaceAll(tmpRoot, '<tmp>')
  .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>')}\n`);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(JSON.stringify({
  out: path.relative(ROOT, OUT),
  verdictName: artifact.verdictName,
  ...verdict,
  hostPathLeak,
  tempPathLeak,
}, null, 2));
process.exit(holds && hostPathLeak === 0 && tempPathLeak === 0 ? 0 : 1);
