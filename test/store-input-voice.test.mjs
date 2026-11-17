// test/store-input-voice.test.mjs — A CALLER'S WRONG STORE PATH MUST BE
// REFUSED IN THE PRODUCT'S OWN VOICE, ON THE RIGHT CHANNEL.
//
// MEASURED (2026-11-17, this host, the PUBLISHED sememe@0.4.31 installed
// into an empty app, and reproduced against pre-fix tree a722b55):
//
// The caller names a STORE DIRECTORY — `--store <dir>` — and sememe keeps
// two directories inside it (`receipts/`, `objects/`). When that path is
// wrong the product answered with the KERNEL's error, verbatim:
//
//   sememe decode <program> <payload> --store /tmp/store-file
//     -> {"error":"ENOTDIR: not a directory, scandir '/tmp/store-file/receipts'"}
//        exit 1
//
// Three faults in that one answer, each of them measured:
//
//   D1  NO NAME: a syscall's prose — no code for a script to branch on.
//   D2  NO SUBJECT: the refusal did not say WHICH path was wrong — the
//       store root, its receipts/ or its objects/. Three faults, three
//       repairs, one unlabelled errno.
//   D3  WRONG CHANNEL: a mistyped path shared exit 1 with a real refusal
//       (a drifted store, a tampered receipt), so a CI script could not
//       tell "you pointed me at nothing" from "your store drifted".
//
// The caller-named FILE was closed on 2026-11-16 (src/file-input.mjs,
// released in v0.4.31). The store DIRECTORY is the same class of input and
// was left behind — measured on the very release that closed the files.
//
// THE CONTRACT (src/store-input.mjs is the ONE classifier):
//
//   C1  every caller-named store refusal carries a PRODUCT CODE naming the
//       path and the reason: store-<reason>, store-receipts-<reason>,
//       store-objects-<reason>.
//   C2  no refusal echoes the kernel: the errno string is INPUT, never
//       output — and the reason text is not strerror's either.
//   C3  every refusal names a REPAIR the operator can run.
//   C4  an IO failure — nothing was read, nothing ran — travels on the
//       usage/IO channel (exit 2), NOT on exit 1.
//   C5  a store that does not exist is NOT a refusal: the read paths keep
//       their "no sememe store" answer and the write paths CREATE the
//       store, because that is how a user makes one.
//   C6  the controls are untouched: a real store still decodes, locks and
//       adopts.
//
// The pre-fix numbers are pinned by the committed artifact
// (research/store-input-voice-2026-11-17.json, produced by
// tools/measure-store-input-voice.mjs): 13 of 13 faces leaked a raw errno on
// the pre-fix tree; 0 do here.

import test from 'node:test';
import assert from 'node:assert/strict';
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
const TX = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

const ERRNO_STRINGS = [
  'ENOENT', 'EISDIR', 'EACCES', 'ENOTDIR', 'EPERM', 'ELOOP', 'EEXIST', 'EROFS',
  'no such file or directory', 'illegal operation on a directory',
  'permission denied', 'not a directory', 'file already exists',
];

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
    // The errno scan looks at the ERROR FIELD ONLY: refusal and repair share
    // one line, and a repair that reads like strerror must not count.
    leakedErrno: ERRNO_STRINGS.filter((n) => String(parsed?.error ?? result.out).includes(n)),
    out: result.out,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-store-voice-'));
const storeIsFile = path.join(tmp, 'store-is-file');
fs.writeFileSync(storeIsFile, 'not a store');
const receiptsIsFile = path.join(tmp, 'receipts-is-file');
fs.mkdirSync(receiptsIsFile, { recursive: true });
fs.writeFileSync(path.join(receiptsIsFile, 'receipts'), 'not a directory');
const objectsIsFile = path.join(tmp, 'objects-is-file');
fs.mkdirSync(objectsIsFile, { recursive: true });
fs.writeFileSync(path.join(objectsIsFile, 'objects'), 'not a directory');
const receiptsUnreadable = path.join(tmp, 'receipts-unreadable');
fs.mkdirSync(path.join(receiptsUnreadable, 'receipts'), { recursive: true });
fs.chmodSync(path.join(receiptsUnreadable, 'receipts'), 0o000);
const objectsUnwritable = path.join(tmp, 'objects-unwritable');
fs.mkdirSync(path.join(objectsUnwritable, 'objects'), { recursive: true });
fs.mkdirSync(path.join(objectsUnwritable, 'receipts'), { recursive: true });
fs.chmodSync(path.join(objectsUnwritable, 'objects'), 0o500);
// A real lock file, so `verify` reaches the store read instead of refusing
// the missing lock first — the face under test is the STORE, not the lock.
const lockForVerify = path.join(tmp, 'verify.lock');
run(['lock', '--store', STORE, '--out', lockForVerify]);

// Restored in the last test: the temp tree cannot be removed otherwise.
test.after(() => {
  for (const dir of [
    path.join(receiptsUnreadable, 'receipts'),
    path.join(objectsUnwritable, 'objects'),
  ]) { try { fs.chmodSync(dir, 0o700); } catch { /* already gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const IO_FACES = [
  ['decodeStoreIsFile', ['decode', PROGRAM, 'AAAA', '--store', storeIsFile], 'store-not_a_directory'],
  ['accountStoreIsFile', ['account', PROGRAM, 'AAAA', '--store', storeIsFile], 'store-not_a_directory'],
  ['lockStoreIsFile', ['lock', '--store', storeIsFile], 'store-not_a_directory'],
  ['verifyStoreIsFile', ['verify', '--store', storeIsFile, '--lock', lockForVerify], 'store-not_a_directory'],
  ['conformStoreIsFile', ['conform', TX, '--store', storeIsFile], 'store-not_a_directory'],
  ['decodeReceiptsIsFile', ['decode', PROGRAM, 'AAAA', '--store', receiptsIsFile], 'store-receipts-not_a_directory'],
  ['lockReceiptsIsFile', ['lock', '--store', receiptsIsFile], 'store-receipts-not_a_directory'],
  ['decodeReceiptsUnreadable', ['decode', PROGRAM, 'AAAA', '--store', receiptsUnreadable], 'store-receipts-unreadable'],
  ['lockReceiptsUnreadable', ['lock', '--store', receiptsUnreadable], 'store-receipts-unreadable'],
  ['adoptStoreIsFile', ['adopt', PROGRAM, IDL, '--store', storeIsFile], 'store-not_a_directory'],
  ['adoptStoreReceiptsIsFile', ['adopt', PROGRAM, IDL, '--store', receiptsIsFile], 'store-receipts-not_a_directory'],
  ['adoptStoreObjectsIsFile', ['adopt', PROGRAM, IDL, '--store', objectsIsFile], 'store-objects-not_a_directory'],
  ['adoptObjectsUnwritable', ['adopt', PROGRAM, IDL, '--store', objectsUnwritable], 'store-objects-unreadable'],
];

for (const [name, args, expectedCode] of IO_FACES) {
  test(`C1/C2/C3/C4 — ${name}: named, kernel-free, repaired, exit 2`, () => {
    const face = refusal(run(args));
    assert.equal(face.code, expectedCode, `the refusal must carry its product code (got ${face.code}); output: ${face.out.slice(0, 300)}`);
    assert.deepEqual(face.leakedErrno, [], `the refusal must not echo the kernel: ${face.leakedErrno}`);
    assert.ok(face.fix && /^fix: /.test(face.fix), `the refusal must name a repair (got ${face.fix})`);
    assert.equal(face.exit, 2, `an IO refusal is the usage/IO channel, not the work channel (exit ${face.exit})`);
  });
}

test('C1/D2 — the refusal names the SUBJECT, so the operator knows which path was wrong', () => {
  const root = refusal(run(['decode', PROGRAM, 'AAAA', '--store', storeIsFile]));
  assert.match(root.out, /the store /, 'the store root refusal must say it is the store itself');
  assert.match(root.out, new RegExp(path.basename(storeIsFile)), 'the refusal must quote the path it was given');

  const receipts = refusal(run(['decode', PROGRAM, 'AAAA', '--store', receiptsIsFile]));
  assert.match(receipts.out, /receipts directory/, 'the receipts refusal must say which directory');
  assert.match(receipts.out, new RegExp(path.join('receipts-is-file', 'receipts')), 'and quote that path');

  const objects = refusal(run(['adopt', PROGRAM, IDL, '--store', objectsIsFile]));
  assert.match(objects.out, /objects directory/, 'the objects refusal must say which directory');
});

test('C2 — the reason is the product\'s own wording, not the kernel\'s strerror', () => {
  const face = refusal(run(['decode', PROGRAM, 'AAAA', '--store', storeIsFile]));
  // "not a directory" is the kernel's phrase (ENOTDIR). The product must not
  // hand it back — this is what the first run of the measurement caught.
  assert.doesNotMatch(face.out, /not a directory/, `the refusal must not quote strerror: ${face.out.slice(0, 200)}`);
});

test('C4 — the conformance gate passes the store refusal through instead of wrapping it', () => {
  const face = refusal(run(['conform', TX, '--store', storeIsFile]));
  assert.equal(face.code, 'store-not_a_directory',
    `the wrap used to swallow the code and quote ENOTDIR: ${face.out.slice(0, 300)}`);
  assert.equal(face.exit, 2, 'an unusable store path means the gate never ran');
  assert.deepEqual(face.leakedErrno, [], 'and the wrapper must not quote the kernel either');
});

test('C5 — a store that does not exist is an ANSWER, not a refusal', () => {
  const read = refusal(run(['decode', PROGRAM, 'AAAA', '--store', path.join(tmp, 'no-such-store')]));
  assert.ok(read.out.includes('no sememe store at'),
    `the read paths keep their own sentence: ${read.out.slice(0, 300)}`);
  assert.equal(read.code, null, 'the missing-store answer is not a store-input refusal');

  // The WRITE path CREATES the store: that is how a user makes one.
  const created = path.join(tmp, 'created-by-adopt');
  const write = run(['adopt', PROGRAM, IDL, '--store', created]);
  assert.equal(write.exit, 0, `adopt into a new store path must create it: ${write.out.slice(0, 300)}`);
  assert.ok(fs.existsSync(path.join(created, 'receipts')), 'the store must have been created');
});

test('C6 — the controls are untouched: decode, lock and adopt still work', () => {
  const decode = run(['decode', PROGRAM, 'AAAA', '--store', STORE]);
  // The fixture payload is not a real instruction — the WORK fails, which is
  // its own business: what must not happen is a store refusal.
  assert.ok(!decode.out.includes('store-not_a_directory'),
    `a real store must not be refused: ${decode.out.slice(0, 300)}`);

  const lockOut = path.join(tmp, 'control.lock');
  const lock = run(['lock', '--store', STORE, '--out', lockOut]);
  assert.equal(lock.exit, 0, `lock over a real store must succeed: ${lock.out.slice(0, 300)}`);
  assert.ok(fs.existsSync(lockOut), 'the lock file must be written');

  const verify = run(['verify', '--store', STORE, '--lock', lockOut]);
  assert.equal(verify.exit, 0, `verify over what it wrote must pass: ${verify.out.slice(0, 300)}`);

  const adopt = run(['adopt', PROGRAM, IDL, '--store', path.join(tmp, 'store-ok')]);
  assert.equal(adopt.exit, 0, `adopt of a real interface file must succeed: ${adopt.out.slice(0, 300)}`);
});

test('the committed measurement is the one the tool produces, and its baseline really had the defect', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'store-input-voice-2026-11-17.json'), 'utf8'));
  assert.equal(artifact.verdictName, 'store-input-voice-closed', 'the verdict must be closed');
  assert.equal(artifact.verdict.preFixLeakedErrno, 13, 'the pre-fix tree must have leaked: a baseline with no defect makes the fix unmeasurable');
  assert.equal(artifact.verdict.fixedLeakedErrno, 0, 'the fixed tree must leak nothing');
  assert.equal(artifact.verdict.fixedUnnamedFaces, 0, 'no refusal may be unnamed');
  assert.equal(artifact.verdict.fixedWrongChannelFaces, 0, 'no IO refusal may travel on exit 1');
  assert.equal(artifact.verdict.controlRegression, 0, 'no control may change verdict');
  assert.equal(artifact.hostPathLeak, 0, 'research/ is committed — no host path in it');
});

test('G1 — an unusable store through the library is refused, and by name', async () => {
  const { readStoreReceipts } = await import('../src/store-input.mjs');
  await assert.rejects(
    () => readStoreReceipts(storeIsFile),
    (error) => {
      assert.equal(error.code, 'store-not_a_directory', `library refusal must carry the code: ${error.message}`);
      assert.equal(error.exitCode, 2, 'and its channel');
      assert.match(error.fix, /^fix: /, 'and its repair');
      return true;
    },
  );
  // A missing store is NOT a refusal: the original ENOENT is re-thrown so
  // the caller keeps its own "no sememe store" sentence.
  await assert.rejects(
    () => readStoreReceipts(path.join(tmp, 'no-such-store')),
    (error) => error?.code === 'ENOENT' && !error.fix,
  );
});

test('G2 — the classifier is the ONE place: every minted code parses as a store-input code', async () => {
  const { isStoreInputCode, storeRefusal, classifyStoreErrno } = await import('../src/store-input.mjs');
  for (const [, , code] of IO_FACES) {
    assert.ok(isStoreInputCode(code), `${code} must be recognisable as a store-input refusal`);
  }
  assert.ok(!isStoreInputCode('no-sememe-store'), 'the missing-store answer is NOT this class');
  assert.ok(!isStoreInputCode('lock-v1-parse'), 'neither is the lock document\'s own reason');
  assert.ok(!isStoreInputCode('adopt-file-missing'), 'neither is the file classifier\'s');
  const refusal = storeRefusal({ code: 'store-receipts-unreadable', subject: 'receipts directory', storePath: '/x/receipts', kind: 'unreadable' });
  assert.equal(refusal.exitCode, 2, 'an IO refusal defaults to the usage/IO channel');
  assert.match(refusal.message, /\/x\/receipts/, 'and it quotes the path it was given');
  assert.equal(classifyStoreErrno(Object.assign(Error('x'), { code: 'ENOTDIR' })), 'not_a_directory');
  assert.equal(classifyStoreErrno(Object.assign(Error('x'), { code: 'ENOENT' })), 'missing');
  assert.equal(classifyStoreErrno(Error('not a filesystem error')), null, 'a non-filesystem error keeps its own voice');
});
