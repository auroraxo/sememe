// test/store-damage-voice.test.mjs — DAMAGE THE READER FINDS IN A STORE
// MUST BE REFUSED IN THE PRODUCT'S OWN VOICE.
//
// MEASURED (2026-11-17, this host, this tree, and reproduced against the
// PUBLISHED sememe@0.4.32 installed into an empty app):
//
// The caller-named PATH was closed twice already (src/file-input.mjs on
// 2026-11-16 — v0.4.31; src/store-input.mjs on 2026-11-17 — v0.4.32). What
// stayed behind is the input the product finds ITSELF: the store path was
// RIGHT, and the store turned out to be damaged. The reader refused it —
// but in the kernel's voice, with no code, no repair, and the operator's
// home path in the message:
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
//
//   D1  NO NAME: a syscall's prose — no code a script can branch on, no
//       repair to act on. The SAME product names its own refusals
//       everywhere else ("no sememe store at X", "lock-v1-parse",
//       "adopt-file-not_json").
//   D2  NO SUBJECT: receipt damage and object damage are told apart only by
//       prose, though they have DIFFERENT repairs — a receipt is re-pulled,
//       an object is restored from its fingerprint.
//   D3  THE WRONG VOCABULARY: the kernel's errno strings, quoted verbatim,
//       plus a host path in a CI log.
//
// THE CONTRACT (src/store-damage.mjs is the ONE classifier):
//
//   C1  every damage refusal carries a PRODUCT CODE naming the subject and
//       the reason: store-receipt-<reason> / store-object-<reason>.
//   C2  no refusal echoes the kernel: the errno string is INPUT, never
//       output — and the reason text is not strerror's either.
//   C3  every refusal names a REPAIR the operator can run.
//   C4  the CHANNEL does not move: damage is the WORK channel (exit 1) —
//       the store path was usable and the product found broken bytes in it.
//       (A path the CALLER named wrong keeps the usage/IO channel, exit 2;
//       the two classes must not collapse into one.)
//   C5  the sentences other tools quote stay at the FRONT of the message:
//       "… is not a receipt for …", "… claims object <hash> but the store
//       object is missing", "… is not JSON …", "… re-hashes to sha256:<hash>
//       … disagree, refusing to decode".
//   C6  no refusal quotes an ABSOLUTE path: the store lives in the
//       operator's home directory, and a refusal that prints it prints that
//       home into a CI log.
//   C7  the controls are untouched: an intact store still decodes; a store
//       that does not exist still answers with its own sentence; a program
//       the store simply lacks is still an acquisition gap, not a refusal.
//
// The pre-fix numbers are pinned by the committed artifact
// (research/store-damage-voice-2026-11-17.json, produced by
// tools/measure-store-damage-voice.mjs): 4 of the 11 faces leaked a raw
// errno on the pre-fix tree (9fe90e5); 0 do here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const PAYLOAD_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'mainnet-whirlpool.json');

const ERRNO_STRINGS = [
  'ENOENT', 'EISDIR', 'EACCES', 'ENOTDIR', 'EPERM', 'ELOOP', 'EEXIST', 'EROFS', 'ENOSPC',
  'no such file or directory', 'illegal operation on a directory',
  'permission denied', 'not a directory', 'file already exists',
];

const { canonicalJson } = await import('../src/canonical.mjs');
const idl = JSON.parse(fs.readFileSync(IDL, 'utf8'));
const payloadFixture = JSON.parse(fs.readFileSync(PAYLOAD_FIXTURE, 'utf8'));
const swap = payloadFixture.records.find((record) => record.name === 'swap_v2');
assert.ok(swap, 'the mainnet fixture must hold a swap_v2 record');
const objectBytes = Buffer.from(canonicalJson(idl) + '\n');
const fingerprint = createHash('sha256').update(objectBytes).digest('hex');
const receiptName = `${PROGRAM}-462039125-metadata-${fingerprint}.json`;

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { exit: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** The product's refusal as a script sees it: a JSON object with code+fix. */
function refusal(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.out.trim()); } catch { parsed = null; }
  return {
    exit: result.exit,
    code: parsed?.code ?? null,
    fix: parsed?.fix ?? null,
    // An ANSWER (src/store-answer.mjs) carries `answer: true` — acquire, do
    // not repair. It is never a refusal and never carries a repair.
    answer: parsed?.answer === true,
    // The errno scan looks at the ERROR FIELD ONLY: refusal and repair share
    // one line, and a repair that happens to read like strerror must not
    // count as a leak.
    leakedErrno: ERRNO_STRINGS.filter((n) => String(parsed?.error ?? result.out).includes(n)),
    out: result.out,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-store-damage-'));
const stores = {};

/** A store exactly as `sememe pull` writes it, then damaged in one way. */
function makeStore(name, mutate) {
  const store = path.join(tmp, name);
  fs.mkdirSync(path.join(store, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(store, 'objects'), { recursive: true });
  const receipt = { program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata' };
  const writeReceipt = (body) => fs.writeFileSync(
    path.join(store, 'receipts', receiptName), typeof body === 'string' ? body : JSON.stringify(body));
  const writeObject = (body) => fs.writeFileSync(
    path.join(store, 'objects', `${fingerprint}.json`), body);
  writeObject(objectBytes);
  writeReceipt(receipt);
  if (mutate) mutate({ store, receipt, writeReceipt, writeObject });
  return store;
}

stores.receiptIsFile = makeStore('receipt-is-file', ({ store }) => {
  fs.rmSync(path.join(store, 'receipts', receiptName));
  fs.mkdirSync(path.join(store, 'receipts', receiptName));
});
stores.receiptUnreadable = makeStore('receipt-unreadable', ({ store }) => {
  fs.chmodSync(path.join(store, 'receipts', receiptName), 0o000);
});
stores.receiptNotJson = makeStore('receipt-not-json', ({ writeReceipt }) => writeReceipt('nope'));
stores.receiptForeign = makeStore('receipt-foreign', ({ receipt, writeReceipt }) => writeReceipt(
  { ...receipt, program: OTHER_PROGRAM }));
stores.receiptMalformed = makeStore('receipt-malformed', ({ receipt, writeReceipt }) => writeReceipt(
  { ...receipt, fingerprint: 'sha256:not-a-fingerprint' }));
stores.objectIsFile = makeStore('object-is-file', ({ store }) => {
  fs.rmSync(path.join(store, 'objects', `${fingerprint}.json`));
  fs.mkdirSync(path.join(store, 'objects', `${fingerprint}.json`));
});
stores.objectUnreadable = makeStore('object-unreadable', ({ store }) => {
  fs.chmodSync(path.join(store, 'objects', `${fingerprint}.json`), 0o000);
});
stores.objectNotJson = makeStore('object-not-json', ({ writeObject }) => writeObject('{not json'));
stores.objectNoInstructions = makeStore('object-no-instructions', ({ writeObject }) => {
  writeObject(Buffer.from(`${canonicalJson({ address: PROGRAM, types: [] })}\n`));
});
stores.objectMissing = makeStore('object-missing', ({ store }) => {
  fs.rmSync(path.join(store, 'objects', `${fingerprint}.json`));
});
stores.objectRehash = makeStore('object-rehash', ({ writeObject }) => {
  const tampered = JSON.parse(objectBytes.toString('utf8'));
  tampered.instructions[0].name = 'totally_honest_name';
  writeObject(Buffer.from(`${canonicalJson(tampered)}\n`));
});
stores.intact = makeStore('intact');

const decodeOf = (store) => ['decode', PROGRAM, swap.dataHex, '--store', store];

test.after(() => {
  for (const p of [
    path.join(stores.receiptUnreadable, 'receipts', receiptName),
    path.join(stores.objectUnreadable, 'objects', `${fingerprint}.json`),
  ]) { try { fs.chmodSync(p, 0o600); } catch { /* already gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Each face: the code it must carry, and the subject it must name. */
const FACES = [
  ['receiptIsFile', 'store-receipt-not_a_file', /receipt/],
  ['receiptUnreadable', 'store-receipt-unreadable', /receipt/],
  ['receiptNotJson', 'store-receipt-not_json', /receipt/],
  ['receiptForeign', 'store-receipt-foreign_program', /receipt/],
  ['receiptMalformed', 'store-receipt-malformed', /receipt/],
  ['objectIsFile', 'store-object-not_a_file', /object/],
  ['objectUnreadable', 'store-object-unreadable', /object/],
  ['objectNotJson', 'store-object-not_json', /object/],
  ['objectNoInstructions', 'store-object-not_an_idl', /object|instructions/],
  ['objectMissing', 'store-object-missing', /object|missing/],
  ['objectRehash', 'store-object-rehash_mismatch', /re-hashes/],
];

for (const [name, expectedCode, subject] of FACES) {
  test(`C1/C2/C3/C4 — ${name}: named, kernel-free, repaired, exit 1`, () => {
    const face = refusal(run(decodeOf(stores[name])));
    assert.equal(face.code, expectedCode,
      `the refusal must carry its product code (got ${face.code}); output: ${face.out.slice(0, 300)}`);
    assert.deepEqual(face.leakedErrno, [],
      `the refusal must not echo the kernel: ${face.leakedErrno}`);
    assert.ok(face.fix && /^fix: /.test(face.fix),
      `the refusal must name a repair (got ${face.fix})`);
    assert.equal(face.exit, 1,
      `damage is the WORK channel — the store path was usable (exit ${face.exit})`);
    assert.match(face.out, subject,
      `the refusal must name the subject it is about: ${face.out.slice(0, 300)}`);
  });
}

test('C2 — the reason is the product\'s own wording, not the kernel\'s strerror', () => {
  for (const [name] of FACES) {
    const face = refusal(run(decodeOf(stores[name])));
    assert.doesNotMatch(face.out, /permission denied|illegal operation on a directory|not a directory/,
      `${name} must not quote strerror: ${face.out.slice(0, 240)}`);
  }
});

test('C5 — the sentences other tools quote stay at the FRONT of the message', () => {
  const foreign = refusal(run(decodeOf(stores.receiptForeign)));
  assert.match(foreign.out, /is not a receipt for/,
    'the "not a receipt for" sentence is quoted by the README and the lock');
  const missing = refusal(run(decodeOf(stores.objectMissing)));
  assert.match(missing.out, /but the store object is missing/,
    'the dangling-receipt sentence is quoted by the lock report');
  const notJson = refusal(run(decodeOf(stores.objectNotJson)));
  assert.match(notJson.out, /is not JSON/, 'the unparsable-object sentence is quoted by a test');
  const rehash = refusal(run(decodeOf(stores.objectRehash)));
  assert.match(rehash.out, /re-hashes to sha256:[a-f0-9]{64}/,
    'the re-hash refusal names both hashes and says it will not decode');
  assert.match(rehash.out, /disagree, refusing to decode/,
    'and it keeps the "refusing to decode" half');
});

test('C6 — no refusal quotes an ABSOLUTE path (the store lives in the home directory)', () => {
  for (const [name] of FACES) {
    const face = refusal(run(decodeOf(stores[name])));
    assert.doesNotMatch(face.out, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${name} must not quote the store's absolute path: ${face.out.slice(0, 240)}`);
  }
});

test('C7 — the controls are untouched: an intact store still decodes', () => {
  const face = refusal(run(decodeOf(stores.intact)));
  assert.equal(face.exit, 0, `an intact store must still decode: ${face.out.slice(0, 300)}`);
  assert.match(face.out, /"instruction": "swap_v2"/, 'and it must decode the real payload');
});

test('C7 — a store that does not exist is an ANSWER: named, but never a damage refusal', () => {
  const face = refusal(run(decodeOf(path.join(tmp, 'no-such-store'))));
  assert.match(face.out, /no sememe store at/,
    `the read paths keep their own sentence: ${face.out.slice(0, 300)}`);
  // Since 2026-11-17 the answer carries its own code and its own semantics
  // (src/store-answer.mjs): `answer: true` means ACQUIRE, do not repair. It
  // is still NOT a damage refusal — it must never acquire a repair.
  assert.equal(face.code, 'no-sememe-store', 'the answer is named');
  assert.equal(face.fix, null, 'but it carries no repair');
  assert.equal(face.answer, true, 'and it says so');
});

test('C7 — a program the store simply lacks is an acquisition gap: named, but never a refusal', () => {
  const face = refusal(run(['decode', OTHER_PROGRAM, swap.dataHex, '--store', stores.intact]));
  assert.match(face.out, /no stored IDL for program/,
    `an honest gap keeps its own sentence: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'no-stored-idl', 'the gap is named');
  assert.equal(face.fix, null, 'and it must not be dressed up as damage');
  assert.equal(face.answer, true, 'it is an answer: acquire, do not repair');
});

test('C4 — the CALLER-NAMED path class keeps its own voice and its own channel', () => {
  const storeIsFile = path.join(tmp, 'store-is-file');
  fs.writeFileSync(storeIsFile, 'not a directory');
  const face = refusal(run(decodeOf(storeIsFile)));
  assert.equal(face.code, 'store-not_a_directory',
    `the path class must not be swallowed by the damage class: ${face.out.slice(0, 300)}`);
  assert.equal(face.exit, 2, 'a path the caller named wrong keeps the usage/IO channel');
  assert.deepEqual(face.leakedErrno, [], 'and it still does not quote the kernel');
});

test('the committed measurement is the one the tool produces, and its baseline really had the defect', () => {
  const artifact = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'research', 'store-damage-voice-2026-11-17.json'), 'utf8'));
  assert.equal(artifact.verdictName, 'store-damage-voice-closed', 'the verdict must be closed');
  assert.ok(artifact.verdict.preFixLeakedErrno > 0,
    'the pre-fix tree must have leaked: a baseline with no defect makes the fix unmeasurable');
  assert.equal(artifact.verdict.fixedLeakedErrno, 0, 'the fixed tree must leak nothing');
  assert.equal(artifact.verdict.fixedUnnamedFaces, 0, 'no refusal may be unnamed');
  assert.equal(artifact.verdict.fixedRepairlessFaces, 0, 'no refusal may be repairless');
  assert.equal(artifact.verdict.fixedWrongChannelFaces, 0, 'no damage refusal may leave the work channel');
  assert.equal(artifact.verdict.controlRegression, 0, 'no control may change verdict');
  assert.equal(artifact.hostPathLeak, 0, 'research/ is committed — no host path in it');
  assert.equal(artifact.tempPathLeak, 0, 'and no absolute temp path either');
});

test('G3 — the LOCK surface refuses the same damage in the same voice', () => {
  // `sememe lock` re-checks every receipt through the reader. It must not
  // swallow the reader's code and repair by re-wrapping the message in a
  // plain Error (measured 2026-11-17, this host: the lock answered with a
  // sentence and no code, so a script could not branch on it).
  const face = refusal(run(['lock', '--store', stores.receiptUnreadable]));
  assert.equal(face.code, 'store-receipt-unreadable',
    `the lock must carry the reader's code: ${face.out.slice(0, 300)}`);
  assert.ok(face.fix && /^fix: /.test(face.fix),
    `and the reader's repair: ${face.out.slice(0, 300)}`);
  assert.deepEqual(face.leakedErrno, [], 'and no kernel errno');
  assert.equal(face.exit, 1, 'damage is the work channel');
});

test('G1 — the same damage is refused by name through the LIBRARY', async () => {
  const { findStoredIdl } = await import('../src/store-read.mjs');
  await assert.rejects(
    () => findStoredIdl(stores.receiptIsFile, PROGRAM),
    (error) => {
      assert.equal(error.code, 'store-receipt-not_a_file', `library refusal must carry the code: ${error.message}`);
      assert.equal(error.exitCode, 1, 'and its channel');
      assert.match(error.fix, /^fix: /, 'and its repair');
      return true;
    },
  );
});

test('G2 — the classifier is the ONE place: every minted code parses as a damage code', async () => {
  const { isStoreDamageCode, storeDamageRefusal, classifyDamageErrno } = await import('../src/store-damage.mjs');
  for (const [, code] of FACES) {
    assert.ok(isStoreDamageCode(code), `${code} must be recognisable as a store-damage refusal`);
  }
  assert.ok(!isStoreDamageCode('store-not_a_directory'),
    'the CALLER-NAMED path class is NOT this class');
  assert.ok(!isStoreDamageCode('no-sememe-store'), 'the missing-store answer is NOT this class');
  assert.ok(!isStoreDamageCode('no-stored-idl'), 'nor is an acquisition gap');
  assert.ok(!isStoreDamageCode('receipt-relabelled'), 'nor the receipt\'s own digest reason');
  const refusal = storeDamageRefusal({
    code: 'store-receipt-unreadable', kind: 'unreadable', message: 'store receipt x is unreadable', path: 'receipts/x.json',
  });
  assert.equal(refusal.exitCode, 1, 'damage defaults to the work channel');
  assert.match(refusal.message, /store receipt x is unreadable \(store-receipt-unreadable\)/,
    'and the code rides at the end of the product\'s own sentence');
  assert.equal(classifyDamageErrno(Object.assign(Error('x'), { code: 'EISDIR' })), 'not_a_file');
  assert.equal(classifyDamageErrno(Object.assign(Error('x'), { code: 'ENOENT' })), 'missing');
  assert.equal(classifyDamageErrno(Error('not a filesystem error')), null,
    'a non-filesystem error keeps its own voice');
});
