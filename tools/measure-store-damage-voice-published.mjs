#!/usr/bin/env node
// tools/measure-store-damage-voice-published.mjs — THE DAMAGE VOICE ON THE
// CHANNEL A STRANGER ACTUALLY INSTALLS.
//
// The two-tree measurement (tools/measure-store-damage-voice.mjs) compares
// the pre-fix COMMIT with the fixed COMMIT inside this repository. This tool
// asks the question at the CHANNEL: it installs two PUBLISHED npm versions
// into two empty apps and runs the SAME byte-identical probe
// (tools/store-damage-voice-probe.mjs) inside each installed package.
//
// Why the channel and not only the tree: PUBLISH != CONSUMPTION. A defect
// fixed in a commit but still carried by the published tarball is a defect
// the world still has. This tool measures what a stranger gets.
//
// WHAT WOULD FALSIFY THE CLAIM (counted here, nothing hand-written):
//   * preFixLeakedErrnoFaces  — the OLDER published version quotes the
//     kernel's errno. Expected LARGE; the tool FAILS if it is 0 (a baseline
//     without a defect makes the fix unmeasurable).
//   * fixedLeakedErrnoFaces   — the NEWER published version still quotes the
//     kernel. Must be 0.
//   * preFixUnnamedFaces      — older version: refusals without a product
//     code. Expected LARGE; must be > 0 for a meaningful baseline.
//   * fixedUnnamedFaces       — newer version: refusals without a code.
//     Must be 0.
//   * preFixRepairlessFaces / fixedRepairlessFaces — same for the repair.
//   * fixedWrongChannelFaces  — a DAMAGE refusal must keep exit 1 (the work
//     ran and found broken bytes); the CALLER-PATH control must keep exit 2.
//     Must be 0.
//   * controlRegression       — a control changed VERDICT between the two
//     published versions. Paths are normalised before comparing, because the
//     probe writes into a fresh temporary directory per run and the path is
//     not part of the verdict. Must be 0.
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a version could not be installed or
//             the probe could not run).
//
// Usage: node tools/measure-store-damage-voice-published.mjs \
//          [--out <file>] [--carrier <version>] [--fixed <version>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PROBE = path.join(HERE, 'store-damage-voice-probe.mjs');
const FIXTURES = [
  ['test', 'fixtures', 'whirlpool-idl.json'],
  ['test', 'fixtures', 'mainnet-whirlpool.json'],
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CARRIER = arg('--carrier', '0.4.32');
const FIXED = arg('--fixed', '0.4.33');
const OUT = arg('--out', path.join(ROOT, 'research', 'store-damage-voice-published-2026-11-17.json'));

if (!fs.existsSync(PROBE)) { console.error('probe missing'); process.exit(3); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-published-damage-'));

function installAndProbe(version) {
  const appDir = path.join(tmpRoot, `v${version.replace(/\./g, '-')}`);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'probe-app', private: true, version: '0.0.0' }));
  const install = spawnSync('npm', ['install', `sememe@${version}`, '--no-audit', '--no-fund'], {
    cwd: appDir, encoding: 'utf8', timeout: 300000,
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
  fs.copyFileSync(PROBE, path.join(pkgDir, 'tools', 'store-damage-voice-probe.mjs'));

  const run = spawnSync(process.execPath, [path.join(pkgDir, 'tools', 'store-damage-voice-probe.mjs')], {
    cwd: pkgDir, encoding: 'utf8', timeout: 600000,
  });
  if (run.status !== 0) {
    console.error(`probe on ${version} failed (exit ${run.status}): ${(run.stderr || '').slice(-600)}`);
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(run.stdout); } catch { console.error(`probe on ${version} produced no JSON`); return null; }
  return { version, installedVersion: JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, result: parsed };
}

function normalise(text) {
  if (typeof text !== 'string') return text;
  // The probe writes into a fresh temporary directory per run; the temporary
  // path is not part of the verdict.
  return text.replace(/\/tmp\/[A-Za-z0-9._-]*sememe[A-Za-z0-9._-]*/g, '<TMP>');
}

function leaked(r, name) {
  const c = r.result.cases[name];
  return (c && c.leakedErrno) || [];
}

const carrierRun = installAndProbe(CARRIER);
const fixedRun = installAndProbe(FIXED);
if (!carrierRun || !fixedRun) { console.error('no verdict: a version could not be measured'); process.exit(3); }

const faces = carrierRun.result.faces;
const controls = carrierRun.result.controls;
const dmgFaces = faces.filter((n) => !controls.includes(n));

const preLeak = dmgFaces.filter((n) => leaked(carrierRun, n).length > 0);
const fixedLeak = dmgFaces.filter((n) => leaked(fixedRun, n).length > 0);
const preUnnamed = dmgFaces.filter((n) => !carrierRun.result.cases[n].code);
const fixedUnnamed = dmgFaces.filter((n) => !fixedRun.result.cases[n].code);
const preRepairless = dmgFaces.filter((n) => !carrierRun.result.cases[n].fix);
const fixedRepairless = dmgFaces.filter((n) => !fixedRun.result.cases[n].fix);
const fixedWrongChannel = dmgFaces.filter((n) => fixedRun.result.cases[n].exit !== 1);
const controlChanged = controls.filter((n) => {
  const a = carrierRun.result.cases[n];
  const b = fixedRun.result.cases[n];
  return a.exit !== b.exit
    || (a.code || null) !== (b.code || null)
    || normalise(a.text) !== normalise(b.text);
});
const hostPathLeak = JSON.stringify(fixedRun.result).includes(tmpRoot) || JSON.stringify(fixedRun.result).includes(os.homedir());

const report = {
  tool: 'measure-store-damage-voice-published',
  measuredAt: new Date().toISOString(),
  question: 'does damage the reader finds itself get the product\'s named refusal on the channel a stranger installs?',
  carrier: { version: CARRIER, installedVersion: carrierRun.installedVersion },
  fixed: { version: FIXED, installedVersion: fixedRun.installedVersion },
  damageFaces: dmgFaces.length,
  preFixLeakedErrnoFaces: preLeak.length,
  fixedLeakedErrnoFaces: fixedLeak.length,
  preFixUnnamedFaces: preUnnamed.length,
  fixedUnnamedFaces: fixedUnnamed.length,
  preFixRepairlessFaces: preRepairless.length,
  fixedRepairlessFaces: fixedRepairless.length,
  fixedWrongChannelFaces: fixedWrongChannel.length,
  controlRegression: controlChanged.length,
  controlRegressionNames: controlChanged,
  hostPathLeak,
  fixedCodes: Object.fromEntries(dmgFaces.map((n) => [n, fixedRun.result.cases[n].code || null])),
  fixedExits: Object.fromEntries(dmgFaces.map((n) => [n, fixedRun.result.cases[n].exit])),
  fixedRepairs: Object.fromEntries(dmgFaces.map((n) => [n, fixedRun.result.cases[n].fix || null])),
  controls: Object.fromEntries(controls.map((n) => [n, {
    exit: fixedRun.result.cases[n].exit,
    code: fixedRun.result.cases[n].code || null,
  }])),
  carrierSamples: Object.fromEntries(preLeak.slice(0, 2).map((n) => [n, normalise(carrierRun.result.cases[n].text)])),
  fixedSamples: Object.fromEntries(dmgFaces.slice(0, 2).map((n) => [n, normalise(fixedRun.result.cases[n].text)])),
  verdict: null,
};
report.verdict = (
  report.preFixLeakedErrnoFaces > 0
  && report.fixedLeakedErrnoFaces === 0
  && report.preFixUnnamedFaces > 0
  && report.fixedUnnamedFaces === 0
  && report.preFixRepairlessFaces > 0
  && report.fixedRepairlessFaces === 0
  && report.fixedWrongChannelFaces === 0
  && report.controlRegression === 0
  && report.hostPathLeak === false
) ? 'store-damage-voice-held-on-the-published-channel' : 'store-damage-voice-not-held';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  verdict: report.verdict,
  out: OUT,
  preFixLeakedErrnoFaces: report.preFixLeakedErrnoFaces,
  fixedLeakedErrnoFaces: report.fixedLeakedErrnoFaces,
  preFixUnnamedFaces: report.preFixUnnamedFaces,
  fixedUnnamedFaces: report.fixedUnnamedFaces,
  fixedRepairlessFaces: report.fixedRepairlessFaces,
  fixedWrongChannelFaces: report.fixedWrongChannelFaces,
  controlRegression: report.controlRegression,
  hostPathLeak: report.hostPathLeak,
}, null, 2));

const ok = report.verdict === 'store-damage-voice-held-on-the-published-channel';
process.exit(ok ? 0 : 1);
