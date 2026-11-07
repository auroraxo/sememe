#!/usr/bin/env node
// tools/measure-multi-copy-store.mjs — DOES ONE STORE ANSWER WITH ONE
// ANSWER, whichever entry point asks?
//
// The defect this measures (sememe card "sememe: lokale Bedeutungsebene
// qualifizieren, Abdeckung zuerst messen"), measured on the PUBLISHED v0.4.8
// install (github:auroraxo/sememe#v0.4.8 in an empty app, no clone):
//
//   store = two ADOPTED copies of the same pump.fun program:
//     a35349f3…  pump-published-idl.json  (56 instructions, knows sell_v3)
//     5a00cdb8…  pump-idl.json            (47 instructions, does NOT know sell_v3)
//
//     sememe decode         -> sell_v3, fingerprint a35349f3…     EXIT 0
//     sememe decode --union -> REFUSED "unknown instruction
//                              discriminator 1c92de7726c469d5"    EXIT 1
//     sememe lock           -> pinned a35349f3…                   EXIT 0
//     sememe verify         -> violations 0     (over a store whose SECOND
//                                                copy was DAMAGED) EXIT 0
//
//   One store, two verdicts depending on the flag passed — and a green CI
//   gate over damage. Two independent holes:
//
//     H1 src/store-read.mjs sorted adopted receipts by their LABEL (the origin
//        the CALLER typed) while the plain reader and src/lock.mjs sorted by
//        receipt FILENAME (which ends in the FINGERPRINT). Two sorts, two
//        winners, no disagreement reported.
//     H2 src/lock.mjs re-checked only the NEWEST receipt per program, so a
//        damaged second copy — the very copy union decode reads as its
//        secondary — was skipped in silence, contradicting README's "every
//        receipt is re-checked through the store reader first".
//
// WHAT THIS TOOL MEASURES, against any CLI binary (--bin, default this tree):
//   S1  plain decode and union decode of the SAME payload from the SAME
//       two-copy store: do they name the same fingerprint, and both exit 0?
//   S2  lock over that store after the SECOND copy is damaged: must exit 1
//       and write no lock (the README's "no lock, never a lock over damage").
//   S3  lock first, then damage the second copy, then verify --mode error:
//       must name the damaged receipt as unverified and exit 1.
//   S4  control, single-copy store: plain + union agree and lock/verify stay
//       green — the fix must not turn a clean store red.
//
// Every field is derived from an exit code or a parsed JSON answer; nothing
// is asserted by hand. Exit 0 = the binary behaved as the contract says,
// exit 1 = at least one contract violation (printed in the report), exit 3 =
// no verdict (the binary could not be run at all).

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
/** The output path: `--out <file>` wins; otherwise the first positional
 * argument that is NOT the value of a flag. Reading process.argv[2]
 * blindly once wrote a file literally named "--bin" — the positional is
 * taken only when it is not a flag and not a flag's value. */
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
const OUT = flag('--out', positional() ?? path.join(ROOT, 'research', 'multi-copy-store-2026-11-07.json'));
const TAG = flag('--tag', null); // recorded provenance of the binary, e.g. "v0.4.8"

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SELL_V3 = '3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b'; // real mainnet sell_v3 payload
const DOCS_COPY = path.join(ROOT, 'test', 'fixtures', 'pump-published-idl.json'); // 56 ix, knows sell_v3
const SDK_COPY = path.join(ROOT, 'test', 'fixtures', 'pump-idl.json'); // 47 ix, does not

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
const stdoutJson = (out) => { try { return JSON.parse(out); } catch { return null; } };
/** verify --mode warn prints the REPORT first and a note object after it, so
 * stdout is two concatenated JSON documents. Take the FIRST complete one —
 * that is the report with unverified[] in it. */
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
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) return stdoutJson(out.slice(start, i + 1)); }
  }
  return null;
};

function adoptTwice(dir) {
  const a = run(['adopt', PUMP, DOCS_COPY, '--store', dir, '--source', 'published', '--origin', 'docs-copy']);
  if (a.status !== 0) throw Error(`adopt #1 failed: ${a.stderr || a.stdout}`);
  const b = run(['adopt', PUMP, SDK_COPY, '--store', dir, '--source', 'published', '--origin', 'sdk-copy']);
  if (b.status !== 0) throw Error(`adopt #2 failed: ${b.stderr || b.stdout}`);
  // The fingerprints come from the MEASURED BINARY'S OWN receipts, never
  // from this tree's canonicalization: the tool may be pointed at a foreign
  // build (--bin, e.g. the published v0.4.8 install) and must not assume the
  // two trees agree on anything except the receipt filename format.
  const receipts = fs.readdirSync(path.join(dir, 'receipts'))
    .filter((name) => name.startsWith(`${PUMP}-`));
  const fingerprints = receipts
    .map((name) => `sha256:${name.slice(name.lastIndexOf('-') + 1, -'.json'.length)}`)
    .sort();
  if (fingerprints.length !== 2) {
    throw Error(`expected exactly two adopted receipts for ${PUMP}, found ${fingerprints.length}: ${receipts.join(', ')}`);
  }
  return fingerprints;
}

/** Damage one stored object the way the 2026-10-30 defect was found:
 *  valid JSON, one instruction renamed, so it no longer re-hashes. */
function damage(dir, fingerprint) {
  const file = path.join(dir, 'objects', `${fingerprint.replace(/^sha256:/, '')}.json`);
  const object = JSON.parse(fs.readFileSync(file, 'utf8'));
  object.instructions[0].name = `${object.instructions[0].name}_tampered`;
  fs.writeFileSync(file, `${JSON.stringify(object)}\n`);
}

/** The copy to damage is NOT hardcoded: it is whichever copy the plain reader
 *  does NOT answer with. That is the secondary source — the copy union decode
 *  reads as its second opinion, and the one the pre-fix lock skipped in
 *  silence. Hardcoding a fingerprint would make this tool measure a fixture;
 *  deriving it makes it measure the store the binary just built. */
function secondaryCopyOf(dir) {
  const decode = run(['decode', PUMP, SELL_V3, '--store', dir]);
  const answered = stdoutJson(decode.stdout)?.idl?.fingerprint;
  if (!answered) throw Error(`could not learn which copy the plain reader picks: ${decode.stderr || decode.stdout}`);
  const all = fs.readdirSync(path.join(dir, 'receipts'))
    .filter((name) => name.startsWith(`${PUMP}-`))
    .map((name) => `sha256:${name.slice(name.lastIndexOf('-') + 1, -'.json'.length)}`);
  const other = all.find((fp) => fp !== answered);
  if (!other) throw Error(`no second copy found for ${PUMP} (plain reader answered ${answered})`);
  return other;
}

function measure() {
  const verdict = { violations: [] };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-multicopy-measure-'));

  // ---- S1: one store, two entry points, one answer ------------------------
  const store1 = path.join(base, 'store-s1');
  fs.mkdirSync(store1);
  adoptTwice(store1);
  const plain = run(['decode', PUMP, SELL_V3, '--store', store1]);
  const union = run(['decode', PUMP, SELL_V3, '--store', store1, '--union']);
  const plainJson = stdoutJson(plain.stdout);
  const unionJson = stdoutJson(union.stdout);
  const s1 = {
    plainExit: plain.status,
    unionExit: union.status,
    plainFingerprint: plainJson?.idl?.fingerprint ?? null,
    unionFingerprint: unionJson?.idl?.fingerprint ?? null,
    plainInstruction: plainJson?.instruction ?? plainJson?.name ?? null,
    unionInstruction: unionJson?.instruction ?? unionJson?.name ?? null,
    unionVerdict: unionJson?.view?.verdict ?? null,
    sameFingerprint: (plainJson?.idl?.fingerprint ?? null) === (unionJson?.idl?.fingerprint ?? null)
      && plainJson?.idl?.fingerprint !== undefined,
  };
  if (plain.status !== 0) verdict.violations.push(`S1 plain decode exited ${plain.status}`);
  if (union.status !== 0) verdict.violations.push(`S1 union decode exited ${union.status}`);
  if (!s1.sameFingerprint) verdict.violations.push('S1 plain and union decode name DIFFERENT copies of one store');

  // ---- S2: lock over a store whose SECOND copy is damaged ----------------
  const store2 = path.join(base, 'store-s2');
  fs.mkdirSync(store2);
  adoptTwice(store2);
  const secondary2 = secondaryCopyOf(store2);
  damage(store2, secondary2);
  const lockPath = path.join(base, 's2.lock');
  const lock = run(['lock', '--store', store2, '--out', lockPath]);
  const s2 = {
    lockExit: lock.status,
    lockFileWritten: fs.existsSync(lockPath),
    error: (lock.stderr || lock.stdout).trim().slice(0, 400) || null,
  };
  if (lock.status === 0) verdict.violations.push('S2 lock exited 0 over a store whose second copy is damaged');
  if (s2.lockFileWritten) verdict.violations.push('S2 lock file was written over a damaged store');

  // ---- S3: lock CLEAN, then damage, then verify must name it -------------
  const store3 = path.join(base, 'store-s3');
  fs.mkdirSync(store3);
  adoptTwice(store3);
  const lock3 = path.join(base, 's3.lock');
  const write3 = run(['lock', '--store', store3, '--out', lock3]);
  const secondary3 = secondaryCopyOf(store3);
  damage(store3, secondary3);
  // warn mode: the full REPORT (with unverified[] named) is printed and the
  // process exits 0 — that is how the damaged receipt gets named at all.
  const verifyWarn = run(['verify', '--store', store3, '--lock', lock3, '--mode', 'warn']);
  // error mode: the CI gate — must exit 1 when the same damage is present.
  const verifyError = run(['verify', '--store', store3, '--lock', lock3, '--mode', 'error']);
  const verifyJson = firstJson(verifyWarn.stdout);
  const s3 = {
    lockOnCleanExit: write3.status,
    verifyWarnExit: verifyWarn.status,
    verifyErrorExit: verifyError.status,
    damagedCopy: secondary3,
    violations: verifyJson?.violations ?? null,
    unverified: (verifyJson?.unverified ?? []).map((u) => ({
      program: u.program,
      receipt: u.receipt,
      reasonHead: String(u.reason ?? '').slice(0, 120),
    })),
    verified: verifyJson?.verified ?? null,
  };
  if (write3.status !== 0) verdict.violations.push(`S3 lock on the clean store exited ${write3.status}`);
  if (verifyError.status === 0) verdict.violations.push('S3 verify --mode error exited 0 over a damaged store');
  if (verifyWarn.status !== 0) verdict.violations.push(`S3 verify --mode warn exited ${verifyWarn.status}`);
  if (!s3.unverified.length) verdict.violations.push('S3 verify did not name the damaged receipt as unverified');
  if (s3.unverified.length && !String(s3.unverified[0].receipt).includes(secondary3.replace(/^sha256:/, ''))) {
    verdict.violations.push('S3 verify named a DIFFERENT receipt than the damaged copy');
  }
  if (s3.violations !== null && s3.violations < 1) verdict.violations.push('S3 verify reported 0 violations over a damaged store');

  // ---- S4: control — a single-copy store must stay green ------------------
  const store4 = path.join(base, 'store-s4');
  fs.mkdirSync(store4);
  const one = run(['adopt', PUMP, DOCS_COPY, '--store', store4, '--source', 'published', '--origin', 'only-copy']);
  const plain4 = run(['decode', PUMP, SELL_V3, '--store', store4]);
  const union4 = run(['decode', PUMP, SELL_V3, '--store', store4, '--union']);
  const lock4 = path.join(base, 's4.lock');
  const write4 = run(['lock', '--store', store4, '--out', lock4]);
  const verify4 = run(['verify', '--store', store4, '--lock', lock4, '--mode', 'error']);
  const p4 = stdoutJson(plain4.stdout);
  const u4 = stdoutJson(union4.stdout);
  const s4 = {
    adoptExit: one.status,
    plainExit: plain4.status,
    unionExit: union4.status,
    sameFingerprint: p4?.idl?.fingerprint === u4?.idl?.fingerprint && p4?.idl?.fingerprint !== undefined,
    verdict: u4?.view?.verdict ?? null,
    adoptedOnly: u4?.view?.adoptedOnly ?? null,
    lockExit: write4.status,
    verifyExit: verify4.status,
  };
  if (one.status !== 0) verdict.violations.push(`S4 adopt exited ${one.status}`);
  if (plain4.status !== 0 || union4.status !== 0) verdict.violations.push('S4 single-copy decode failed');
  if (!s4.sameFingerprint) verdict.violations.push('S4 single-copy plain and union disagree');
  if (write4.status !== 0) verdict.violations.push(`S4 lock on a clean single-copy store exited ${write4.status}`);
  if (verify4.status !== 0) verdict.violations.push(`S4 verify on a clean single-copy store exited ${verify4.status}`);

  verdict.ok = verdict.violations.length === 0;
  fs.rmSync(base, { recursive: true, force: true });
  return { twoCopies: { s1, s2, s3 }, controlSingleCopy: s4, verdict };
}

const measured = measure();
const report = {
  generatedAt: new Date().toISOString(),
  tool: 'tools/measure-multi-copy-store.mjs',
  question: 'does one store answer with one answer, whichever entry point asks?',
  binary: { path: path.relative(ROOT, BIN) || BIN, tag: TAG ?? null, tree: BIN.startsWith(ROOT) ? 'this tree' : 'external' },
  contract: {
    S1: 'plain decode and union decode of one payload from one two-copy store name the SAME fingerprint and both exit 0',
    S2: 'lock over a store whose second copy is damaged exits 1 and writes no file',
    S3: 'lock clean, then damage, then verify exits 1 in --mode error and names the damaged receipt as unverified in --mode warn',
    S4: 'control: a single-copy store decodes, locks and verifies green',
  },
  ...measured,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
process.exit(report.verdict.ok ? 0 : 1);
