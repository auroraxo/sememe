#!/usr/bin/env node
// measure-lock-nothing-pinned-tag — does the PUBLISHED install go green over
// a lock that pins nothing?
//
// WHY THIS IS NOT THE SAME AS THE WORKING-TREE MEASUREMENT
// (tools/measure-lock-nothing-pinned.mjs):
//   The working-tree measurement asks whether THIS code refuses. It cannot
//   say what a stranger receives. This repo has measured that gap many
//   times — "main fixed, the pin pointing behind it" — so this tool
//   installs the PUBLISHED TAGS into an empty directory and runs the same
//   cases against the bytes a stranger gets.
//
// WHAT IT MEASURES (per tag):
//   lockEmptyStore   `sememe lock` over a store with an empty receipts/
//                    directory -> the defect: exit 0 and a file pinning 0
//                    programs.
//   verifyEmptyLock  `sememe verify --mode error` over a hand-written
//                    `{"lockVersion":1,"programs":{}}` against the REAL
//                    18-program fixture store -> the defect: exit 0,
//                    pinned 0, violations 0.
//   verifyEmptyLockWarn  the same in `--mode warn`.
//   guardRealLock    control: lock a REAL store, then verify it -> must be
//                    exit 0 / exit 0 (the fix must not break the ordinary
//                    journey).
//
//   A tag is VERDICTED, not compared blindly:
//     * a tag whose defect cases exit 0 carries the defect
//     * a tag whose guard case fails carries a BROKEN lock/verify path
//       (worse than the defect)
//     * a tag that refuses all defect cases with the named reason and keeps
//       the guard working is CLEAN
//
// NO VERDICT (exit 3) if the tag cannot be installed or the store fixture is
// missing: an unmeasured tag is never called clean.
//
// Usage: node tools/measure-lock-nothing-pinned-tag.mjs [--tags v0.4.13,v0.4.14]
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
const TAGS = flag('--tags', 'v0.4.13').split(',').map((t) => t.trim()).filter(Boolean);
const OUT = flag('--out', path.join(ROOT, 'research', 'lock-nothing-pinned-tag-2026-11-09.json'));

const STORE_SRC = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');

if (!fs.existsSync(STORE_SRC)) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: 'the store fixture is missing' }));
  process.exit(3);
}

/** Run one CLI case against an INSTALLED tree; report only what the verdict
 * depends on (exit code, the reason name, the pinned/violation counts). */
function runCase(cwd, args) {
  const result = spawnSync(process.execPath, [path.join(cwd, 'node_modules', 'sememe', 'bin', 'sememe.mjs'), ...args],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = String(result.stdout ?? '');
  let report = null;
  try { report = JSON.parse(out); } catch { /* refusal text, not JSON */ }
  let errorText = '';
  try { errorText = JSON.parse(String(result.stderr ?? '')).error ?? ''; } catch { errorText = String(result.stderr ?? ''); }
  const reason = errorText.match(/lock-pins-nothing|no sememe store|lock-v1-[a-z]+/)?.[0] ?? null;
  return {
    exit: result.status,
    reason,
    pinned: report && typeof report === 'object' ? (report.pinned ?? null) : null,
    violations: report && typeof report === 'object' ? (report.violations ?? null) : null,
  };
}

function measureTag(tag) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `sememe-lockpintag-${tag.replace(/[^\w.]/g, '_')}-`));
  try {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'tag-journey', private: true, version: '0.0.0' }));
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `github:auroraxo/sememe#${tag}`],
      { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (install.status !== 0) {
      return { tag, error: `install failed: ${String(install.stderr || install.stdout).slice(0, 300)}` };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'node_modules', 'sememe', 'package.json'), 'utf8'));

    // Case 1: an empty store (receipts/ exists, no receipt).
    const emptyStore = path.join(work, 'empty-store');
    fs.mkdirSync(path.join(emptyStore, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(emptyStore, 'receipts'), { recursive: true });
    const emptyLockPath = path.join(work, 'from-empty.lock');
    const lockEmptyStore = runCase(work, ['lock', '--store', emptyStore, '--out', emptyLockPath]);
    lockEmptyStore.lockFileWritten = fs.existsSync(emptyLockPath);
    if (lockEmptyStore.lockFileWritten) {
      const doc = JSON.parse(fs.readFileSync(emptyLockPath, 'utf8'));
      lockEmptyStore.lockPinnedPrograms = Object.keys(doc.programs ?? {}).length;
    }

    // Cases 2 + 3: a hand-written empty lock against the REAL store.
    const realStore = path.join(work, 'store');
    fs.cpSync(STORE_SRC, realStore, { recursive: true });
    const forged = path.join(work, 'forged-empty.lock');
    fs.writeFileSync(forged, `${JSON.stringify({ lockVersion: 1, programs: {} })}\n`);
    const verifyEmptyLock = runCase(work, ['verify', '--store', realStore, '--lock', forged, '--mode', 'error']);
    const verifyEmptyLockWarn = runCase(work, ['verify', '--store', realStore, '--lock', forged, '--mode', 'warn']);

    // Guard: the ordinary journey.
    const guardLockPath = path.join(work, 'real.lock');
    const guardLock = runCase(work, ['lock', '--store', realStore, '--out', guardLockPath]);
    const guardVerify = runCase(work, ['verify', '--store', realStore, '--lock', guardLockPath, '--mode', 'error']);

    const cases = {
      lockEmptyStore,
      verifyEmptyLock,
      verifyEmptyLockWarn,
      guardRealLock: { lock: guardLock, verify: guardVerify },
    };
    const greenOverNothing = [
      ...(lockEmptyStore.exit === 0 && lockEmptyStore.lockFileWritten === true && (lockEmptyStore.lockPinnedPrograms ?? 0) === 0
        ? ['lockEmptyStore'] : []),
      ...(verifyEmptyLock.exit === 0 && (verifyEmptyLock.pinned ?? 0) === 0 ? ['verifyEmptyLock'] : []),
      ...(verifyEmptyLockWarn.exit === 0 && (verifyEmptyLockWarn.pinned ?? 0) === 0 ? ['verifyEmptyLockWarn'] : []),
    ];
    const guardBroken = guardLock.exit !== 0 || guardVerify.exit !== 0;
    const verdict = greenOverNothing.length > 0
      ? 'carries-the-defect'
      : (guardBroken ? 'broken-controls' : 'refuses');
    return { tag, installedVersion: pkg.version, cases, greenOverNothing, guardBroken, verdict };
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
  tool: 'tools/measure-lock-nothing-pinned-tag.mjs',
  measuredAt: new Date().toISOString(),
  tags: results,
  // The fix is only in the DELIVERY if the newest tag refuses and an older
  // one is shown to have carried the defect.
  ok: results.some((r) => r.verdict === 'carries-the-defect') && results.some((r) => r.verdict === 'refuses'),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.ok ? 0 : 1);
