// src/file-input.mjs — ONE classification place for the files a caller points
// at.
//
// WHY THIS FILE EXISTS (measured 2026-11-16, this host, the PUBLISHED
// sememe@0.4.30 installed into an empty app):
//
// A caller names a FILE — the interface to adopt, the transaction to check,
// the lock to verify against, the file to write the lock to. When that path
// is wrong, the product answered with the KERNEL's error, verbatim:
//
//   sememe conform /tmp/nope.json --store ./store
//     -> {"error":"ENOENT: no such file or directory, open '/tmp/nope.json'"}
//        exit 1
//
// Three things are wrong with that answer, and each of them is measurable:
//
//   1. NO NAME. The operator gets a syscall's prose, not the product's. There
//      is no code a script can branch on and no repair to act on. The store
//      reader has refused damage by NAME for weeks ("no sememe store at X:
//      run \"sememe pull\" first"), the lock names its own reasons
//      (lock-v1-parse, lock-v1-shape, lock-v1-fingerprint), and the CLI names
//      a typo'd flag with the closest supported flag. The file inputs were
//      the one place left speaking raw kernel.
//   2. NO SUBJECT. The `conform` face above does not even say WHICH argument
//      was bad: a missing transaction file and a missing --lock produced the
//      same shape of sentence.
//   3. THE WRONG CHANNEL. A path the caller mistyped is not "the work
//      failed". It shares exit 1 with a real refusal (a drifted store, a
//      tampered receipt) — so a CI script cannot tell "you pointed me at
//      nothing" from "your store drifted", and the usage/IO channel the
//      product already reserves (exit 2) went unused.
//
// The rule this file implements is the one the repository already applies
// everywhere else — from src/cli-surface.mjs ("an unrecognized input is
// REFUSED BY NAME, never tolerated") to src/store-read.mjs ("the message is
// unchanged: it is quoted by bin/sememe.mjs, the README and several tests"):
// a refusal names its reason, and the raw errno is INPUT, never output.
//
// THE CONTRACT:
//
//   missing     the path does not exist
//   not_a_file  the path exists but is a directory (or any other non-file)
//   unreadable  the file exists and is a file, but cannot be read
//
//   Each becomes a named code (label-file-kind), a sentence that names the
//   path, and a REPAIR line — what the caller has to change. The errno never
//   reaches the operator; the errno CODE is not even echoed, because a code
//   is still the kernel's vocabulary.
//
//   IO failures are USAGE failures: nothing was read, nothing was written,
//   no work ran. They take the usage/IO channel (exit 2), the channel the
//   product already reserves for an invocation that cannot be what the
//   caller meant. A file that EXISTS but holds the wrong CONTENT is not an
//   IO failure — it is the work failing, and it keeps exit 1.
//
// The labels are the commands whose file it is, so the code names the
// subject without a sentence: `adopt-file-missing`, `conform-file-not-a-file`,
// `lock-file-unreadable`.

import { readFile, writeFile } from 'node:fs/promises';

const REASONS = {
  missing: 'does not exist',
  not_a_file: 'is not a file',
  unreadable: 'cannot be read',
  not_json: 'is not JSON',
};

const REPAIRS = {
  missing: 'pass the path of a file that exists',
  // Deliberately not phrased like the kernel's own strerror text: the repair
  // travels on the same channel as the refusal, and a leak detector that
  // scans the whole answer must not have to special-case our own wording.
  not_a_file: 'pass the path of a regular file',
  unreadable: 'make the file readable (chmod) and pass its path',
  not_json: 'the file must contain a JSON document',
};

/** The errno classes this file knows by name. A failure outside this set is
 *  still a refusal — it is classified `unreadable` rather than passed
 *  through, because an unnamed kernel error is exactly what this file
 *  exists to end. */
function classifyErrno(error) {
  const code = error?.code;
  if (code === 'ENOENT') return 'missing';
  if (code === 'EISDIR' || code === 'ENOTDIR') return 'not_a_file';
  return 'unreadable';
}

/** True for a code this module minted. Used by the CLI to tell a NAMED
 *  refusal from an ordinary error, without matching on message text. */
export function isFileInputCode(code) {
  return typeof code === 'string' && /^[a-z]+-file-[a-z_-]+$/.test(code);
}

/** Build a named refusal. `exitCode` is the channel the refusal travels on:
 *  2 for the IO faces (nothing ran), 1 for a content face (the work ran and
 *  found the wrong bytes). */
export function fileInputRefusal({ label, subject, filePath, kind, exitCode = 2 }) {
  const code = `${label}-file-${kind}`;
  const reason = REASONS[kind] ?? 'cannot be read';
  const repair = REPAIRS[kind] ?? REPAIRS.unreadable;
  const error = new Error(`sememe ${label}: the ${subject} ${filePath} ${reason} (${code})`);
  error.code = code;
  error.fix = `fix: ${repair}`;
  error.exitCode = exitCode;
  error.filePath = filePath;
  return error;
}

/** Read a file the caller named. Throws a named refusal instead of letting
 *  the kernel's error escape. */
export async function readInputFile(filePath, { label, subject }) {
  try {
    return await readFile(filePath);
  } catch (error) {
    throw fileInputRefusal({ label, subject, filePath, kind: classifyErrno(error) });
  }
}

/** Read a file the caller named AND expect it to be JSON.
 *
 *  A file that is there but holds something else is NOT an IO failure: the
 *  work ran and the bytes are wrong, so this stays on the work channel
 *  (exit 1) — but it is still NAMED, and it still says which file. The
 *  parser's own prose is kept as the detail, because it says where the
 *  parse stopped; the reason itself is named. */
export async function readInputJson(filePath, { label, subject }) {
  const raw = await readInputFile(filePath, { label, subject });
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    const refusal = fileInputRefusal({
      label, subject, filePath, kind: 'not_json', exitCode: 1,
    });
    refusal.message = `sememe ${label}: the ${subject} ${filePath} is not JSON (${refusal.code}) — ${String(error?.message ?? error).slice(0, 120)}`;
    refusal.fix = 'fix: the file must contain a JSON document';
    throw refusal;
  }
}

/** Write a file the caller named. The output path is a path the caller chose,
 *  so it gets the same treatment as the input paths: a directory in place of
 *  a file is named, not reported as a raw errno. */
export async function writeInputFile(filePath, bytes, { label, subject }) {
  try {
    await writeFile(filePath, bytes);
  } catch (error) {
    const kind = classifyErrno(error);
    throw fileInputRefusal({ label, subject, filePath, kind });
  }
}
