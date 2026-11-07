#!/usr/bin/env node
// tools/measure-declared-origin.mjs — DOES A DECLARED ORIGIN EVER READ AS A
// VERIFIED PROVENANCE, AND CAN IT BE REWRITTEN WITHOUT THE GATE NOTICING?
//
// The defect this measures (sememe card "sememe: lokale Bedeutungsebene
// qualifizieren, Abdeckung zuerst messen"), measured on the pre-fix tree
// 939b320 and on the PUBLISHED v0.4.10 install (which carries the same code):
//
//   1. THE LABEL IS A PROVENANCE CLAIM. `sememe adopt` writes a receipt whose
//      `origin` is whatever the caller typed, and EVERY reader surface then
//      presents that string as where the bytes came from:
//
//        adopt output : "origin": "solana-labs-anchor-deadbeef-does-not-exist.json"
//        reader label : "published (adopted, solana-labs-anchor-deadbeef-...)"
//        idlMeta      : { "origin": "solana-labs-anchor-deadbeef-..." }
//        union view   : primary.label = "published (adopted, solana-labs-...)"
//
//      Nothing checks that the named repo exists, that the file is there, or
//      that the bytes came from it at all.
//
//   2. THE LABEL IS NOT COVERED BY THE FINGERPRINT. The fingerprint covers
//      the OBJECT (the canonical IDL bytes); the RECEIPT — which carries the
//      declared origin — was covered by NOTHING. Measured: rewriting `origin`
//      in the receipt to `attacker/rewritten-origin` and running
//      `sememe verify --mode warn` reported
//        violations: 0   verified: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
//      The store's provenance label could be rewritten at will and the CI
//      gate stayed green.
//
//   3. THE SAME BYTES UNDER A DIFFERENT DECLARED ORIGIN COLLIDE. Two adopts
//      of ONE file with two different `--origin` values wrote the SAME
//      receipt filename with DIFFERENT contents, so the second write failed
//      with "digest collision or corrupted local object" — a reason that names
//      neither the origin nor the fact that the two receipts differ only in
//      their declared label. The caller is told their store is corrupt when
//      their store is fine.
//
// WHAT THIS TOOL MEASURES, against any CLI binary (--bin, default this tree):
//   T1  the reader surfaces: does an adopted copy's origin read as a DECLARED
//       label (never as a checked provenance), and does it carry its status?
//   T2  `sememe verify` over a store whose declared origin was REWRITTEN
//       after the fact: does the gate name it (and exit non-zero in error
//       mode), or does it report a clean store?
//   T3  the SAME bytes under TWO declared origins: two receipts and two
//       names, or a false "digest collision"?
//   T4  CONTROL (false-positive guard): an untouched store must still verify
//       clean, and the ordinary adopt must still succeed — the fix must not
//       turn the working path red.
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
const OUT = flag('--out', positional() ?? path.join(ROOT, 'research', 'declared-origin-2026-11-07.json'));
const TAG = flag('--tag', null);

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SELL_V3 = '3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b';
const PUBLISHED = path.join(ROOT, 'test', 'fixtures', 'pump-published-idl.json');

/** A declared origin that names a repository which does not exist. */
const UNVERIFIABLE = 'solana-labs/anchor@deadbeef/does-not-exist.json';
const REWRITTEN = 'attacker/rewritten-origin';

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
const stdoutJson = (out) => { try { return JSON.parse(out); } catch { return null; } };

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(', ')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(', ')}}`;
}

/** Rewrite the declared origin inside a stored receipt — the attack the
 * pre-fix tree could not see. The bytes of the OBJECT are untouched: the
 * fingerprint still re-hashes, only the provenance label moves. */
function rewriteDeclaredOrigin(store, receiptName, next) {
  const receiptPath = path.join(store, 'receipts', receiptName);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.origin = next;
  fs.writeFileSync(receiptPath, `${canonicalJson(receipt)}\n`);
  return receiptPath;
}

function measure() {
  const verdict = { violations: [] };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-origin-measure-'));

  // ---- T1: the reader surfaces must call the origin DECLARED --------------
  const store1 = path.join(base, 'store-declared');
  fs.mkdirSync(store1, { recursive: true });
  const adopt = run(['adopt', PUMP, PUBLISHED, '--store', store1, '--origin', UNVERIFIABLE]);
  const adoptJson = stdoutJson(adopt.stdout);
  const plain = run(['decode', PUMP, SELL_V3, '--store', store1]);
  const plainJson = stdoutJson(plain.stdout);
  const union = run(['decode', '--union', PUMP, SELL_V3, '--store', store1]);
  const unionJson = stdoutJson(union.stdout);

  // The label lives on the union path (findStoredIdls), not in the plain
  // decode result — so the reader surface and the union surface are the same
  // string, and the tool measures both names of it.
  const label = unionJson?.view?.primary?.label ?? null;
  const t1 = {
    adoptExit: adopt.status,
    adoptOrigin: adoptJson?.origin ?? null,
    adoptOriginStatus: adoptJson?.originStatus ?? null,
    adoptOriginNote: adoptJson?.originNote ?? null,
    decodeExit: plain.status,
    idlMetaOrigin: plainJson?.idl?.origin ?? null,
    idlMetaOriginStatus: plainJson?.idl?.originStatus ?? null,
    readerLabel: label,
    unionLabel: unionJson?.view?.primary?.label ?? null,
    unionExit: union.status,
  };
  if (t1.adoptExit !== 0) verdict.violations.push(`T1 adopt exited ${t1.adoptExit}: ${adopt.stderr}`);
  if (t1.adoptOriginStatus !== 'declared') {
    verdict.violations.push(`T1 adopt did not report the origin as DECLARED (got ${JSON.stringify(t1.adoptOriginStatus)})`);
  }
  if (!/not verified|unverified|declared/i.test(String(t1.adoptOriginNote ?? ''))) {
    verdict.violations.push('T1 adopt did not say the origin was not verified');
  }
  if (t1.idlMetaOriginStatus !== 'declared') {
    verdict.violations.push(`T1 the decoded idlMeta does not mark the origin as DECLARED (got ${JSON.stringify(t1.idlMetaOriginStatus)})`);
  }
  for (const [what, value] of [['reader label', t1.readerLabel], ['union label', t1.unionLabel]]) {
    if (!value) { verdict.violations.push(`T1 the ${what} is missing`); continue; }
    if (!/declared/i.test(value)) {
      verdict.violations.push(`T1 the ${what} presents the origin without marking it declared: ${value}`);
    }
  }

  // ---- T2: a rewritten declared origin must be a NAMED violation ----------
  const lockPath = path.join(base, 'declared.lock');
  const lock = run(['lock', '--store', store1, '--out', lockPath]);
  const verifyBefore = run(['verify', '--store', store1, '--lock', lockPath, '--mode', 'warn']);
  const beforeJson = stdoutJson(verifyBefore.stdout);
  const receiptNames = fs.readdirSync(path.join(store1, 'receipts')).filter((n) => n.startsWith(`${PUMP}-`));
  rewriteDeclaredOrigin(store1, receiptNames[0], REWRITTEN);
  const verifyAfter = run(['verify', '--store', store1, '--lock', lockPath, '--mode', 'warn']);
  const afterJson = stdoutJson(verifyAfter.stdout);
  const verifyError = run(['verify', '--store', store1, '--lock', lockPath, '--mode', 'error']);
  const t2 = {
    lockExit: lock.status,
    verifyBeforeExit: verifyBefore.status,
    verifyBeforeViolations: beforeJson?.violations ?? null,
    verifyBeforeVerified: beforeJson?.verified ?? null,
    verifyAfterExit: verifyAfter.status,
    verifyAfterViolations: afterJson?.violations ?? null,
    verifyAfterVerified: afterJson?.verified ?? null,
    relabelled: afterJson?.relabelled ?? null,
    verifyErrorExit: verifyError.status,
    verifyErrorHead: verifyError.status !== 0 ? (verifyError.stderr || verifyError.stdout).trim().slice(0, 200) : null,
  };
  if (t2.lockExit !== 0) verdict.violations.push(`T2 lock exited ${t2.lockExit}`);
  if (t2.verifyBeforeViolations !== 0) {
    verdict.violations.push(`T2 the untouched store already reported ${t2.verifyBeforeViolations} violations`);
  }
  if (t2.verifyAfterViolations === 0) {
    verdict.violations.push('T2 a rewritten declared origin reported ZERO violations — the CI gate cannot see it');
  }
  if (!Array.isArray(t2.relabelled) || t2.relabelled.length === 0) {
    verdict.violations.push('T2 the rewritten origin was not named as a relabelled origin');
  }
  if (t2.verifyErrorExit === 0) {
    verdict.violations.push('T2 verify in error mode exited 0 over a rewritten declared origin');
  }
  if (!/origin/i.test(String(t2.verifyErrorHead ?? ''))) {
    verdict.violations.push(`T2 the error does not name the origin: ${t2.verifyErrorHead}`);
  }

  // ---- T3: the same bytes under two declared origins ----------------------
  const store3 = path.join(base, 'store-two-origins');
  fs.mkdirSync(store3, { recursive: true });
  const first = run(['adopt', PUMP, PUBLISHED, '--store', store3, '--origin', 'author-a/interface-a.json']);
  const second = run(['adopt', PUMP, PUBLISHED, '--store', store3, '--origin', 'author-b/interface-b.json']);
  const names = fs.readdirSync(path.join(store3, 'receipts')).filter((n) => n.startsWith(`${PUMP}-`));
  const t3 = {
    firstExit: first.status,
    secondExit: second.status,
    receipts: names.length,
    receiptNames: names,
    secondErrorHead: second.status !== 0 ? (second.stderr || second.stdout).trim().slice(0, 200) : null,
    secondSaysCollision: /digest collision|corrupted local object/i.test(second.stderr || ''),
  };
  if (t3.firstExit !== 0) verdict.violations.push(`T3 the first adopt exited ${t3.firstExit}`);
  if (t3.secondExit !== 0) {
    verdict.violations.push(`T3 the second adopt of the SAME bytes under a different origin failed: ${t3.secondErrorHead}`);
  }
  if (t3.secondSaysCollision) {
    verdict.violations.push('T3 a differing declared origin is reported as a digest collision');
  }
  if (t3.receipts !== 2) {
    verdict.violations.push(`T3 expected two receipts for the same bytes under two origins, found ${t3.receipts}`);
  }

  // ---- T4: control — the untouched, ordinary path still works -------------
  const store4 = path.join(base, 'store-control');
  fs.mkdirSync(store4, { recursive: true });
  const adoptC = run(['adopt', PUMP, PUBLISHED, '--store', store4, '--origin', 'docs-copy']);
  const decodeC = run(['decode', PUMP, SELL_V3, '--store', store4]);
  const lockC = path.join(base, 'control.lock');
  const lockRunC = run(['lock', '--store', store4, '--out', lockC]);
  const verifyC = run(['verify', '--store', store4, '--lock', lockC, '--mode', 'error']);
  const decodeJsonC = stdoutJson(decodeC.stdout);
  const t4 = {
    adoptExit: adoptC.status,
    decodeExit: decodeC.status,
    decodeInstruction: decodeJsonC?.instruction ?? decodeJsonC?.name ?? null,
    lockExit: lockRunC.status,
    verifyExit: verifyC.status,
  };
  if (t4.adoptExit !== 0) verdict.violations.push(`T4 control adopt exited ${t4.adoptExit}`);
  if (t4.decodeExit !== 0) verdict.violations.push(`T4 control decode exited ${t4.decodeExit}`);
  if (t4.lockExit !== 0) verdict.violations.push(`T4 control lock exited ${t4.lockExit}`);
  if (t4.verifyExit !== 0) verdict.violations.push(`T4 control verify exited ${t4.verifyExit} over the store it just locked`);

  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/measure-declared-origin.mjs',
    question: 'does a declared origin ever read as a verified provenance, and can it be rewritten without the gate noticing?',
    binary: { path: BIN, tag: TAG },
    fixture: {
      program: PUMP,
      publishedCopy: path.relative(ROOT, PUBLISHED),
      declaredOrigin: UNVERIFIABLE,
      rewrittenOrigin: REWRITTEN,
      note: 'the declared origin names a repository that does not exist — nothing in sememe checks it, which is the point',
    },
    t1: { readerSurfaces: t1 },
    t2: { rewrittenOrigin: t2 },
    t3: { twoDeclaredOrigins: t3 },
    t4: { control: t4 },
    verdict,
  };
  report.verdict.ok = report.verdict.violations.length === 0;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  return report.verdict.ok ? 0 : 1;
}

try {
  process.exit(measure());
} catch (error) {
  console.error(JSON.stringify({ error: String(error?.message ?? error) }));
  process.exit(3);
}
