#!/usr/bin/env node
// tools/lock-nothing-pinned-probe.mjs — DOES LOCK/VERIFY GO GREEN OVER A
// LOCK THAT PINS NOTHING?
//
// Copied byte-identically into both trees by tools/measure-lock-nothing-pinned.mjs
// (pre-fix prefix tree and this worktree), so only the src/ under test differs.
//
// Four cases, all offline, all built from the tree's own committed fixtures:
//
//   lockEmptyStore   `sememe lock` on a store whose receipts/ exists but is
//                    empty -> the defect: exit 0 and a file pinning 0 programs.
//   verifyEmptyLock  `sememe verify --mode error` over a hand-written
//                    `{"lockVersion":1,"programs":{}}` against the REAL
//                    18-program fixture store -> the defect: exit 0,
//                    pinned 0, violations 0 (every program an `extra`).
//   verifyEmptyLockWarn  the same in `--mode warn`.
//   guardRealLock    control: lock a REAL store, then verify it -> must be
//                    exit 0 / exit 0 in both trees (the fix must not break
//                    the ordinary journey).
//
// Exit 0 with JSON on stdout; exit 3 if a fixture is missing (the caller
// reports NO VERDICT rather than a clean measurement).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const STORE_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');

if (!fs.existsSync(BIN)) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: `no bin/sememe.mjs in ${ROOT}` }));
  process.exit(3);
}
if (!fs.existsSync(STORE_FIXTURE)) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: `fixture store missing: ${STORE_FIXTURE}` }));
  process.exit(3);
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = String(result.stdout ?? '');
  let report = null;
  try { report = JSON.parse(out); } catch { /* refusal text, not JSON */ }
  let errorText = null;
  try { errorText = JSON.parse(String(result.stderr ?? '')).error ?? null; } catch { /* not JSON */ }
  const reason = (errorText ?? String(result.stderr ?? '')).match(/lock-pins-nothing|no sememe store|lock-v1-[a-z]+/)?.[0] ?? null;
  return {
    exit: result.status,
    reason,
    ...(report && typeof report === 'object'
      ? {
          pinned: report.pinned ?? null,
          violations: report.violations ?? report.violations === 0 ? report.violations : null,
          pinnedPrograms: report.programs ? Object.keys(report.programs).length : null,
        }
      : {}),
    stdoutSnippet: out.slice(0, 400),
    stderrSnippet: String(result.stderr ?? '').slice(0, 400),
  };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-lockprobe-'));
try {
  // --- case 1: lock over a store with an EMPTY receipts/ directory
  const emptyStore = path.join(work, 'empty-store');
  fs.mkdirSync(path.join(emptyStore, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(emptyStore, 'receipts'), { recursive: true });
  const emptyLockPath = path.join(work, 'from-empty.lock');
  const lockEmptyStore = run(['lock', '--store', emptyStore, '--out', emptyLockPath], work);
  lockEmptyStore.lockFileWritten = fs.existsSync(emptyLockPath);
  if (lockEmptyStore.lockFileWritten) {
    const doc = JSON.parse(fs.readFileSync(emptyLockPath, 'utf8'));
    lockEmptyStore.lockPinnedPrograms = Object.keys(doc.programs ?? {}).length;
  }

  // --- case 2 + 3: verify over a HAND-WRITTEN empty lock against the real store
  const realStore = path.join(work, 'store');
  fs.cpSync(STORE_FIXTURE, realStore, { recursive: true });
  const forged = path.join(work, 'forged-empty.lock');
  fs.writeFileSync(forged, `${JSON.stringify({ lockVersion: 1, programs: {} })}\n`);
  const verifyEmptyLock = run(['verify', '--store', realStore, '--lock', forged, '--mode', 'error'], work);
  const verifyEmptyLockWarn = run(['verify', '--store', realStore, '--lock', forged, '--mode', 'warn'], work);

  // --- guard: the ordinary journey still runs in both trees
  const guardLockPath = path.join(work, 'real.lock');
  const guardLock = run(['lock', '--store', realStore, '--out', guardLockPath], work);
  const guardVerify = run(['verify', '--store', realStore, '--lock', guardLockPath, '--mode', 'error'], work);

  console.log(JSON.stringify({
    cases: {
      lockEmptyStore,
      verifyEmptyLock,
      verifyEmptyLockWarn,
      guardRealLock: { lock: guardLock, verify: guardVerify },
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: String(error?.message ?? error).slice(0, 400) }));
  process.exit(3);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
