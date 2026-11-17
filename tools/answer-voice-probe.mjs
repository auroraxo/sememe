#!/usr/bin/env node
// tools/answer-voice-probe.mjs — ARE THE PRODUCT'S STORE ANSWERS NAMED, OR
// BARE PROSE A SCRIPT HAS TO READ?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix). It answers
// only observable questions about the tree it runs inside: it spawns THAT
// tree's bin/sememe.mjs and reads nothing else. Nothing here asserts a
// verdict about which tree is right — the tool that runs this derives the
// verdict from the two runs.
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, pre-fix tree
// dc2317d, and reproduced against the PUBLISHED sememe@0.4.35 installed into
// an empty app):
//
// The product names almost everything it refuses: a wrong path, damage in a
// store, a broken lock file — each carries a code, a subject and a repair.
// But its ANSWERS — the states that are not faults — carried nothing:
//
//   sememe decode <program> <payload> --store <missing>
//     -> {"error":"no sememe store at …: run \"sememe pull\" first"} exit 1
//   sememe account <program> <data> --store <missing>
//     -> {"error":"no sememe store at …: run \"sememe pull\" first"} exit 1
//   sememe lock --store <missing> --out <lock>
//     -> {"error":"no sememe store at …: run \"sememe pull\" first"} exit 1
//   sememe verify --store <missing> --lock <lock>
//     -> {"error":"no sememe store at …: run \"sememe pull\" first"} exit 1
//   sememe decode <program> <payload> --store <store without the program>
//     -> {"error":"no stored IDL for program … in …"} exit 1
//
// Three faults:
//   1. NO BRANCHABLE NAME — the library minted `no-sememe-store` and
//      `no-stored-idl`, but the CLI prints `code` only together with `fix`,
//      and an answer has no fix — so both codes were minted and DROPPED.
//      The two lock-surface call sites did not even mint them.
//   2. NO WAY TO TELL AN ANSWER FROM A FAULT — every refusal in the product
//      ends in a repair, so "the store was never pulled" (acquire) and "the
//      work failed" (repair) looked identical on the machine channel: both
//      exit 1, both a JSON error, neither repairable-by-reading.
//   3. THE CLASS IS INVISIBLE — the codes existed but were dropped, so a
//      script could not even learn that "no-sememe-store" and
//      "no-stored-idl" are different states (acquire vs. pull this program).
//
// THE CONTRACT (src/store-answer.mjs is the ONE mint place):
//   A1  every answer carries a PRODUCT CODE: no-sememe-store /
//       no-stored-idl.
//   A2  every answer carries `answer: true` — its own semantics: ACQUIRE,
//       do not repair. That is what separates it from a refusal without
//       parsing prose.
//   A3  an answer carries NO `fix` — nothing is broken; the verbatim
//       sentence already says what to run.
//   A4  the SENTENCE stays verbatim and in front: "no sememe store at …:
//       run \"sememe pull\" first" / "no stored IDL for program … in …".
//   A5  the CHANNEL does not move: exit 1, stderr, JSON — exactly where
//       these answers answered before they were named.
//
// The CONTROLS (they must behave the SAME in both trees):
//   greenGate         an intact store still verifies green
//   refusalVoice      a caller-named wrong store path still answers in the
//                     PATH classifier's voice (store-not_a_directory, exit 2)
//                     — the answer class must not swallow the refusal class
//   damageVoice       damage in a store still answers in the DAMAGE
//                     classifier's voice (store-receipt-unreadable, exit 1)
//                     — an answer must not swallow a refusal
//
// WHAT WOULD FALSIFY THE FIX (counted directly by the tool):
//   * preFixUnnamedFaces    — the pre-fix tree answers without a code.
//     Expected LARGE (that is the defect); the tool fails if it is 0.
//   * fixedUnnamedFaces     — must be 0.
//   * fixedUnmarkedFaces    — answers without `answer: true`. Must be 0.
//   * fixedRepairedFaces    — answers that carry a `fix` (an answer dressed
//     as a refusal). Must be 0.
//   * fixedWrongChannelFaces— an answer that left exit 1. Must be 0.
//   * fixedWrongSentenceFaces — answers whose sentence changed. Must be 0.
//   * controlRegression     — a control changed verdict between the trees.
//     Must be 0.
//   * hostPathLeak          — the artifact quotes this host's paths. Must
//     be 0 (research/ is committed).
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
const OTHER_PROGRAM = '4bCbe9vJAbtpajLfgHyLbEYWcAvAhXXLbQ6kZ1QwqVvT';
const IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');

if (!fs.existsSync(BIN)) { console.error('no bin/sememe.mjs in this tree'); process.exit(3); }
if (!fs.existsSync(IDL)) { console.error('the committed fixtures are missing from this tree'); process.exit(3); }

/** The answer faces: the states that are not faults. Every one of them must
 *  end up NAMED, marked `answer: true`, repairless and on exit 1. */
const ANSWER_FACES = [
  'decodeNoStore', 'accountNoStore', 'lockNoStore', 'verifyNoStore',
  'decodeNoStoredIdl', 'accountNoStoredIdl',
];
const CONTROLS = ['greenGate', 'refusalVoice', 'damageVoice'];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-answer-probe-'));

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

/** The product's answer as a script sees it: a JSON object on stderr with a
 *  code and — for an answer — the `answer: true` mark. */
function answerOf(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.stderr.trim()); } catch { parsed = null; }
  return {
    exit: result.exit,
    code: parsed && typeof parsed.code === 'string' ? parsed.code : null,
    fix: parsed && typeof parsed.fix === 'string' ? parsed.fix : null,
    answer: parsed?.answer === true,
    error: parsed && typeof parsed.error === 'string' ? parsed.error : '',
    text: `${result.stderr}${result.stdout}`.slice(0, 400),
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

const missingStore = path.join(tmpRoot, 'no-such-store');
const greenLock = path.join(tmpRoot, 'green.lock');
run(['lock', '--store', store, '--out', greenLock]);

// --- the answer faces -------------------------------------------------------

const cases = {};

cases.decodeNoStore = answerOf(run(['decode', PROGRAM, 'AAAA', '--store', missingStore]));
cases.accountNoStore = answerOf(run(['account', PROGRAM, 'AAAA', '--store', missingStore]));
cases.lockNoStore = answerOf(run(['lock', '--store', missingStore, '--out', path.join(tmpRoot, 'x.lock')]));
cases.verifyNoStore = answerOf(run(['verify', '--store', missingStore, '--lock', greenLock]));

// A store that exists and simply holds no receipt for this program: an
// honest acquisition gap, a DIFFERENT state from a missing store.
cases.decodeNoStoredIdl = answerOf(run(['decode', OTHER_PROGRAM, 'AAAA', '--store', store]));
cases.accountNoStoredIdl = answerOf(run(['account', OTHER_PROGRAM, 'AAAA', '--store', store]));

// --- the controls -----------------------------------------------------------

const verified = run(['verify', '--store', store, '--lock', greenLock]);
cases.greenGate = {
  exit: verified.exit,
  green: /"violations": 0/.test(verified.stdout),
  code: null,
  fix: null,
  answer: false,
  error: '',
  text: verified.stdout.slice(0, 200),
};

// The CALLER-NAMED path class keeps its own voice (exit 2 + store-input
// code): the answer class must not swallow the refusal class.
const storeIsFile = path.join(tmpRoot, 'store-is-file');
fs.writeFileSync(storeIsFile, 'not a store');
const refusal = answerOf(run(['decode', PROGRAM, 'AAAA', '--store', storeIsFile]));
cases.refusalVoice = {
  exit: refusal.exit,
  code: refusal.code,
  fix: refusal.fix,
  answer: refusal.answer,
  error: refusal.error,
  text: refusal.text,
};

// DAMAGE in a store keeps its own voice (exit 1 + store-damage code): an
// answer must not swallow a refusal either.
const damagedStore = path.join(tmpRoot, 'damaged-store');
fs.mkdirSync(path.join(damagedStore, 'receipts'), { recursive: true });
fs.mkdirSync(path.join(damagedStore, 'objects'), { recursive: true });
fs.writeFileSync(path.join(damagedStore, 'objects', `${fingerprint}.json`), bytes);
fs.writeFileSync(path.join(damagedStore, 'receipts', receiptName), JSON.stringify({
  program: PROGRAM, fingerprint: `sha256:${'0'.repeat(64)}`, slot: 462039125, source: 'metadata',
}));
const damage = answerOf(run(['lock', '--store', damagedStore, '--out', path.join(tmpRoot, 'd.lock')]));
cases.damageVoice = {
  exit: damage.exit,
  code: damage.code,
  fix: damage.fix,
  answer: damage.answer,
  error: damage.error,
  text: damage.text,
};

console.log(JSON.stringify({ faces: ANSWER_FACES, controls: CONTROLS, cases }, null, 2));

fs.rmSync(tmpRoot, { recursive: true, force: true });
