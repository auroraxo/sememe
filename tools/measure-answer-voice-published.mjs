#!/usr/bin/env node
// tools/measure-answer-voice-published.mjs — THE ANSWER VOICE ON THE CHANNEL
// A STRANGER ACTUALLY INSTALLS.
//
// The two-tree measurement (tools/measure-answer-voice.mjs) compares the
// pre-fix COMMIT with the fixed COMMIT inside this repository. This tool
// asks the question at the CHANNEL: it installs two PUBLISHED npm versions
// into two empty apps and runs the SAME byte-identical probe
// (tools/answer-voice-probe.mjs) inside each installed package.
//
// Why the channel and not only the tree: PUBLISH != CONSUMPTION. A defect
// fixed in a commit but still carried by the published tarball is a defect
// the world still has. This tool measures what a stranger gets.
//
// WHAT WOULD FALSIFY THE CLAIM (counted here, nothing hand-written):
//   * carrierUnnamedFaces   — the OLDER published version answers without a
//     code. Expected LARGE; the tool FAILS if it is 0 (a baseline without a
//     defect makes the fix unmeasurable).
//   * fixedUnnamedFaces     — the NEWER published version still answers
//     without a code. Must be 0.
//   * fixedUnmarkedFaces    — answers without `answer: true`. Must be 0.
//   * fixedRepairedFaces    — answers carrying a `fix` (an answer dressed as
//     a refusal). Must be 0.
//   * fixedWrongChannelFaces— an answer that left exit 1. Must be 0.
//   * fixedWrongSentenceFaces — an answer whose sentence changed. Must be 0.
//   * controlRegression     — a control changed verdict between the two
//     published versions. Paths are normalised before comparing. The one
//     documented allowance is the answer controls' own code transition
//     (null -> no-sememe-store / no-stored-idl) — that IS the claim. Must
//     otherwise be 0.
//   * hostPathLeak          — the artifact quotes this host's paths. Must be
//     false (research/ is committed).
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             2 usage/IO; 3 NO VERDICT (a version could not be installed or
//             the probe could not run).
//
// Usage: node tools/measure-answer-voice-published.mjs \
//          [--out <file>] [--carrier <version>] [--fixed <version>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PROBE = path.join(HERE, 'answer-voice-probe.mjs');
const FIXTURES = [
  ['test', 'fixtures', 'whirlpool-idl.json'],
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CARRIER = arg('--carrier', '0.4.35');
const FIXED = arg('--fixed', '0.4.36');
const OUT = arg('--out', path.join(ROOT, 'research', 'answer-voice-published-2026-11-17.json'));

if (!fs.existsSync(PROBE)) { console.error('probe missing'); process.exit(3); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-published-answer-'));

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
  fs.copyFileSync(PROBE, path.join(pkgDir, 'tools', 'answer-voice-probe.mjs'));

  const run = spawnSync(process.execPath, [path.join(pkgDir, 'tools', 'answer-voice-probe.mjs')], {
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

const SENTENCE_OF_CODE = {
  'no-sememe-store': (error) => error.startsWith('no sememe store at ')
    && /: run "sememe pull" first$/.test(error),
  'no-stored-idl': (error) => error.startsWith('no stored IDL for program ')
    && error.includes(' in '),
};

/** The one documented control allowance: the ANSWER controls' `code` moves
 *  from dropped (null) to its own code — that IS the claim this tool
 *  measures. One-directional, exact, repairless on both sides. */
const ANSWER_CONTROL_CODES = {
  noStoreAnswer: 'no-sememe-store',
  noStoredIdlAnswer: 'no-stored-idl',
};

const carrierRun = installAndProbe(CARRIER);
const fixedRun = installAndProbe(FIXED);
if (!carrierRun || !fixedRun) { console.error('no verdict: a version could not be measured'); process.exit(3); }

const faces = carrierRun.result.faces;
const controls = carrierRun.result.controls;
const answerFaces = faces.filter((n) => !controls.includes(n));

const carrierUnnamed = answerFaces.filter((n) => !carrierRun.result.cases[n].code);
const fixedUnnamed = answerFaces.filter((n) => !fixedRun.result.cases[n].code);
const fixedUnmarked = answerFaces.filter((n) => fixedRun.result.cases[n].answer !== true);
const fixedRepaired = answerFaces.filter((n) => fixedRun.result.cases[n].fix);
const fixedWrongChannel = answerFaces.filter((n) => fixedRun.result.cases[n].exit !== 1);
const fixedWrongSentence = answerFaces.filter((n) => {
  const face = fixedRun.result.cases[n];
  const check = SENTENCE_OF_CODE[face.code];
  return !check || !check(face.error || '');
});

const controlChanged = controls.filter((n) => {
  const a = carrierRun.result.cases[n];
  const b = fixedRun.result.cases[n];
  if (a.exit !== b.exit) return true;
  if ((a.code || null) !== (b.code || null)) {
    const expected = ANSWER_CONTROL_CODES[n];
    const documented = expected !== undefined
      && (a.code || null) === null && b.code === expected
      && !a.fix && !b.fix;
    if (!documented) return true;
  }
  if ((a.fix || null) !== (b.fix || null)) return true;
  return normalise(a.text) !== normalise(b.text);
});

const hostPathLeak = JSON.stringify(fixedRun.result).includes(tmpRoot) || JSON.stringify(fixedRun.result).includes(os.homedir());

const detail = Object.fromEntries(answerFaces.map((n) => [n, {
  carrier: {
    exit: carrierRun.result.cases[n].exit,
    code: carrierRun.result.cases[n].code,
    answer: carrierRun.result.cases[n].answer === true,
    fix: carrierRun.result.cases[n].fix ?? null,
    error: normalise(carrierRun.result.cases[n].error || ''),
  },
  fixed: {
    exit: fixedRun.result.cases[n].exit,
    code: fixedRun.result.cases[n].code,
    answer: fixedRun.result.cases[n].answer === true,
    fix: fixedRun.result.cases[n].fix ?? null,
    error: normalise(fixedRun.result.cases[n].error || ''),
  },
}]));

const controlsDetail = Object.fromEntries(controls.map((n) => [n, {
  carrier: {
    exit: carrierRun.result.cases[n].exit,
    code: carrierRun.result.cases[n].code ?? null,
    fix: carrierRun.result.cases[n].fix ?? null,
    answer: carrierRun.result.cases[n].answer === true,
    green: carrierRun.result.cases[n].green,
  },
  fixed: {
    exit: fixedRun.result.cases[n].exit,
    code: fixedRun.result.cases[n].code ?? null,
    fix: fixedRun.result.cases[n].fix ?? null,
    answer: fixedRun.result.cases[n].answer === true,
    green: fixedRun.result.cases[n].green,
  },
}]));

const artifact = {
  tool: 'tools/measure-answer-voice-published.mjs',
  measuredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  question: 'do the store answers reach a stranger with a branchable code and their own answer semantics, or as bare prose indistinguishable from a refusal?',
  carrier: { requested: CARRIER, installed: carrierRun.installedVersion },
  fixed: { requested: FIXED, installed: fixedRun.installedVersion },
  faces,
  answerFaces,
  controls,
  detail,
  controlsDetail,
  carrierUnnamedFaces: carrierUnnamed,
  fixedUnnamedFaces: fixedUnnamed,
  fixedUnmarkedFaces: fixedUnmarked,
  fixedRepairedFaces: fixedRepaired,
  fixedWrongChannelFaces: fixedWrongChannel,
  fixedWrongSentenceFaces: fixedWrongSentence,
  controlRegression: controlChanged,
  hostPathLeak,
};

const verdict = {
  carrierUnnamedFaces: carrierUnnamed.length,
  fixedUnnamedFaces: fixedUnnamed.length,
  fixedUnmarkedFaces: fixedUnmarked.length,
  fixedRepairedFaces: fixedRepaired.length,
  fixedWrongChannelFaces: fixedWrongChannel.length,
  fixedWrongSentenceFaces: fixedWrongSentence.length,
  controlRegression: controlChanged.length,
};
artifact.verdict = verdict;
artifact.verdictName = verdict.carrierUnnamedFaces > 0 && verdict.fixedUnnamedFaces === 0
  && verdict.fixedUnmarkedFaces === 0 && verdict.fixedRepairedFaces === 0
  && verdict.fixedWrongChannelFaces === 0 && verdict.fixedWrongSentenceFaces === 0
  && verdict.controlRegression === 0 && !hostPathLeak
  ? 'answer-voice-held-on-the-published-channel' : 'answer-voice-not-held';

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
  || verdict.fixedUnmarkedFaces !== 0
  || verdict.fixedRepairedFaces !== 0
  || verdict.fixedWrongChannelFaces !== 0
  || verdict.fixedWrongSentenceFaces !== 0
  || verdict.controlRegression !== 0
  || hostPathLeak
  || CARRIER === FIXED;
process.exit(falsified ? 1 : 0);
