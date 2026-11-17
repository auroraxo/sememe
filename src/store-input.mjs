// src/store-input.mjs — ONE classification place for the STORE a caller
// points at.
//
// WHY THIS FILE EXISTS (measured 2026-11-17, this host, the PUBLISHED
// sememe@0.4.31 installed into an empty app):
//
// The caller names a STORE DIRECTORY — `--store <dir>` — and sememe keeps
// two directories inside it (`receipts/`, `objects/`). When that path is
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
//      store root, its `receipts/` directory or its `objects/` directory.
//      "not a directory" about `.../receipts` and about the store root are
//      different faults with different repairs, and the errno text names
//      neither of them for the operator who has to choose.
//   3. THE WRONG CHANNEL. A path the caller mistyped is not "the work
//      failed". It shares exit 1 with a real refusal (a drifted store, a
//      tampered receipt) — so a CI script cannot tell "you pointed me at
//      nothing" from "your store drifted", and the usage/IO channel the
//      product already reserves (exit 2) went unused.
//
// The caller-named FILE was closed on 2026-11-16 (src/file-input.mjs). The
// store DIRECTORY is the same class of input and was the last one speaking
// raw kernel.
//
// THE CONTRACT:
//
//   The store is a DIRECTORY the caller named, and sememe keeps two
//   directories inside it. Each of the three paths gets its own named code:
//
//     store-not_a_directory            the store path is not a directory
//     store-unreadable                 the store path cannot be read
//     store-receipts-not_a_directory   <store>/receipts is not a directory
//     store-receipts-unreadable        <store>/receipts cannot be read
//     store-objects-not_a_directory     <store>/objects is not a directory
//     store-objects-unreadable          <store>/objects cannot be written
//
//   Each becomes a sentence that names the exact path, and a REPAIR line —
//   what the caller has to change. The errno never reaches the operator;
//   the errno CODE is not even echoed, because a code is still the kernel's
//   vocabulary. The wording is deliberately NOT strerror's own: "cannot be
//   used as a directory" rather than "is not a directory", because the
//   refusal and its repair travel on the same channel a leak detector
//   scans, and a repair that reads like the kernel must not be counted as
//   one (the same trap the file-input classifier documented).
//
//   IO failures are USAGE failures: nothing was read, nothing was written,
//   no work ran. They take the usage/IO channel (exit 2), the channel the
//   product already reserves for an invocation that cannot be what the
//   caller meant.
//
// WHAT IS NOT A REFUSAL HERE — the case that must NOT change:
//
//   A store path that does not exist is an ANSWER, not an error: the read
//   paths keep their own sentence ("no sememe store at X: run \"sememe
//   pull\" first" — quoted by the README, the CLI and several tests), and
//   the WRITE paths create it, because creating the store is how a user
//   makes one ("the pull above is that creation step"). A missing store is
//   not a broken store.

import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const REASONS = {
  // Deliberately not phrased like the kernel's own strerror text ("not a
  // directory") — the leak detector scans this channel.
  not_a_directory: 'cannot be used as a directory',
  unreadable: 'cannot be read',
  no_space: 'has no space left',
};

const REPAIRS = {
  not_a_directory: 'point --store at a directory sememe can use (it holds receipts/ and objects/)',
  unreadable: 'make the path readable and writable (chmod) and point --store at it',
  no_space: 'free space on the device holding the store and try again',
};

/** The errno classes this file knows by name. A failure outside this set is
 *  still a refusal — it is classified `unreadable` rather than passed
 *  through, because an unnamed kernel error is exactly what this file
 *  exists to end. `null` means "this error is not a filesystem error at
 *  all" (a digest collision, a product refusal) and must keep its own
 *  voice. */
export function classifyStoreErrno(error) {
  const code = error?.code;
  if (typeof code !== 'string') return null;
  if (code === 'ENOENT') return 'missing';
  if (code === 'ENOTDIR' || code === 'EEXIST') return 'not_a_directory';
  if (code === 'ENOSPC') return 'no_space';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'unreadable';
  return 'unreadable';
}

/** True for a code this module minted. Used by the CLI and by the
 *  conformance gate to tell a NAMED store refusal from an ordinary error,
 *  without matching on message text. */
export function isStoreInputCode(code) {
  return typeof code === 'string' && /^store-(?:(?:receipts|objects)-)?[a-z_]+$/.test(code);
}

/** Build a named refusal. `exitCode` is the channel the refusal travels on:
 *  2 for the IO faces (nothing ran), 1 for a content face (the work ran and
 *  found the wrong bytes). */
export function storeRefusal({ code, subject, storePath, kind, exitCode = 2 }) {
  const reason = REASONS[kind] ?? REASONS.unreadable;
  const repair = REPAIRS[kind] ?? REPAIRS.unreadable;
  const error = new Error(`sememe store: the ${subject} ${storePath} ${reason} (${code})`);
  error.code = code;
  error.fix = `fix: ${repair}`;
  error.exitCode = exitCode;
  error.storePath = storePath;
  return error;
}

/** The store root, checked. Returns 'missing' when the path does not exist
 *  (the caller's own business — see the header), and throws a named refusal
 *  for every other way the path cannot be used. */
async function assertStoreRoot(storeDir) {
  let entry;
  try { entry = await lstat(storeDir); }
  catch (error) {
    const kind = classifyStoreErrno(error);
    if (kind === 'missing') return 'missing';
    throw storeRefusal({ code: 'store-unreadable', subject: 'store', storePath: storeDir, kind: 'unreadable' });
  }
  if (!entry.isDirectory()) {
    throw storeRefusal({
      code: 'store-not_a_directory', subject: 'store', storePath: storeDir, kind: 'not_a_directory',
    });
  }
  return 'present';
}

/** List `<store>/receipts` — the ONE read of the receipt directory.
 *
 *  A missing store is re-thrown as the ORIGINAL errno, so the caller keeps
 *  owning the "no sememe store at X" sentence (src/store-read.mjs and
 *  src/lock.mjs each word it their own way, and both are quoted). Every
 *  other failure becomes a NAMED refusal: the store path is a path the
 *  caller chose, and it gets the product's voice like every other one. */
export async function readStoreReceipts(storeDir) {
  await assertStoreRoot(storeDir);
  const receipts = path.join(storeDir, 'receipts');
  try { return await readdir(receipts); }
  catch (error) {
    const kind = classifyStoreErrno(error);
    if (kind === 'missing') throw error;
    throw storeRefusal({
      code: `store-receipts-${kind}`, subject: 'receipts directory', storePath: receipts, kind,
    });
  }
}

/** Create `<store>/objects` and `<store>/receipts` — the ONE write of the
 *  store's directories.
 *
 *  A store that does not exist yet is CREATED here: that is how a user
 *  makes a store, and the README says so. A path that exists but cannot be
 *  used is refused by name, exactly like the read path — the same fault
 *  must not answer in two voices depending on which command found it. */
export async function ensureStoreDirs(storeDir) {
  await assertStoreRoot(storeDir);
  for (const part of ['objects', 'receipts']) {
    const dir = path.join(storeDir, part);
    try { await mkdir(dir, { recursive: true, mode: 0o700 }); }
    catch (error) {
      const kind = classifyStoreErrno(error);
      if (!kind) throw error;
      throw storeRefusal({
        code: `store-${part}-${kind === 'missing' ? 'unreadable' : kind}`,
        subject: `${part} directory`,
        storePath: dir,
        kind: kind === 'missing' ? 'unreadable' : kind,
      });
    }
  }
}

/** A write INTO one of the store's directories that the kernel refused.
 *
 *  `writeOnce` (src/store-write.mjs) installs content-addressed objects
 *  and receipts; when the directory cannot be written, the kernel's errno
 *  used to escape verbatim ("EACCES: permission denied, open '...'"). It is
 *  the same class of input — a path the caller chose — so it gets the same
 *  named refusal. A failure that is NOT a filesystem error (a digest
 *  collision, a product refusal) keeps its own voice and its own channel:
 *  that is the work failing, not the path. */
export function storeWriteRefusal(error, { part, storePath }) {
  const kind = classifyStoreErrno(error);
  if (!kind) return null;
  return storeRefusal({
    code: `store-${part}-${kind}`,
    subject: `${part} directory`,
    storePath,
    kind: kind === 'missing' ? 'unreadable' : kind,
  });
}
