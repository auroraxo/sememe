#!/usr/bin/env node
// tools/measure-lock-voice-published.mjs — DOES THE LOCK SURFACE (THE CI
// GATE) NAME ITS REFUSALS ON THE CHANNEL A STRANGER INSTALLS?
//
// WHY THIS TOOL EXISTS (the defect class measured repeatedly here)
//
// The two-tree measurement (tools/measure-lock-voice.mjs) compares two
// COMMITS inside this repository. It cannot say what a stranger gets: a fix
// that is on `main` but behind the pinned release is not fixed for anyone.
// "main gefixt, der Pin dahinter" is the most repeated defect class in this
// repo's history, so the claim moves to the channel: this tool installs TWO
// PUBLISHED npm versions into two EMPTY apps and runs the SAME byte-
// identical probe inside each installed package.
//
// WHAT WOULD FALSIFY THE CLAIM (counted directly by this tool):
//   * carrierUnnamedFaces   — the OLDER published version must show the
//                             defect, otherwise the fix is unmeasurable on
//                             this channel. Must be > 0; fails if 0.
//   * carrierRepairlessFaces — same for the repair. Must be > 0.
//   * carrierSilentCodeFaces — the older version mints a code the CLI drops.
//                             Must be > 0 (measured on 0.4.34).
//   * fixedUnnamedFaces     — the NEWER published version still answers
//                             without a code. Must be 0.
//   * fixedRepairlessFaces  — must be 0.
//   * fixedWrongChannelFaces — a lock document fault or a gate failure must
//                             stay on the work channel (exit 1). Must be 0.
//   * fixedSilentCodeFaces  — must be 0.
//   * controlRegression     — a control answered differently between two
//                             published versions. Must be 0.
//   * hostPathLeak          — research/ is committed: no host path. Must be 0.
//
// Exit codes: 0 verified; 1 a falsification count is non-zero; 2 usage/IO;
//             3 NO VERDICT (a version could not be installed or probed).
//
// Usage: node tools/measure-lock-voice-published.mjs
//          [--out <file>] [--carrier <version>] [--fixed <version>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PROBE = path.join(HERE, 'lock-voice-probe.mjs');
const FIXTURES = [
  ['test', 'fixtures', 'whirlpool-idl.json'],
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// The carrier carries the defect; the fixed version must not. 0.4.34 is the
// version the README pinned before this fix — a stranger installing the
// documented tag until now got prose-only gate refusals.
const CARRIER = arg('--carrier', '0.4.34');
const FIXED = arg('--fixed', '0.4.35');
const OUT = arg('--out', path.join(ROOT, 'research', 'lock-voice-published-2026-11-17.json'));

if (!fs.existsSync(PROBE)) { console.error('probe missing'); process.exit(3); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-published-lock-'));

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
  // package's own bin/ and src/ are what answer. Only the package under test
  // differs between the two runs.
  for (const rel of FIXTURES) {
    const dest = path.join(pkgDir, ...rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, ...rel), dest);
  }
  fs.mkdirSync(path.join(pkgDir, 'tools'), { recursive: true });
  fs.copyFileSync(PROBE, path.join(pkgDir, 'tools', 'lock-voice-probe.mjs'));

  const run = spawnSync(process.execPath, [path.join(pkgDir, 'tools', 'lock-voice-probe.mjs')], {
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

const carrierRun = installAndProbe(CARRIER);
const fixedRun = installAndProbe(FIXED);
if (!carrierRun || !fixedRun) { console.error('no verdict: a version could not be measured'); process.exit(3); }

const faces = carrierRun.result.faces;
const controls = carrierRun.result.controls;
const lockFaces = faces.filter((n) => !controls.includes(n));

const code = (run, n) => run.result.cases[n]?.code ?? null;
const fix = (run, n) => run.result.cases[n]?.fix ?? null;
const exit = (run, n) => run.result.cases[n]?.exit ?? null;

const carrierUnnamed = lockFaces.filter((n) => !code(carrierRun, n));
const carrierRepairless = lockFaces.filter((n) => !fix(carrierRun, n));
const fixedUnnamed = lockFaces.filter((n) => !code(fixedRun, n));
const fixedRepairless = lockFaces.filter((n) => !fix(fixedRun, n));
const fixedWrongChannel = lockFaces.filter((n) => exit(fixedRun, n) !== 1);

// The silent-code class: a code MINTED at the library but absent on the CLI
// channel (the CLI prints code+fix only when both are present).
const silent = (run) => Object.entries(run.result.libraryFaces ?? {})
  .filter(([, f]) => f.refused && f.code && !f.fix)
  .map(([name]) => name);
const carrierSilent = silent(carrierRun);
const fixedSilent = silent(fixedRun);

const controlRegression = controls.filter((n) => {
  const a = carrierRun.result.cases[n];
  const b = fixedRun.result.cases[n];
  if (!a || !b) return true;
  return a.exit !== b.exit || (a.code ?? null) !== (b.code ?? null) || a.answered !== b.answered;
});

const detail = {};
for (const n of lockFaces) {
  detail[n] = {
    carrier: { exit: exit(carrierRun, n), code: code(carrierRun, n), fix: fix(carrierRun, n) },
    fixed: { exit: exit(fixedRun, n), code: code(fixedRun, n), fix: fix(fixedRun, n) },
  };
}

const verdict = {
  carrierUnnamedFaces: carrierUnnamed.length,
  carrierRepairlessFaces: carrierRepairless.length,
  carrierSilentCodeFaces: carrierSilent.length,
  fixedUnnamedFaces: fixedUnnamed.length,
  fixedRepairlessFaces: fixedRepairless.length,
  fixedWrongChannelFaces: fixedWrongChannel.length,
  fixedSilentCodeFaces: fixedSilent.length,
  controlRegression: controlRegression.length,
};

const artifact = {
  tool: 'tools/measure-lock-voice-published.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  question: 'does the lock surface — the product\'s own CI gate — name its refusals on the channel a stranger installs?',
  method: 'npm install <version> into an empty app -> byte-identical probe run inside the installed package',
  carrier: { requested: CARRIER, installed: carrierRun.installedVersion },
  fixed: { requested: FIXED, installed: fixedRun.installedVersion },
  faces: lockFaces,
  controls,
  detail,
  controlsDetail: Object.fromEntries(controls.map((n) => [n, {
    carrier: carrierRun.result.cases[n],
    fixed: fixedRun.result.cases[n],
  }])),
  silentCode: { carrier: carrierSilent, fixed: fixedSilent },
  verdict,
};

const holds = verdict.carrierUnnamedFaces > 0 && verdict.carrierRepairlessFaces > 0
  && verdict.carrierSilentCodeFaces > 0
  && verdict.fixedUnnamedFaces === 0 && verdict.fixedRepairlessFaces === 0
  && verdict.fixedWrongChannelFaces === 0 && verdict.fixedSilentCodeFaces === 0
  && verdict.controlRegression === 0;
artifact.verdictName = holds
  ? 'lock-voice-held-on-the-published-channel'
  : 'lock-voice-not-held-on-the-published-channel';

// Leak guard: research/ is committed.
const raw = JSON.stringify(artifact);
const hostPathLeak = raw.includes(os.homedir()) ? 1 : 0;
const sanitized = raw.replaceAll(os.homedir(), '<home>').replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>');
const tempPathLeak = (sanitized.match(/\/tmp\/[A-Za-z0-9._-]+/g) ?? []).length;
artifact.hostPathLeak = hostPathLeak;
artifact.tempPathLeak = tempPathLeak;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)
  .replaceAll(os.homedir(), '<home>')
  .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>')}\n`);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(JSON.stringify({ out: path.relative(ROOT, OUT), verdictName: artifact.verdictName, ...verdict, hostPathLeak, tempPathLeak }, null, 2));
process.exit(holds && hostPathLeak === 0 && tempPathLeak === 0 ? 0 : 1);
