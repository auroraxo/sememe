#!/usr/bin/env node
// tools/lock-voice-probe.mjs — DOES THE LOCK SURFACE ANSWER A REFUSAL THE
// WAY EVERY OTHER REFUSAL IN THE PRODUCT ANSWERS?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix). It asks only
// observable questions about the tree it runs inside: it spawns THAT tree's
// bin/sememe.mjs and reads nothing else.
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, the PUBLISHED
// sememe@0.4.34 installed into an empty app):
//
// The product's rule is that a refusal NAMES itself: a code a script can
// branch on and a repair the operator can run. Three classifier families
// already do that — src/file-input.mjs (caller-named files),
// src/store-input.mjs (caller-named store directory), src/store-damage.mjs
// (damage the reader finds in a store).
//
// The LOCK surface — the CI gate the README tells a stranger to run after
// checkout — does not:
//
//   sememe verify --lock bad.lock
//     -> {"error":"sememe lock file bad.lock is not JSON (lock-v1-parse)"}
//        exit 1
//   sememe verify --store store --lock drift.lock
//     -> {"error":"store does not match sememe.lock (0 drifted, 1 missing,
//        …) — missing: 9n5…"}
//        exit 1
//
// Three faults, the same three the other classifiers ended:
//
//   1. NO BRANCHABLE NAME. The code sits INSIDE the prose ("(lock-v1-parse)")
//      or is absent altogether (the mismatch refusal has no code at all), so
//      `error.code` is undefined and a script must read English to branch.
//      The SAME command answers two different shapes: a missing --lock FILE
//      answers {"error":…,"code":"lock-file-missing","fix":"fix: …"} while a
//      malformed lock DOCUMENT answers {"error":…} alone.
//   2. NO REPAIR. Not one of these refusals names what the operator can run.
//      The store-damage classifier's whole point is that "the object in the
//      store is not the one the receipt pins" comes with "re-run sememe pull".
//   3. THE WRONG SUBJECT FOR THE BIGGEST ONE. The mismatch refusal is the
//      product's own CI gate failing — the answer a pipeline reads to decide
//      what broke — and it reports COUNTS in prose with no code and no
//      repair: a pipeline cannot tell "the store drifted" from "a receipt is
//      damaged" without parsing the sentence.
//
// Cases (every one is a REFUSAL of the lock surface):
//   lockDocNotJson      the lock file holds no JSON document
//   lockDocNotADocument the lock file holds JSON that is not a lock
//   lockDocBadVersion   the lock carries an unsupported lockVersion
//   lockDocNoPrograms   the lock has no programs map
//   lockPinsNothing     the lock pins zero programs
//   lockEntryNotObject  a pinned entry is not an object
//   lockBadFingerprint  a pinned fingerprint is malformed
//   lockBadOrigin       a pinned origin is malformed
//   storeMismatch       the store does not match the lock (the gate fails)
//   storeMissingProgram a pinned program is missing from the store
//   storeUnverified     a receipt in the store fails the reader's re-hash
//   lockTamperedReceipt `sememe lock` over a receipt edited after it was written
//   lockRelabelledReceipt `sememe lock` over a receipt whose declared origin
//                        was rewritten after it was written
//
// The CONTROLS (they must behave the SAME in both trees):
//   greenGate      a lock over an intact store still verifies green (exit 0)
//   lockWrites     `sememe lock` still writes a lock over an intact store
//   noStoreAnswer  a store that does not exist still answers with the
//                  product's own "no sememe store" sentence (an ANSWER, not
//                  a refusal — it must not acquire a code or a repair)
//
// WHAT WOULD FALSIFY THE FIX (counted directly by the tool):
//   * preFixUnnamedFaces      — pre-fix refusals without a branchable code.
//                               Expected LARGE; the tool fails if 0 (a
//                               baseline with no defect is unmeasurable).
//   * fixedUnnamedFaces       — must be 0.
//   * preFixRepairlessFaces   — pre-fix refusals without a repair.
//                               Expected LARGE; must be > 0 for a meaningful
//                               baseline.
//   * fixedRepairlessFaces    — must be 0.
//   * fixedWrongChannelFaces  — a refusal must keep its exit code; the
//                               document faults and the gate failure both
//                               stay exit 1 (the work ran and found the
//                               wrong bytes). Must be 0.
//   * fixedSilentCodeFaces    — a refusal whose code is MINTED but dropped
//                               by the CLI channel (the receipt-integrity
//                               reasons carried `receipt-tampered` with no
//                               `fix`, and code+fix is the channel's own
//                               condition, so the code never reached the
//                               operator). Must be 0.
//   * controlRegression       — a control changed verdict between the trees.
//                               Must be 0.
//   * hostPathLeak            — the artifact quotes this host's paths. Must
//                               be 0 (research/ is committed).
//
// Exit codes: 0 the probe ran; 3 NO VERDICT (the tree could not be read).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const OTHER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');

if (!fs.existsSync(BIN)) { console.error('no bin/sememe.mjs in this tree'); process.exit(3); }
if (!fs.existsSync(IDL)) { console.error('the committed fixture is missing from this tree'); process.exit(3); }

// The kernel's errno strings. A refusal that carries one of these is talking
// in the kernel's voice, not the product's.
const ERRNO_STRINGS = [
  'ENOENT', 'EISDIR', 'EACCES', 'ENOTDIR', 'EPERM', 'ELOOP', 'EEXIST', 'EROFS', 'ENOSPC',
  'no such file or directory', 'illegal operation on a directory',
  'permission denied', 'not a directory', 'file already exists',
];

const REFUSAL_FACES = [
  'lockDocNotJson', 'lockDocNotADocument', 'lockDocBadVersion', 'lockDocNoPrograms',
  'lockPinsNothing', 'lockEntryNotObject', 'lockBadFingerprint', 'lockBadOrigin',
  'storeMismatch', 'storeMissingProgram', 'storeUnverified',
  'lockTamperedReceipt', 'lockRelabelledReceipt',
];
const CONTROLS = ['greenGate', 'lockWrites', 'noStoreAnswer'];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-lock-voice-probe-'));

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  return {
    exit: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/** The product's own refusal: a JSON object on stderr carrying a code and a
 *  repair. Anything else is not one. */
function refusalOf(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.stderr.trim()); } catch { parsed = null; }
  const message = parsed && typeof parsed.error === 'string' ? parsed.error : `${result.stderr}${result.stdout}`;
  return {
    exit: result.exit,
    code: parsed && typeof parsed.code === 'string' ? parsed.code : null,
    fix: parsed && typeof parsed.fix === 'string' ? parsed.fix : null,
    leakedErrno: ERRNO_STRINGS.filter((needle) => message.includes(needle)),
    text: message.slice(0, 400),
  };
}

// --- the store fixture ------------------------------------------------------

const { canonicalJson } = await import(path.join(ROOT, 'src', 'canonical.mjs'));
const { createHash } = await import('node:crypto');
const idl = JSON.parse(fs.readFileSync(IDL, 'utf8'));
const bytes = Buffer.from(canonicalJson(idl) + '\n');
const fingerprint = createHash('sha256').update(bytes).digest('hex');
const receiptName = `${PROGRAM}-462039125-metadata-${fingerprint}.json`;

const store = path.join(tmpRoot, 'store');
fs.mkdirSync(path.join(store, 'receipts'), { recursive: true });
fs.mkdirSync(path.join(store, 'objects'), { recursive: true });
fs.writeFileSync(path.join(store, 'objects', `${fingerprint}.json`), bytes);
fs.writeFileSync(path.join(store, 'receipts', receiptName), JSON.stringify({
  program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata',
}));

const lockPath = (name) => path.join(tmpRoot, name);
const writeLock = (name, doc) => {
  const p = lockPath(name);
  fs.writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return p;
};

const pinned = {
  lockVersion: 1,
  programs: {
    [PROGRAM]: {
      fingerprint: `sha256:${fingerprint}`,
      source: 'metadata',
      slot: 462039125,
      receipt: receiptName,
      instructions: idl.instructions.length,
    },
  },
};

// A second store whose receipt no longer matches the object it claims: the
// reader refuses it, so the lock gate reports it as unverified.
const damagedStore = path.join(tmpRoot, 'damaged-store');
fs.mkdirSync(path.join(damagedStore, 'receipts'), { recursive: true });
fs.mkdirSync(path.join(damagedStore, 'objects'), { recursive: true });
fs.writeFileSync(path.join(damagedStore, 'objects', `${fingerprint}.json`), bytes);
fs.writeFileSync(path.join(damagedStore, 'receipts', receiptName), JSON.stringify({
  program: PROGRAM, fingerprint: `sha256:${'0'.repeat(64)}`, slot: 462039125, source: 'metadata',
}));

// A receipt EDITED after sememe wrote it: it carries its own digest, and the
// digest no longer matches the body. The reader refuses it by name
// (receipt-tampered) — but at the CLI that code was minted without a repair,
// and the CLI prints code+fix only when BOTH are present, so the code was
// dropped. Same for a declared origin rewritten after the fact
// (receipt-relabelled).
const { receiptDigestOf, originDigestOf } = await import(path.join(ROOT, 'src', 'receipt-digest.mjs'));

function storeWithReceipt(body) {
  const store = path.join(tmpRoot, `store-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(store, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(store, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  const name = `${PROGRAM}-${body.slot ?? 462039125}-${body.source ?? 'metadata'}-${fingerprint}.json`;
  fs.writeFileSync(path.join(store, 'receipts', name), JSON.stringify(body));
  return store;
}

// body with a WRONG receipt digest: written, then edited.
const tamperedBody = {
  program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata',
  receiptDigest: receiptDigestOf({
    program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 1, source: 'metadata',
  }),
};
const tamperedStore = storeWithReceipt(tamperedBody);

// body whose declared origin no longer matches the origin digest it binds.
const relabelledBody = {
  program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata',
  origin: 'attacker/rewritten-origin',
  originDigest: originDigestOf('the-origin-it-was-written-with'),
  receiptDigest: null,
};
const relabelledStore = storeWithReceipt(relabelledBody);

// --- the faces --------------------------------------------------------------

const cases = {};

cases.lockDocNotJson = refusalOf(run(['verify', '--store', store, '--lock', writeLock('not-json.lock', 'nope')]));
cases.lockDocNotADocument = refusalOf(run(['verify', '--store', store, '--lock', writeLock('array.lock', '[]')]));
cases.lockDocBadVersion = refusalOf(run(['verify', '--store', store, '--lock',
  writeLock('version.lock', { lockVersion: 99, programs: pinned.programs })]));
cases.lockDocNoPrograms = refusalOf(run(['verify', '--store', store, '--lock',
  writeLock('no-programs.lock', { lockVersion: 1 })]));
cases.lockPinsNothing = refusalOf(run(['verify', '--store', store, '--lock',
  writeLock('empty.lock', { lockVersion: 1, programs: {} })]));
cases.lockEntryNotObject = refusalOf(run(['verify', '--store', store, '--lock',
  writeLock('entry.lock', { lockVersion: 1, programs: { [PROGRAM]: 7 } })]));
cases.lockBadFingerprint = refusalOf(run(['verify', '--store', store, '--lock',
  writeLock('fingerprint.lock', { lockVersion: 1, programs: { [PROGRAM]: { fingerprint: 'nope' } } })]));
cases.lockBadOrigin = refusalOf(run(['verify', '--store', store, '--lock',
  writeLock('origin.lock', { lockVersion: 1, programs: { [PROGRAM]: { fingerprint: `sha256:${fingerprint}`, origin: 7 } } })]));

cases.storeMismatch = refusalOf(run(['verify', '--store', store, '--lock',
  writeLock('drift.lock', { lockVersion: 1, programs: { [PROGRAM]: { fingerprint: `sha256:${'0'.repeat(64)}` } } })]));
cases.storeMissingProgram = refusalOf(run(['verify', '--store', store, '--lock',
  writeLock('missing.lock', { lockVersion: 1, programs: { ...pinned.programs, [OTHER_PROGRAM]: pinned.programs[PROGRAM] } })]));
cases.storeUnverified = refusalOf(run(['verify', '--store', damagedStore, '--lock',
  writeLock('good.lock', pinned)]));

cases.lockTamperedReceipt = refusalOf(run(['lock', '--store', tamperedStore, '--out', lockPath('t.lock')]));
cases.lockRelabelledReceipt = refusalOf(run(['lock', '--store', relabelledStore, '--out', lockPath('r.lock')]));

// --- controls ---------------------------------------------------------------

const greenLock = lockPath('green.lock');
const written = run(['lock', '--store', store, '--out', greenLock]);
const verified = run(['verify', '--store', store, '--lock', greenLock]);
cases.greenGate = {
  exit: verified.exit,
  answered: verified.exit === 0 && /"violations": 0/.test(verified.stdout),
  code: null,
  fix: null,
  leakedErrno: [],
  text: verified.stdout.slice(0, 200),
};
cases.lockWrites = {
  exit: written.exit,
  answered: written.exit === 0 && fs.existsSync(greenLock),
  code: null,
  fix: null,
  leakedErrno: [],
  text: written.stdout.slice(0, 200),
};

// A store that does not exist is an ANSWER, not a refusal: it must not
// acquire a code or a repair from the lock classifier.
const noStore = refusalOf(run(['verify', '--store', path.join(tmpRoot, 'no-such-store'), '--lock', greenLock]));
cases.noStoreAnswer = {
  exit: noStore.exit,
  answered: /no sememe store at/.test(noStore.text),
  code: noStore.code,
  fix: noStore.fix,
  leakedErrno: noStore.leakedErrno,
  text: noStore.text,
};

// --- the library channel ----------------------------------------------------
//
// The CLI's named channel prints code+fix ONLY when BOTH are present. A
// refusal that mints a code WITHOUT a repair therefore reaches the operator
// as {"error":…} alone — the code is minted and then dropped on the floor.
// That class is invisible to a CLI-only probe (both look like "no code"), so
// it is measured here, through the library, where the two fields can be
// seen apart.
const libraryFaces = {};
{
  const { readVerified } = await import(path.join(ROOT, 'src', 'store-read.mjs'));
  for (const [name, store] of [['tamperedReceipt', tamperedStore], ['relabelledReceipt', relabelledStore]]) {
    try {
      await readVerified(store, PROGRAM, fs.readdirSync(path.join(store, 'receipts'))[0]);
      libraryFaces[name] = { refused: false, code: null, fix: null, exitCode: null };
    } catch (error) {
      libraryFaces[name] = {
        refused: true,
        code: typeof error?.code === 'string' ? error.code : null,
        fix: typeof error?.fix === 'string' ? error.fix : null,
        exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : null,
      };
    }
  }
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(JSON.stringify({ faces: REFUSAL_FACES, controls: CONTROLS, cases, libraryFaces }));
