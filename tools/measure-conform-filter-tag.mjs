#!/usr/bin/env node
// measure-conform-filter-tag — does the PUBLISHED install refuse a filter
// that selects nothing?
//
// WHY THIS IS NOT THE SAME AS THE WORKING-TREE MEASUREMENT
// (tools/measure-conform-filter.mjs):
//   The working-tree measurement asks whether THIS code refuses. It cannot
//   say what a stranger receives. This repo has measured that gap nine
//   times now — "main fixed, the pin pointing behind it" — and the release
//   surface instrument exists precisely because the pin and the tag drift
//   apart. So this tool installs the PUBLISHED TAGS into an empty directory
//   and runs the same cases against the bytes a stranger gets.
//
// WHAT IT MEASURES (per tag):
//   filterMiss     --only <real program id the transaction never invokes>
//                    -> the defect: exit 0, instructions 0
//   filterGarbage  --only not-a-program-id
//                    -> the same empty green
//   match          --only <a program the transaction does invoke>
//                    -> the control: must still run and produce rows
//   noFilter       (no --only)
//                    -> the control: must still check every instruction
//
//   A tag is VERDICTED, not compared blindly:
//     * a tag whose filterMiss/filterGarbage exit 0 over 0 instructions
//       carries the defect (the pre-fix tag does)
//     * a tag whose match/noFilter controls fail carries a BROKEN conform
//       path (worse than the defect)
//     * a tag that refuses both defect cases with the named reasons and
//       keeps both controls working is CLEAN
//
// NO VERDICT (exit 3) if the tag cannot be installed or the store fixture is
// missing: an unmeasured tag is never called clean.
//
// Usage: node tools/measure-conform-filter-tag.mjs [--tags v0.4.12,v0.4.13]
//                                                [--out <file>]
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
const TAGS = flag('--tags', 'v0.4.12,v0.4.13').split(',').map((t) => t.trim()).filter(Boolean);
const OUT = flag('--out', path.join(ROOT, 'research', 'conform-filter-tag-2026-11-09.json'));

const TX = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');
const STORE_SRC = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');
const UNINVOKED = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const INVOKED = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

if (!fs.existsSync(TX) || !fs.existsSync(STORE_SRC)) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: 'the tx fixture or the store fixture is missing' }));
  process.exit(3);
}

function runCase(cwd, args) {
  const result = spawnSync(process.execPath, [path.join(cwd, 'node_modules', 'sememe', 'bin', 'sememe.mjs'),
    'conform', TX, '--store', path.join(cwd, 'store'), ...args],
  { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = String(result.stdout || '');
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* refusal text, not JSON */ }
  const reason = (String(result.stderr || '') + out).match(/conformance refused: ([a-z0-9-]+)/)?.[1] ?? null;
  return {
    exit: result.status,
    instructions: parsed?.summary?.instructions ?? null,
    rows: Array.isArray(parsed?.rows) ? parsed.rows.length : null,
    refusalReason: reason,
  };
}

function measureTag(tag) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `sememe-cftag-${tag.replace(/[^\w.]/g, '_')}-`));
  try {
    fs.mkdirSync(path.join(work, 'store'), { recursive: true });
    fs.cpSync(STORE_SRC, path.join(work, 'store'), { recursive: true });
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'tag-journey', private: true, version: '0.0.0' }));
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `github:auroraxo/sememe#${tag}`],
      { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (install.status !== 0) {
      return { tag, error: `install failed: ${String(install.stderr || install.stdout).slice(0, 300)}` };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'node_modules', 'sememe', 'package.json'), 'utf8'));
    const cases = {
      filterMiss: runCase(work, ['--only', UNINVOKED]),
      filterGarbage: runCase(work, ['--only', 'not-a-program-id']),
      match: runCase(work, ['--only', INVOKED]),
      noFilter: runCase(work, []),
    };
    const greenOverNothing = ['filterMiss', 'filterGarbage'].filter((n) => cases[n].exit === 0 && (cases[n].instructions ?? 0) === 0);
    const controlsBroken = ['match', 'noFilter'].filter((n) => cases[n].exit === 0 && (cases[n].instructions ?? 0) === 0);
    const verdict = greenOverNothing.length > 0
      ? 'carries-the-defect'
      : (controlsBroken.length > 0 ? 'broken-controls' : 'refuses');
    return { tag, installedVersion: pkg.version, cases, greenOverNothing, controlsBroken, verdict };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const results = TAGS.map((tag) => measureTag(tag));
const unmeasurable = results.filter((r) => r.error);
if (unmeasurable.length > 0) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: 'a tag could not be installed', unmeasurable }, null, 2));
  process.exit(3);
}

const artifact = {
  tool: 'tools/measure-conform-filter-tag.mjs',
  measuredAt: new Date().toISOString(),
  tags: results,
  // the fix is only in the delivery if the newest tag refuses and an older
  // one is shown to have carried the defect
  ok: results.some((r) => r.verdict === 'carries-the-defect') && results.some((r) => r.verdict === 'refuses'),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.ok ? 0 : 1);
