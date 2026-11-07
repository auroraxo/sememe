#!/usr/bin/env node
// tools/measure-receipt-hygiene.mjs — DOES A CRASHED WRITE BRICK THE STORE?
//
// The defect this measures (sememe card "sememe: lokale Bedeutungsebene
// qualifizieren, Abdeckung zuerst messen"), measured 2026-11-07 on this host
// against the tree the published v0.4.10 carries (a7848d4):
//
//   sememe's OWN writer (src/store-write.mjs) installs every receipt and
//   object through a temporary file `<name>.tmp-<pid>-<random>` in the SAME
//   `receipts/` directory and removes it in a `finally`. A crash between the
//   write and the cleanup (SIGKILL, OOM, power loss) leaves that file behind
//   FOREVER. Every reader treated EVERY file in `receipts/` as a receipt:
//
//     sememe decode <program> <payload>   -> EXIT 1 "store receipt <tmp> is
//                                            unreadable: Unexpected token"
//     sememe decode --union <program> ... -> EXIT 1, same refusal
//     sememe lock                         -> EXIT 1 "Cannot destructure
//                                            property 'idl' ... as it is null"
//     sememe verify --mode error          -> EXIT 1, "unverified: <program>"
//
//   The last one is the worst: the CI gate went RED over an INTACT program
//   and named no repair — the user is told to re-pull a healthy store. One
//   crashed write permanently bricked a working store.
//
//   The same root cause produced phantom programs from FOREIGN files:
//   `.DS_Store` appeared as `extra`, and `my-file.json` became a phantom
//   program `my` that failed the gate over a file that was never a receipt.
//
// WHAT THIS TOOL MEASURES, against any CLI binary (--bin, default this tree):
//   H1  crash debris in receipts/ does not break `decode`.
//   H2  it does not break `decode --union`.
//   H3  it does not break `lock` (writeLock exits 0 and pins the program).
//   H4  it does not make `verify --mode error` fail — a crashed write must
//       not turn a clean store RED.
//   H5  the debris is still REPORTED by name and kind (stray), so it is
//       ignored but never silently.
//   H6  a foreign file (.DS_Store) is not a phantom program: `extra` stays
//       empty and the gate stays green.
//   H7  control: a DAMAGED receipt (object that no longer re-hashes) is
//       still refused and named — the fix must not have moved that line.
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
/** First positional that is neither a flag nor a flag's value. */
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
const OUT = flag('--out', positional() ?? path.join(ROOT, 'research', 'receipt-hygiene-2026-11-07.json'));
const TAG = flag('--tag', null);

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const WHIRLPOOL_IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');

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

/** A store with Whirlpool adopted and locked, `extraFiles` dropped into
 * receipts/ exactly as a crashed writer (or a stray file) would leave them. */
function storeWith({ extraFiles = [], damagePinned = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-receipt-hygiene-'));
  fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
  const adopt = run(['adopt', WHIRLPOOL, WHIRLPOOL_IDL, '--store', dir, '--source', 'metadata']);
  if (!runs(adopt)) throw Error(`adopt whirlpool failed: ${adopt.stderr || adopt.stdout}`);
  const lockPath = path.join(dir, 'sememe.lock');
  const lock = run(['lock', '--store', dir, '--out', lockPath]);
  if (!runs(lock)) throw Error(`lock failed: ${lock.stderr || lock.stdout}`);
  const receiptName = fs.readdirSync(path.join(dir, 'receipts')).find((n) => n.startsWith(`${WHIRLPOOL}-`));
  const fingerprint = receiptName.slice(receiptName.lastIndexOf('-') + 1, -'.json'.length);
  const debrisName = `${receiptName}.tmp-4711-9f2c1a`;
  for (const name of extraFiles) {
    const file = name === '@debris' ? debrisName : name;
    fs.writeFileSync(path.join(dir, 'receipts', file), name === '@debris' ? 'leftover bytes' : 'junk');
  }
  if (damagePinned) {
    fs.writeFileSync(path.join(dir, 'objects', `${fingerprint}.json`), '{"instructions":[]}\n');
  }
  return { dir, lockPath, debrisName, receiptName };
}

/** A payload the stored Whirlpool IDL decodes: the first 8-byte
 * discriminator of the fixture, followed by 8 zero bytes. */
function payloadFor() {
  const idl = JSON.parse(fs.readFileSync(WHIRLPOOL_IDL, 'utf8'));
  const ix = idl.instructions.find((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8);
  return Buffer.from([...ix.discriminator, ...new Array(8).fill(0)]).toString('hex');
}

const violations = [];
const measure = () => {
  const payload = payloadFor();
  const store = storeWith({ extraFiles: ['@debris'] });
  try {
    const h1 = run(['decode', '--store', store.dir, WHIRLPOOL, payload]);
    if (h1.status !== 0) violations.push(`H1: decode broke over crash debris (exit ${statusOf(h1)}: ${String(h1.stderr || h1.stdout).slice(0, 160)})`);

    const h2 = run(['decode', '--store', store.dir, '--union', WHIRLPOOL, payload]);
    if (h2.status !== 0) violations.push(`H2: decode --union broke over crash debris (exit ${statusOf(h2)}: ${String(h2.stderr || h2.stdout).slice(0, 160)})`);

    const secondLock = path.join(store.dir, 'second.lock');
    const h3 = run(['lock', '--store', store.dir, '--out', secondLock]);
    const h3ok = h3.status === 0 && fs.existsSync(secondLock);

    const errRun = run(['verify', '--store', store.dir, '--lock', store.lockPath, '--mode', 'error']);
    const warnRun = run(['verify', '--store', store.dir, '--lock', store.lockPath, '--mode', 'warn']);
    const report = firstJson(warnRun.stdout);
    const stray = report?.stray ?? [];
    const h4ok = errRun.status === 0 && report?.violations === 0;
    if (!h4ok) {
      violations.push(`H4: a crashed write turned a clean store RED (verify --mode error exit ${statusOf(errRun)}, violations ${report?.violations})`);
    }
    const h5ok = stray.some((s) => s.name === store.debrisName && s.kind === 'debris');
    if (!h5ok) violations.push(`H5: the crash debris is not reported by name and kind (stray: ${JSON.stringify(stray)})`);
    const h3okText = h3ok;
    if (!h3okText) violations.push(`H3: lock broke over crash debris (exit ${statusOf(h3)})`);

    return {
      h1: { decodeExit: statusOf(h1) },
      h2: { unionDecodeExit: statusOf(h2) },
      h3: { lockExit: statusOf(h3), lockFileWritten: fs.existsSync(secondLock) },
      h4: { verifyErrorExit: statusOf(errRun), verifyWarnViolations: report?.violations ?? null },
      h5: { stray },
    };
  } finally { fs.rmSync(store.dir, { recursive: true, force: true }); }
};

const measureControls = () => {
  // H6: a foreign file must never become a phantom program.
  const foreign = storeWith({ extraFiles: ['.DS_Store'] });
  let h6;
  try {
    const warnRun = run(['verify', '--store', foreign.dir, '--lock', foreign.lockPath, '--mode', 'warn']);
    const errRun = run(['verify', '--store', foreign.dir, '--lock', foreign.lockPath, '--mode', 'error']);
    const report = firstJson(warnRun.stdout);
    h6 = {
      verifyErrorExit: statusOf(errRun),
      violations: report?.violations ?? null,
      extra: report?.extra ?? [],
      stray: (report?.stray ?? []).map((s) => s.name),
    };
    if (h6.verifyErrorExit !== 0 || h6.violations !== 0) violations.push(`H6: a foreign file failed the gate (exit ${h6.verifyErrorExit}, violations ${h6.violations})`);
    if (h6.extra.length) violations.push(`H6: a foreign file became a phantom program: ${JSON.stringify(h6.extra)}`);
  } finally { fs.rmSync(foreign.dir, { recursive: true, force: true }); }

  // H7: a DAMAGED receipt must still be refused and named (no move, no loss).
  const damaged = storeWith({ damagePinned: true });
  let h7;
  try {
    const warnRun = run(['verify', '--store', damaged.dir, '--lock', damaged.lockPath, '--mode', 'warn']);
    const report = firstJson(warnRun.stdout);
    h7 = {
      violations: report?.violations ?? null,
      unverified: (report?.unverified ?? []).map((u) => u.program),
    };
    if (!(h7.violations >= 1) || !h7.unverified.includes(WHIRLPOOL)) {
      violations.push('H7: a damaged receipt stopped being refused and named');
    }
  } finally { fs.rmSync(damaged.dir, { recursive: true, force: true }); }
  return { h6, h7 };
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
  // snapshot, not an artifact (measured 2026-11-07 13:5x, fixed in f700942).
  binary: (() => {
    const relative = path.relative(ROOT, BIN);
    const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    return {
      path: inside ? relative : null,
      tag: TAG,
      ...(inside ? {} : { install: 'npm install github:auroraxo/sememe#<tag>' }),
    };
  })(),
  contract: 'a file in receipts/ that is not a receipt must not brick any surface, and a receipt that IS damaged must still be refused',
  defect: {
    kind: 'receipt-directory-read-as-receipts',
    description: "every reader treated EVERY file in receipts/ as a receipt; sememe's own crashed write (.tmp-<pid>-<hex>) left one behind forever, so decode/union/lock all exited 1 and verify turned a clean store red while .DS_Store became a phantom program",
  },
  cases: result,
  controls: controls,
  verdict: { ok: violations.length === 0, violations },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out: path.relative(ROOT, OUT), tag: TAG, ok: report.verdict.ok, violations: report.verdict.violations }, null, 2));
process.exit(report.verdict.ok ? 0 : 1);
