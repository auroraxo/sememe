#!/usr/bin/env node
// tools/store-input-voice-probe.mjs — DOES THE PRODUCT ANSWER A CALLER'S
// WRONG STORE PATH IN ITS OWN VOICE, OR IN THE KERNEL'S?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix). It answers
// only observable questions about the tree it runs inside: it spawns THAT
// tree's bin/sememe.mjs and reads nothing else. Nothing here asserts a
// verdict about which tree is right — the tool that runs this derives the
// verdict from the two runs.
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, the PUBLISHED
// sememe@0.4.31 installed into an empty app, and reproduced against the
// pre-fix tree 3ef9ca8):
//
// The caller names a STORE DIRECTORY — `--store <dir>` — and sememe keeps
// two directories inside it (`receipts/`, `objects/`). When the path is
// wrong, the product answered with the KERNEL's error, verbatim:
//
//   sememe decode <program> <payload> --store /tmp/store-file
//     -> {"error":"ENOTDIR: not a directory, scandir '/tmp/store-file/receipts'"}
//        exit 1
//
//   sememe adopt <program> <file> --store /tmp/store-file
//     -> {"error":"ENOTDIR: not a directory, mkdir '/tmp/store-file/objects'"}
//        exit 1
//
// Three things are wrong with that answer, and each of them is measurable:
//
//   1. NO NAME. The operator gets a syscall's prose, not the product's.
//      There is no code a script can branch on and no repair to act on.
//   2. NO SUBJECT. The refusal does not say WHICH path was wrong — the
//      store root, its receipts/ directory or its objects/ directory.
//   3. THE WRONG CHANNEL. A path the caller mistyped is not "the work
//      failed". It shares exit 1 with a real refusal (a drifted store, a
//      tampered receipt), so a CI script cannot tell "you pointed me at
//      nothing" from "your store drifted".
//
// The caller-named FILE was closed on 2026-11-16 (src/file-input.mjs). The
// store DIRECTORY is the same class of input and was left behind: it is a
// path the caller chose, and it was the last one speaking raw kernel.
//
// Cases (every one is a path the CALLER chose):
//   decodeStoreIsFile        --store names a regular file
//   accountStoreIsFile       --store names a regular file
//   lockStoreIsFile          --store names a regular file
//   verifyStoreIsFile        --store names a regular file
//   conformStoreIsFile       --store names a regular file
//   decodeReceiptsIsFile     <store>/receipts is a regular file
//   lockReceiptsIsFile       <store>/receipts is a regular file
//   decodeReceiptsUnreadable <store>/receipts cannot be read
//   lockReceiptsUnreadable   <store>/receipts cannot be read
//   adoptStoreIsFile         --store names a regular file (write path)
//   adoptStoreReceiptsIsFile <store>/receipts is a regular file (write path)
//   adoptStoreObjectsIsFile  <store>/objects is a regular file (write path)
//   adoptObjectsUnwritable   <store>/objects exists but cannot be written
//
// The CONTROLS (they must behave the SAME in both trees — a fix that breaks
// the paths that were already correct is a regression, and the measurement
// must say so):
//   decodeStoreOk        a real store still answers the same way
//   lockStoreOk          a real store still locks the same way
//   adoptStoreOk         adopt into a fresh store still works
//   adoptStoreCreated    adopt into a store path that does not exist yet
//                        still creates it (the store is CREATED by a pull
//                        or an adopt — that is the documented path)
//   decodeStoreMissing   a store path that does not exist still answers
//                        with the product's own "no sememe store" sentence
//                        (NOT with an errno and NOT with a new refusal)
//
// WHAT WOULD FALSIFY THE FIX (counted directly by the tool):
//   * leakedErrnoFaces — a face whose refusal still carries a raw kernel
//     errno string. Must be 0 in the fixed tree.
//   * unnamedFaces    — a face whose refusal carries no product code. Must
//     be 0 in the fixed tree.
//   * repairlessFaces — a face whose refusal names no repair. Must be 0 in
//     the fixed tree.
//   * wrongChannelFaces — a face that travels on the wrong channel: an IO
//     refusal (nothing ran) must NOT share exit 1 with the work's own
//     failures. Must be 0 in the fixed tree.
//   * controlRegression — a control changed its verdict between the trees.
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
const TX = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

if (!fs.existsSync(BIN)) { console.error('no bin/sememe.mjs in this tree'); process.exit(3); }

// The kernel's errno strings. A refusal that carries one of these is talking
// in the kernel's voice, not the product's.
const ERRNO_STRINGS = [
  'ENOENT', 'EISDIR', 'EACCES', 'ENOTDIR', 'EPERM', 'ELOOP', 'EEXIST', 'EROFS',
  'no such file or directory', 'illegal operation on a directory',
  'permission denied', 'not a directory', 'file already exists',
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-store-voice-probe-'));

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
 *  and a repair. Anything else (a bare errno, an empty output) is not one.
 *
 *  The errno scan looks at the ERROR FIELD ONLY, not the whole answer: the
 *  refusal and its repair share one line, and a repair that happens to read
 *  like strerror must not be counted as a leak. */
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
    text: `${result.stderr}${result.stdout}`.slice(0, 400),
  };
}

const cases = {};
function record(name, result) { cases[name] = refusalOf(result); }

// --- the store fixtures -----------------------------------------------------

const storeIsFile = path.join(tmpRoot, 'store-is-file');
fs.writeFileSync(storeIsFile, 'not a store');

const receiptsIsFile = path.join(tmpRoot, 'receipts-is-file');
fs.mkdirSync(receiptsIsFile, { recursive: true });
fs.writeFileSync(path.join(receiptsIsFile, 'receipts'), 'not a directory');

const objectsIsFile = path.join(tmpRoot, 'objects-is-file');
fs.mkdirSync(objectsIsFile, { recursive: true });
fs.writeFileSync(path.join(objectsIsFile, 'objects'), 'not a directory');

const receiptsUnreadable = path.join(tmpRoot, 'receipts-unreadable');
fs.mkdirSync(path.join(receiptsUnreadable, 'receipts'), { recursive: true });
fs.chmodSync(path.join(receiptsUnreadable, 'receipts'), 0o000);

// A store whose layout is CORRECT but whose objects/ cannot be written:
// the kernel used to answer from inside the atomic writer ("EACCES:
// permission denied, open '…/objects/….tmp-…'"), i.e. from a path the
// caller chose, in the kernel's voice.
const objectsUnwritable = path.join(tmpRoot, 'objects-unwritable');
fs.mkdirSync(path.join(objectsUnwritable, 'objects'), { recursive: true });
fs.mkdirSync(path.join(objectsUnwritable, 'receipts'), { recursive: true });
fs.chmodSync(path.join(objectsUnwritable, 'objects'), 0o500);

// --- the defect faces -------------------------------------------------------

// A REAL lock file, so `verify` reaches the store read instead of refusing
// the missing lock first — the face under test is the STORE, not the lock.
const lockForVerify = path.join(tmpRoot, 'verify.lock');
run(['lock', '--store', STORE, '--out', lockForVerify]);

record('decodeStoreIsFile', run(['decode', PROGRAM, 'AAAA', '--store', storeIsFile]));
record('accountStoreIsFile', run(['account', PROGRAM, 'AAAA', '--store', storeIsFile]));
record('lockStoreIsFile', run(['lock', '--store', storeIsFile]));
record('verifyStoreIsFile', run(['verify', '--store', storeIsFile, '--lock', lockForVerify]));
record('conformStoreIsFile', run(['conform', TX, '--store', storeIsFile]));

record('decodeReceiptsIsFile', run(['decode', PROGRAM, 'AAAA', '--store', receiptsIsFile]));
record('lockReceiptsIsFile', run(['lock', '--store', receiptsIsFile]));
record('decodeReceiptsUnreadable', run(['decode', PROGRAM, 'AAAA', '--store', receiptsUnreadable]));
record('lockReceiptsUnreadable', run(['lock', '--store', receiptsUnreadable]));

record('adoptStoreIsFile', run(['adopt', PROGRAM, IDL, '--store', storeIsFile]));
record('adoptStoreReceiptsIsFile', run(['adopt', PROGRAM, IDL, '--store', receiptsIsFile]));
record('adoptStoreObjectsIsFile', run(['adopt', PROGRAM, IDL, '--store', objectsIsFile]));
record('adoptObjectsUnwritable', run(['adopt', PROGRAM, IDL, '--store', objectsUnwritable]));

// --- the controls -----------------------------------------------------------

const decodeOk = run(['decode', PROGRAM, 'AAAA', '--store', STORE]);
cases.decodeStoreOk = {
  ...refusalOf(decodeOk),
  answered: decodeOk.stdout.includes('name') || decodeOk.stdout.includes('trailing'),
};

const lockOk = run(['lock', '--store', STORE, '--out', path.join(tmpRoot, 'control.lock')]);
cases.lockStoreOk = {
  ...refusalOf(lockOk),
  lockWrote: fs.existsSync(path.join(tmpRoot, 'control.lock')),
};

const adoptOkStore = path.join(tmpRoot, 'adopt-ok');
const adoptOk = run(['adopt', PROGRAM, IDL, '--store', adoptOkStore]);
cases.adoptStoreOk = {
  ...refusalOf(adoptOk),
  stored: fs.existsSync(path.join(adoptOkStore, 'receipts')),
};

// A store path that does not exist yet is CREATED by the write path — that is
// the documented way to make a store ("the pull above is that creation
// step"). It must keep working.
const adoptCreatedStore = path.join(tmpRoot, 'adopt-created');
const adoptCreated = run(['adopt', PROGRAM, IDL, '--store', adoptCreatedStore]);
cases.adoptStoreCreated = {
  ...refusalOf(adoptCreated),
  stored: fs.existsSync(path.join(adoptCreatedStore, 'receipts')),
};

// A store path that does not exist is an ANSWER for the read paths, not a
// refusal: the product's own sentence must survive unchanged.
const decodeMissing = run(['decode', PROGRAM, 'AAAA', '--store', path.join(tmpRoot, 'no-such-store')]);
cases.decodeStoreMissing = {
  ...refusalOf(decodeMissing),
  namedByProduct: decodeMissing.stdout.includes('no sememe store at')
    || decodeMissing.stderr.includes('no sememe store at'),
};

console.log(JSON.stringify({ cases }, null, 2));

// Leave nothing behind: the unreadable directory is 0000 on purpose, so the
// temp tree has to be put back before it can be removed.
try {
  fs.chmodSync(path.join(receiptsUnreadable, 'receipts'), 0o700);
  fs.chmodSync(path.join(objectsUnwritable, 'objects'), 0o700);
} catch { /* already gone */ }
fs.rmSync(tmpRoot, { recursive: true, force: true });
