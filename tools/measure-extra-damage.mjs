#!/usr/bin/env node
// tools/measure-extra-damage.mjs — DOES `verify` AGREE WITH `lock` ABOUT A
// STORE WHOSE EXTRA PROGRAM IS DAMAGED?
//
// The defect this measures (sememe card "sememe: lokale Bedeutungsebene
// qualifizieren, Abdeckung zuerst messen"), measured 2026-11-07 on this host:
//
//   store  = Whirlpool, locked; Jupiter pulled LATER -> it is an EXTRA
//            (the lock pins minimums, not store equality).
//   damage = Jupiter's object rewritten so it no longer re-hashes to the
//            fingerprint its receipt claims. The STORE READER refuses it:
//            `sememe decode <jupiter> <payload>` exits 1 with
//            "object and receipt disagree, refusing to decode".
//
//     sememe lock   over that store -> EXIT 1, no lock written
//     sememe verify over that store -> EXIT 0, violations 0   <- the defect
//
// Two commands, two verdicts about ONE store, and a GREEN CI gate over a
// program the reader refuses — the exact class this repo killed for the
// newest-receipt path on 2026-11-07 ("writeLock and checkLock share ONE
// helper, so lock and verify cannot disagree about what a clean store is").
// The helper was shared; only the PINNED loop ever called it, so the promise
// held for pinned programs and stopped holding one level down.
//
// WHAT THIS TOOL MEASURES, against any CLI binary (--bin, default this tree):
//   S1  lock over the store with the damaged extra: must exit 1, write nothing.
//   S2  verify --mode error over the SAME store: must exit 1 and name the
//       program (it exited 0 before the fix).
//   S3  verify --mode warn: must COUNT the damage (violations >= 1) and mark
//       its scope as `extra`, so pin drift is not misread as the cause.
//   S4  the repair: `sememe lock` over the store again names the program, and
//       re-pulling that program's object makes verify green — the violation
//       must be fixable, not just reportable.
//   S5  control, two stores that must stay green on BOTH binaries: an INTACT
//       extra is never a violation, and a damaged PINNED program is still
//       named. Neither may turn red because of this fix.
//
// Every field comes from an exit code or a parsed JSON answer; nothing is
// asserted by hand. Exit 0 = the binary meets the contract, exit 1 = at least
// one contract violation, exit 3 = no verdict (binary could not run).
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
/** First positional that is neither a flag nor a flag's value — reading
 * process.argv[2] blindly once wrote a file named "--bin". */
const positional = () => {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) { i++; continue; }
    return arg;
  }
  return null;
};
const BIN = flag('--bin', path.join(ROOT, 'bin', 'sememe.mjs'));
const OUT = flag('--out', positional() ?? path.join(ROOT, 'research', 'extra-damage-2026-11-07.json'));
const TAG = flag('--tag', null);

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const WHIRLPOOL_IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');
const JUPITER_IDL = path.join(ROOT, 'fixtures_probe_does_not_exist.json'); // replaced below
const JUPITER_IDL_PATH = fs.existsSync(path.join(ROOT, 'test', 'fixtures', 'jupiter-amm-v6-idl.json'))
  ? path.join(ROOT, 'test', 'fixtures', 'jupiter-amm-v6-idl.json') : JUPITER_IDL;
void JUPITER_IDL;

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
/** verify prints the REPORT first and a note object after it: stdout is two
 * concatenated JSON documents. Take the FIRST complete one — the report. */
const firstJson = (out) => {
  let depth = 0, start = -1, inString = false, escape = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { try { return JSON.parse(out.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
};
const statusOf = (r) => (r.error ? null : r.status);
const runs = (r) => !r.error && r.status === 0;

function freshStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
  return dir;
}
const adopt = (dir, program, file) => run(['adopt', program, file, '--store', dir, '--source', 'metadata']);
const receiptFingerprints = (dir, program) => fs.readdirSync(path.join(dir, 'receipts'))
  .filter((n) => n.startsWith(`${program}-`))
  .map((n) => `sha256:${n.slice(n.lastIndexOf('-') + 1, -'.json'.length)}`);

/** Store whose lock pins Whirlpool, with Jupiter as an EXTRA, optionally
 * damaged so the store reader refuses it. */
function damagedExtraStore({ damage }) {
  const dir = freshStore('sememe-extra-damage-');
  const a = adopt(dir, WHIRLPOOL, WHIRLPOOL_IDL);
  if (!runs(a)) throw Error(`adopt whirlpool failed: ${a.stderr || a.stdout}`);
  const lockPath = path.join(dir, 'sememe.lock');
  const lock = run(['lock', '--store', dir, '--out', lockPath]);
  if (!runs(lock)) throw Error(`lock failed: ${lock.stderr || lock.stdout}`);
  const b = adopt(dir, JUPITER, JUPITER_IDL_PATH);
  if (!runs(b)) throw Error(`adopt jupiter failed: ${b.stderr || b.stdout}`);
  const fingerprint = receiptFingerprints(dir, JUPITER)[0].replace(/^sha256:/, '');
  if (damage) {
    fs.writeFileSync(path.join(dir, 'objects', `${fingerprint}.json`), '{"instructions":[]}\n');
  }
  return { dir, lockPath, fingerprint };
}
/** Store whose lock pins Whirlpool only, with Jupiter intact as an extra. */
const intactExtraStore = () => damagedExtraStore({ damage: false });

function intactPinnedStore() {
  const dir = freshStore('sememe-pinned-damage-');
  const a = adopt(dir, WHIRLPOOL, WHIRLPOOL_IDL);
  if (!runs(a)) throw Error(`adopt whirlpool failed: ${a.stderr || a.stdout}`);
  const lockPath = path.join(dir, 'sememe.lock');
  const lock = run(['lock', '--store', dir, '--out', lockPath]);
  if (!runs(lock)) throw Error(`lock failed: ${lock.stderr || lock.stdout}`);
  const fingerprint = receiptFingerprints(dir, WHIRLPOOL)[0].replace(/^sha256:/, '');
  fs.writeFileSync(path.join(dir, 'objects', `${fingerprint}.json`), '{"instructions":[]}\n');
  return { dir, lockPath, fingerprint };
}

/** Repair: clear the damaged receipt+object (the stale bytes still occupy
 * the fingerprint's path, so a re-pull would collide — measured: adopt
 * refuses with `digest collision or corrupted local object`), re-pull the
 * program, then the gate must go green — a violation nobody can clear is not
 * a gate, and the refusal names no repair it cannot perform. */
function repair(store) {
  const receipts = path.join(store.dir, 'receipts');
  let removed = 0;
  for (const name of fs.readdirSync(receipts)) {
    if (!name.startsWith(`${JUPITER}-`)) continue;
    const fingerprint = name.slice(name.lastIndexOf('-') + 1, -'.json'.length);
    fs.rmSync(path.join(store.dir, 'objects', `${fingerprint}.json`), { force: true });
    fs.rmSync(path.join(receipts, name), { force: true });
    removed++;
  }
  if (!removed) return { repaired: false, why: 'no damaged receipt found to repair' };
  const again = adopt(store.dir, JUPITER, JUPITER_IDL_PATH);
  if (!runs(again)) return { repaired: false, why: `re-pull failed: ${again.stderr || again.stdout}` };
  const verify = run(['verify', '--store', store.dir, '--lock', store.lockPath, '--mode', 'error']);
  return { repaired: statusOf(verify) === 0, removedReceipts: removed, exit: statusOf(verify) };
}

const violations = [];
const measure = () => {
  // S1/S2/S3 — the damaged extra.
  const damaged = damagedExtraStore({ damage: true });
  try {
    const secondLockPath = path.join(damaged.dir, 'second.lock');
    const lockRun = run(['lock', '--store', damaged.dir, '--out', secondLockPath]);
    const s1 = {
      lockExit: statusOf(lockRun),
      lockFileWritten: fs.existsSync(secondLockPath),
      namesProgram: `${lockRun.stderr || ''}${lockRun.stdout || ''}`.includes(JUPITER),
    };
    if (s1.lockExit !== 1 || s1.lockFileWritten) {
      violations.push(`S1: lock must exit 1 and write nothing over a store with a damaged extra (got exit ${s1.lockExit}, file ${s1.lockFileWritten})`);
    }

    const errRun = run(['verify', '--store', damaged.dir, '--lock', damaged.lockPath, '--mode', 'error']);
    const errOut = `${errRun.stdout}\n${errRun.stderr}`;
    const s2 = { verifyErrorExit: statusOf(errRun), namesProgram: errOut.includes(JUPITER) };
    if (s2.verifyErrorExit !== 1) violations.push(`S2: verify --mode error exited ${s2.verifyErrorExit} over a store the reader refuses`);
    if (!s2.namesProgram) violations.push('S2: the refusal did not name the damaged program');

    const warnRun = run(['verify', '--store', damaged.dir, '--lock', damaged.lockPath, '--mode', 'warn']);
    const report = firstJson(warnRun.stdout);
    const entry = report?.unverified?.find((u) => u.program === JUPITER);
    const s3 = {
      verifyWarnExit: statusOf(warnRun),
      violations: report?.violations ?? null,
      unverified: (report?.unverified ?? []).map((u) => ({ program: u.program, scope: u.scope ?? null, receipt: u.receipt })),
      extra: report?.extra ?? [],
      hasScope: entry ? entry.scope === 'extra' : false,
    };
    if (!(s3.violations >= 1)) violations.push(`S3: warn mode counted ${s3.violations} violations over damage`);
    if (!s3.hasScope) violations.push('S3: the damaged extra is not marked scope=extra');

    const s4 = repair(damaged);
    if (!s4.repaired) violations.push(`S4: the violation could not be repaired (${s4.why ?? `verify exit ${s4.exit}`})`);
    return { s1, s2, s3, s4 };
  } finally { fs.rmSync(damaged.dir, { recursive: true, force: true }); }
};

const measureControls = () => {
  // S5a: an INTACT extra must never be a violation (either binary).
  const intact = intactExtraStore();
  let s5a;
  try {
    const runv = run(['verify', '--store', intact.dir, '--lock', intact.lockPath, '--mode', 'error']);
    const report = firstJson(runv.stdout);
    s5a = { verifyExit: statusOf(runv), violations: report?.violations ?? null, extra: report?.extra ?? [] };
    if (s5a.verifyExit !== 0 || s5a.violations !== 0) {
      violations.push(`S5a: an INTACT extra became a violation (exit ${s5a.verifyExit}, violations ${s5a.violations})`);
    }
  } finally { fs.rmSync(intact.dir, { recursive: true, force: true }); }

  // S5b: a damaged PINNED program must still be named (no move, no loss).
  const pinned = intactPinnedStore();
  let s5b;
  try {
    const runv = run(['verify', '--store', pinned.dir, '--lock', pinned.lockPath, '--mode', 'warn']);
    const report = firstJson(runv.stdout);
    s5b = { violations: report?.violations ?? null, unverified: (report?.unverified ?? []).map((u) => u.program) };
    if (!(s5b.violations >= 1) || !s5b.unverified.includes(WHIRLPOOL)) {
      violations.push('S5b: a damaged PINNED program stopped being reported');
    }
  } finally { fs.rmSync(pinned.dir, { recursive: true, force: true }); }
  return { s5a, s5b };
};

// binary probe: can this binary run at all?
const probe = run(['--help']);
if (probe.error) {
  console.error(`no verdict: cannot run ${BIN}: ${probe.error.message}`);
  process.exit(3);
}
let result, controls;
try {
  result = measure();
  controls = measureControls();
} catch (error) {
  console.error(`no verdict: ${String(error.message).slice(0, 300)}`);
  process.exit(3);
}

const report = {
  measuredAt: new Date().toISOString(),
  // A committed artifact that carries the HOST PATH of the binary is a
  // snapshot, not an artifact: CI runs the binary from a different directory
  // and the comparison fails on a path that never was the point (measured
  // 2026-11-07 13:5x on the declared-origin artifact, which had to be fixed
  // in f700942). A binary inside this repo is named RELATIVE to the repo; a
  // foreign install (a published tag in a scratch app) has no path inside the
  // repo at all, so it is named by the command that produced it.
  binary: (() => {
    const relative = path.relative(ROOT, BIN);
    const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    return {
      path: inside ? relative : null,
      tag: TAG,
      ...(inside ? {} : { install: 'npm install github:auroraxo/sememe#<tag>' }),
    };
  })(),
  contract: 'verify must not call clean a store the store reader refuses, even when the damaged program is an EXTRA the lock never pinned',
  defect: {
    kind: 'verify-green-over-damaged-extra',
    description: 'checkLock re-verified only PINNED programs; writeLock re-verified every receipt, so lock refused a store verify called clean (violations 0, exit 0) — a green CI gate over a program whose decode exits 1',
  },
  cases: result,
  controls: controls,
  verdict: { ok: violations.length === 0, violations },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out: path.relative(ROOT, OUT), tag: TAG, ok: report.verdict.ok, violations: report.verdict.violations }, null, 2));
process.exit(report.verdict.ok ? 0 : 1);
