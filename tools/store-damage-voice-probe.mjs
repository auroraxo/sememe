#!/usr/bin/env node
// tools/store-damage-voice-probe.mjs — DOES THE PRODUCT ANSWER DAMAGE IT
// FOUND IN A STORE ITSELF IN ITS OWN VOICE, OR IN THE KERNEL'S?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix). It answers
// only observable questions about the tree it runs inside: it spawns THAT
// tree's bin/sememe.mjs and reads nothing else. Nothing here asserts a
// verdict about which tree is right — the tool that runs this derives the
// verdict from the two runs.
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, this tree, and
// reproduced against the PUBLISHED sememe@0.4.32):
//
// The caller-named PATH was closed twice already (src/file-input.mjs
// 2026-11-16, src/store-input.mjs 2026-11-17). What stayed behind is the
// INPUT THE PRODUCT FINDS ITSELF: the store path was right, and the store
// turned out to be damaged. The reader refused it — but in the kernel's
// voice, with no code, no repair, and the operator's home path in the
// message:
//
//   sememe decode <program> <payload> --store <store>
//     -> {"error":"store receipt <name>.json is unreadable: EACCES: permission
//         denied, open '/home/<user>/…/receipts/<name>.json'"}
//        exit 1
//     -> {"error":"store object <hash>.json is unreadable: EISDIR: illegal
//         operation on a directory, read"}
//        exit 1
//
// Three faults, the same three the path classifiers ended:
//   1. NO NAME — no code a script can branch on, no repair to act on.
//   2. NO SUBJECT — receipt damage and object damage are told apart only
//      by prose, and they have different repairs.
//   3. THE WRONG VOCABULARY — the KERNEL's errno strings, quoted verbatim.
//
// Cases (every one is damage the READER finds — the store path itself is
// usable, so these are WORK-channel refusals, exit 1, by contract):
//   receiptIsFile       <store>/receipts/<receipt> is a directory
//   receiptUnreadable   <store>/receipts/<receipt> cannot be read (mode 000)
//   receiptNotJson      <store>/receipts/<receipt> holds no JSON document
//   receiptForeign      a receipt that claims ANOTHER program
//   receiptMalformed    a receipt whose fingerprint is not sha256:<64 hex>
//   objectIsFile        <store>/objects/<hash>.json is a directory
//   objectUnreadable    <store>/objects/<hash>.json cannot be read (mode 000)
//   objectNotJson       <store>/objects/<hash>.json holds no JSON document
//   objectNoInstructions an object with no instruction list
//   objectMissing       a receipt pointing at an object the store lacks
//   objectRehash        an object rewritten so it no longer re-hashes
//
// The CONTROLS (they must behave the SAME in both trees):
//   decodeOk            an intact store still decodes a real payload
//   noStoreAnswer       a store path that does not exist still answers with
//                       the product's own "no sememe store" sentence (code
//                       no-sememe-store, no repair demanded)
//   noStoredIdlAnswer   an intact store that simply lacks a program still
//                       answers `no-stored-idl` (an acquisition gap, not a
//                       refusal)
//   callerPathVoice     a store path the CALLER named wrongly still answers
//                       in the PATH classifier's voice (store-not_a_directory,
//                       exit 2) — the new damage classifier must not swallow
//                       the path class
//
// WHAT WOULD FALSIFY THE FIX (counted directly by the tool):
//   * preFixLeakedErrnoFaces — the pre-fix tree quotes the kernel. Expected
//     LARGE (that is the defect); the tool fails if it is 0.
//   * fixedLeakedErrnoFaces  — must be 0.
//   * fixedUnnamedFaces      — must be 0 (every refusal carries a code).
//   * fixedRepairlessFaces   — must be 0 (every refusal carries a repair).
//   * fixedWrongChannelFaces — must be 0 (a damage refusal keeps exit 1; it
//     must not drift onto the usage/IO channel exit 2, and a path refusal
//     must not drift onto exit 1).
//   * controlRegression      — must be 0.
//   * hostPathLeak           — the artifact quotes this host's paths. Must
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
const IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');
const PAYLOAD_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'mainnet-whirlpool.json');

if (!fs.existsSync(BIN)) { console.error('no bin/sememe.mjs in this tree'); process.exit(3); }
if (!fs.existsSync(IDL) || !fs.existsSync(PAYLOAD_FIXTURE)) {
  console.error('the committed fixtures are missing from this tree'); process.exit(3);
}

// The kernel's errno strings. A refusal that carries one of these is talking
// in the kernel's voice, not the product's. The scan looks at the ERROR
// FIELD ONLY: the refusal and its repair share one line, and a repair that
// happens to read like strerror must not be counted as a leak (the trap the
// file-input and store-input classifiers documented).
const ERRNO_STRINGS = [
  'ENOENT', 'EISDIR', 'EACCES', 'ENOTDIR', 'EPERM', 'ELOOP', 'EEXIST', 'EROFS', 'ENOSPC',
  'no such file or directory', 'illegal operation on a directory',
  'permission denied', 'not a directory', 'file already exists',
];

const DAMAGE_FACES = [
  'receiptIsFile', 'receiptUnreadable', 'receiptNotJson', 'receiptForeign',
  'receiptMalformed', 'objectIsFile', 'objectUnreadable', 'objectNotJson',
  'objectNoInstructions', 'objectMissing', 'objectRehash',
];
const CONTROLS = ['decodeOk', 'noStoreAnswer', 'noStoredIdlAnswer', 'callerPathVoice'];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-store-damage-probe-'));

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

/** The product's own refusal: a JSON error object on stderr carrying a code
 *  and a repair. Anything else is not one. */
function refusalOf(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.stderr.trim()); } catch { parsed = null; }
  const message = parsed && typeof parsed.error === 'string' ? parsed.error : `${result.stderr}${result.stdout}`;
  const leaked = ERRNO_STRINGS.filter((needle) => message.includes(needle));
  return {
    exit: result.exit,
    code: parsed && typeof parsed.code === 'string' ? parsed.code : null,
    fix: parsed && typeof parsed.fix === 'string' ? parsed.fix : null,
    leakedErrno: leaked,
    // The subject half of the refusal: does it name the receipt / object?
    text: message.slice(0, 400),
  };
}

// --- the store fixtures -----------------------------------------------------

const { canonicalJson } = await import(path.join(ROOT, 'src', 'canonical.mjs'));
const { createHash } = await import('node:crypto');
const idl = JSON.parse(fs.readFileSync(IDL, 'utf8'));
const payloadFixture = JSON.parse(fs.readFileSync(PAYLOAD_FIXTURE, 'utf8'));
const swap = payloadFixture.records.find((record) => record.name === 'swap_v2');
if (!swap) { console.error('the mainnet fixture must hold a swap_v2 record'); process.exit(3); }
const bytes = Buffer.from(canonicalJson(idl) + '\n');
const fingerprint = createHash('sha256').update(bytes).digest('hex');
const receiptName = `${PROGRAM}-462039125-metadata-${fingerprint}.json`;

function makeStore(name, mutate) {
  const store = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(store, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(store, 'objects'), { recursive: true });
  const writeReceipt = (body) => fs.writeFileSync(
    path.join(store, 'receipts', receiptName), typeof body === 'string' ? body : JSON.stringify(body));
  const receipt = { program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata' };
  const writeObject = (body) => fs.writeFileSync(path.join(store, 'objects', `${fingerprint}.json`),
    typeof body === 'string' ? body : body);
  writeObject(bytes);
  writeReceipt(receipt);
  if (mutate) mutate({ store, receipt, writeReceipt, writeObject, receiptName, fingerprint, bytes, PROGRAM });
  return store;
}

const stores = {};
stores.decodeOk = makeStore('decodeOk');
stores.receiptIsFile = makeStore('receiptIsFile', ({ store }) => {
  fs.rmSync(path.join(store, 'receipts', receiptName));
  fs.mkdirSync(path.join(store, 'receipts', receiptName));
});
stores.receiptUnreadable = makeStore('receiptUnreadable', ({ store }) => {
  fs.chmodSync(path.join(store, 'receipts', receiptName), 0o000);
});
stores.receiptNotJson = makeStore('receiptNotJson', ({ writeReceipt }) => writeReceipt('nope'));
stores.receiptForeign = makeStore('receiptForeign', ({ receipt, writeReceipt }) => writeReceipt(
  { ...receipt, program: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }));
stores.receiptMalformed = makeStore('receiptMalformed', ({ receipt, writeReceipt }) => writeReceipt(
  { ...receipt, fingerprint: 'sha256:not-a-fingerprint' }));
stores.objectIsFile = makeStore('objectIsFile', ({ store }) => {
  fs.rmSync(path.join(store, 'objects', `${fingerprint}.json`));
  fs.mkdirSync(path.join(store, 'objects', `${fingerprint}.json`));
});
stores.objectUnreadable = makeStore('objectUnreadable', ({ store }) => {
  fs.chmodSync(path.join(store, 'objects', `${fingerprint}.json`), 0o000);
});
stores.objectNotJson = makeStore('objectNotJson', ({ writeObject }) => writeObject('{not json'));
stores.objectNoInstructions = makeStore('objectNoInstructions', ({ writeObject }) => {
  writeObject(Buffer.from(`${canonicalJson({ address: PROGRAM, types: [] })}\n`));
});
stores.objectMissing = makeStore('objectMissing', ({ store }) => {
  fs.rmSync(path.join(store, 'objects', `${fingerprint}.json`));
});
stores.objectRehash = makeStore('objectRehash', ({ writeObject }) => {
  const tampered = JSON.parse(bytes.toString('utf8'));
  tampered.instructions[0].name = 'totally_honest_name';
  writeObject(Buffer.from(`${canonicalJson(tampered)}\n`));
});

const decodeOf = (store) => ['decode', PROGRAM, swap.dataHex, '--store', store];

const cases = {};
for (const face of DAMAGE_FACES) {
  if (!stores[face]) { cases[face] = { exit: null, code: null, fix: null, leakedErrno: ['face not built'] }; continue; }
  cases[face] = refusalOf(run(decodeOf(stores[face])));
}

// --- controls ---------------------------------------------------------------

cases.decodeOk = (() => {
  const result = run(decodeOf(stores.decodeOk));
  return {
    exit: result.exit,
    answered: /"instruction": "swap_v2"/.test(result.stdout),
    leakedErrno: [],
    named: /store-/i.test(result.stderr),
  };
})();

// A store path that does not exist: the product's OWN answer, unchanged.
cases.noStoreAnswer = refusalOf(run(decodeOf(path.join(tmpRoot, 'no-such-store'))));

// An intact store that simply holds no receipt for this program: an honest
// acquisition gap, not a refusal — it must keep its own code and must not
// acquire a repair from the damage classifier.
cases.noStoredIdlAnswer = refusalOf(run([
  'decode', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', swap.dataHex,
  '--store', stores.decodeOk,
]));

// The CALLER-NAMED path class must keep its own voice (exit 2 + store-input
// code): the new damage classifier must not swallow it.
const filePath = path.join(tmpRoot, 'a-regular-file');
fs.writeFileSync(filePath, 'not a directory');
cases.callerPathVoice = refusalOf(run(decodeOf(filePath)));

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(JSON.stringify({ faces: DAMAGE_FACES, controls: CONTROLS, cases }));
