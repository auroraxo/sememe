#!/usr/bin/env node
// tools/measure-slot-order.mjs — DOES ONE STORE ANSWER WITH ONE ANSWER WHEN
// THE SLOT STRINGS DIFFER IN LENGTH?
//
// The defect this measures (sememe card "sememe: lokale Bedeutungsebene
// qualifizieren, Abdeckung zuerst messen"), measured on the pre-fix tree
// 00ae18c and on the PUBLISHED v0.4.9 install (which carries the same code):
//
//   store = two ON-CHAIN receipts of one program, slots of different digit
//   length (the filename embeds the slot as a decimal STRING):
//     <prog>-99999999-on-chain-<hash>    (numerically OLDER)
//     <prog>-123456789-on-chain-<hash>   (numerically NEWER)
//
//   sememe decode         -> slot 99999999   (string-newest: "9…" > "1…")
//   sememe decode --union -> slot 123456789  (sorted NUMERICALLY by slot)
//   sememe lock           -> pins slot 99999999
//
//   Three surfaces, two different receipts — the same defect shape 08eff55
//   fixed for LABELS (one dimension over), and the reason "the rule is now ONE
//   ordering everywhere" was not yet true: filename order is digit order, and
//   digit order is not slot order.
//
// WHAT THIS TOOL MEASURES, against any CLI binary (--bin, default this tree):
//   T1  plain decode and union decode of the SAME payload from the SAME
//       mixed-digit store: do they name the same receipt (slot + fingerprint)?
//   T2  `sememe lock`: which slot does it pin?
//   T3  `sememe verify`: does the lock verify clean against that store?
//   T4  control, equal-length slots: every surface must agree — the fix must
//       not turn the ordinary store (what a fresh `pull` writes) red.
//
// Every field is derived from an exit code or a parsed JSON answer; nothing
// is asserted by hand. Exit 0 = the binary behaved as the contract says,
// exit 1 = at least one contract violation (printed in the report), exit 3 =
// no verdict (the binary could not be run at all).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
 * argument that is NOT the value of a flag. */
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
const OUT = flag('--out', positional() ?? path.join(ROOT, 'research', 'slot-order-2026-11-07.json'));
const TAG = flag('--tag', null); // recorded provenance of the binary, e.g. "v0.4.9"

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SELL_V3 = '3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b';
const DOCS_COPY = path.join(ROOT, 'test', 'fixtures', 'pump-published-idl.json'); // 56 ix, knows sell_v3
const SDK_COPY = path.join(ROOT, 'test', 'fixtures', 'pump-idl.json'); // 47 ix, does not

// Numerically OLDER (8 digits) and numerically NEWER (9 digits). As strings,
// "99999999…" sorts AFTER "123456789…" — that inversion is the whole defect.
const OLD_SLOT = 99999999;
const NEW_SLOT = 123456789;
// Equal-length control: both 9 digits, as every live mainnet slot is today.
const CTL_OLD_SLOT = 462039125;
const CTL_NEW_SLOT = 465713413;

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
const stdoutJson = (out) => { try { return JSON.parse(out); } catch { return null; } };
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

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Write ONE on-chain receipt exactly as `sememe pull` writes it:
 *  `<program>-<slot>-<source>-<fingerprint>.json`, object = canonical JSON + \n.
 * `sememe pull` can only ever write the CURRENT slot, so a store whose slot
 * strings differ in length has to be assembled the way a user's store holds
 * it — the filenames are the real format, the objects are the real bytes. */
function writeReceipt(dir, program, file, slot, source) {
  const idl = JSON.parse(fs.readFileSync(file, 'utf8'));
  const json = Buffer.from(`${canonicalJson(idl)}\n`);
  const fingerprint = sha256(json);
  fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'objects', `${fingerprint}.json`), json);
  const receipt = {
    program, source, slot,
    fingerprint: `sha256:${fingerprint}`,
    instructionCount: idl.instructions.length,
  };
  const name = `${program}-${slot}-${source}-${fingerprint}.json`;
  fs.writeFileSync(path.join(dir, 'receipts', name), Buffer.from(`${canonicalJson(receipt)}\n`));
  return { slot, fingerprint: `sha256:${fingerprint}`, name };
}

/** The canonical JSON the store uses: keys sorted, no whitespace, trailing \n.
 * Written out here rather than imported from src/ so the tool can point at a
 * FOREIGN build (--bin) whose tree it does not share. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function measure() {
  const verdict = { violations: [] };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-slotorder-measure-'));

  // ---- T1/T2/T3: mixed digit length ---------------------------------------
  const store1 = path.join(base, 'store-mixed');
  fs.mkdirSync(store1, { recursive: true });
  const older = writeReceipt(store1, PUMP, SDK_COPY, OLD_SLOT, 'on-chain');
  const newer = writeReceipt(store1, PUMP, DOCS_COPY, NEW_SLOT, 'on-chain');

  const plain = run(['decode', PUMP, SELL_V3, '--store', store1]);
  const union = run(['decode', '--union', PUMP, SELL_V3, '--store', store1]);
  const plainJson = stdoutJson(plain.stdout);
  const unionJson = stdoutJson(union.stdout);
  const lockPath = path.join(base, 'mixed.lock');
  const lock = run(['lock', '--store', store1, '--out', lockPath]);
  const lockDoc = stdoutJson(fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : 'null');
  const verify = run(['verify', '--store', store1, '--lock', lockPath, '--mode', 'error']);

  const t1 = {
    plainExit: plain.status,
    unionExit: union.status,
    plainSlot: plainJson?.idl?.slot ?? null,
    unionSlot: unionJson?.idl?.slot ?? null,
    plainFingerprint: plainJson?.idl?.fingerprint ?? null,
    unionFingerprint: unionJson?.idl?.fingerprint ?? null,
    plainInstruction: plainJson?.instruction ?? plainJson?.name ?? null,
    unionInstruction: unionJson?.instruction ?? unionJson?.name ?? null,
    sameReceipt: (plainJson?.idl?.fingerprint ?? null) === (unionJson?.idl?.fingerprint ?? null)
      && plainJson?.idl?.fingerprint !== undefined,
  };
  const t2 = {
    lockExit: lock.status,
    lockedSlot: lockDoc?.programs?.[PUMP]?.slot ?? null,
    lockedFingerprint: lockDoc?.programs?.[PUMP]?.fingerprint ?? null,
  };
  const t3 = {
    verifyExit: verify.status,
    verifyFailed: verify.status !== 0,
    verifyErrorHead: verify.status !== 0 ? (verify.stderr || verify.stdout).trim().slice(0, 160) : null,
  };
  // The contract: every surface names the NUMERICALLY NEWEST receipt
  // (slot 123456789), and they agree with each other.
  if (t1.plainExit !== 0) verdict.violations.push(`T1 plain decode exited ${t1.plainExit}`);
  if (t1.unionExit !== 0) verdict.violations.push(`T1 union decode exited ${t1.unionExit}`);
  if (t1.plainSlot !== NEW_SLOT) {
    verdict.violations.push(`T1 plain decode answered slot ${t1.plainSlot}, not the newest slot ${NEW_SLOT}`);
  }
  if (t1.unionSlot !== NEW_SLOT) {
    verdict.violations.push(`T1 union decode answered slot ${t1.unionSlot}, not the newest slot ${NEW_SLOT}`);
  }
  if (!t1.sameReceipt) verdict.violations.push('T1 plain and union decode name DIFFERENT receipts of one store');
  if (t2.lockExit !== 0) verdict.violations.push(`T2 lock exited ${t2.lockExit}`);
  if (t2.lockedSlot !== NEW_SLOT) {
    verdict.violations.push(`T2 lock pinned slot ${t2.lockedSlot}, not the newest slot ${NEW_SLOT}`);
  }
  if (t2.lockedFingerprint !== t1.plainFingerprint) {
    verdict.violations.push('T2 the lock pins a different receipt than the decoders read');
  }
  if (t3.verifyExit !== 0) verdict.violations.push(`T3 verify exited ${t3.verifyExit} over the store it just locked`);

  // ---- T4: control, equal-length slots ------------------------------------
  const store2 = path.join(base, 'store-equal');
  fs.mkdirSync(store2, { recursive: true });
  writeReceipt(store2, PUMP, SDK_COPY, CTL_OLD_SLOT, 'on-chain');
  writeReceipt(store2, PUMP, DOCS_COPY, CTL_NEW_SLOT, 'on-chain');
  const plainC = run(['decode', PUMP, SELL_V3, '--store', store2]);
  const unionC = run(['decode', '--union', PUMP, SELL_V3, '--store', store2]);
  const lockC = path.join(base, 'equal.lock');
  const lockRunC = run(['lock', '--store', store2, '--out', lockC]);
  const lockDocC = stdoutJson(fs.existsSync(lockC) ? fs.readFileSync(lockC, 'utf8') : 'null');
  const verifyC = run(['verify', '--store', store2, '--lock', lockC, '--mode', 'error']);
  const pC = stdoutJson(plainC.stdout);
  const uC = stdoutJson(unionC.stdout);
  const t4 = {
    plainExit: plainC.status,
    unionExit: unionC.status,
    plainSlot: pC?.idl?.slot ?? null,
    unionSlot: uC?.idl?.slot ?? null,
    sameReceipt: pC?.idl?.fingerprint === uC?.idl?.fingerprint && pC?.idl?.fingerprint !== undefined,
    lockedSlot: lockDocC?.programs?.[PUMP]?.slot ?? null,
    lockExit: lockRunC.status,
    verifyExit: verifyC.status,
  };
  if (t4.plainExit !== 0 || t4.unionExit !== 0) verdict.violations.push('T4 control decode failed');
  if (!t4.sameReceipt) verdict.violations.push('T4 control: plain and union disagree');
  if (t4.plainSlot !== CTL_NEW_SLOT || t4.unionSlot !== CTL_NEW_SLOT) {
    verdict.violations.push(`T4 control answered slot ${t4.plainSlot}/${t4.unionSlot}, not ${CTL_NEW_SLOT}`);
  }
  if (t4.lockedSlot !== CTL_NEW_SLOT) verdict.violations.push(`T4 control lock pinned slot ${t4.lockedSlot}`);
  if (t4.lockExit !== 0) verdict.violations.push(`T4 control lock exited ${t4.lockExit}`);
  if (t4.verifyExit !== 0) verdict.violations.push(`T4 control verify exited ${t4.verifyExit}`);

  verdict.ok = verdict.violations.length === 0;
  fs.rmSync(base, { recursive: true, force: true });
  return {
    mixedDigitSlots: { t1, t2, t3 },
    controlEqualDigitSlots: t4,
    fixture: {
      olderReceipt: older.name,
      newerReceipt: newer.name,
      note: 'both receipts are REAL pull-format filenames; only the slot digit lengths differ',
    },
    verdict,
  };
}

const measured = measure();
const report = {
  generatedAt: new Date().toISOString(),
  tool: 'tools/measure-slot-order.mjs',
  question: 'does one store answer with one answer when two slot strings differ in length?',
  binary: { path: path.relative(ROOT, BIN) || BIN, tag: TAG ?? null, tree: BIN.startsWith(ROOT) ? 'this tree' : 'external' },
  contract: {
    T1: 'plain decode and union decode of one store whose slot strings differ in length name the SAME, NUMERICALLY NEWEST receipt',
    T2: 'lock pins the numerically newest receipt — the one the decoders read',
    T3: 'verify is clean over the store it just locked',
    T4: 'control: a store with equal-length slots still decodes, locks and verifies green',
  },
  ...measured,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
process.exit(report.verdict.ok ? 0 : 1);
