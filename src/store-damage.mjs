// src/store-damage.mjs — ONE classification place for the DAMAGE the store
// reader finds in a store it WAS pointed at.
//
// WHY THIS FILE EXISTS (measured 2026-11-17, this host, this tree, and
// reproduced against the PUBLISHED sememe@0.4.32):
//
// The caller-named PATH was closed twice (src/file-input.mjs on 2026-11-16,
// src/store-input.mjs on 2026-11-17): a wrong path now gets a named code, a
// subject, a repair and the usage/IO channel. What stayed behind is the
// INPUT the product finds ITSELF: the store path was right, and the store
// turned out to be damaged. The reader refused it — but in the kernel's
// voice, with no code and no repair, and with the operator's home path in
// the message:
//
//   sememe decode <program> <payload> --store <store>
//     -> {"error":"store receipt <name>.json is unreadable: EACCES: permission
//         denied, open '/home/<user>/…/receipts/<name>.json'"}
//        exit 1
//
//   sememe decode <program> <payload> --store <store>
//     -> {"error":"store object <hash>.json is unreadable: EISDIR: illegal
//         operation on a directory, read"}
//        exit 1
//
// Three measurable faults, the same three the path classifiers already
// ended for caller-named paths:
//
//   1. NO NAME. The operator gets a syscall's prose. There is no code a
//      script can branch on and no repair to act on — while the SAME
//      product names its own refusals everywhere else ("no sememe store at
//      X", "lock-v1-parse", "adopt-file-not_json").
//   2. NO SUBJECT. The refusal does not say WHICH of the store's two kinds
//      of file is damaged — the receipt (the claim) or the object (the
//      bytes). Those are different faults with different repairs: a damaged
//      receipt is re-pulled, a damaged object is restored from its
//      fingerprint.
//   3. THE WRONG VOCABULARY. "EACCES: permission denied" and "EISDIR:
//      illegal operation on a directory" are the KERNEL's errno strings.
//      The product's own rule, applied everywhere else in this repo, is
//      that the errno is INPUT, never output — and a refusal that quotes
//      strerror is talking in the kernel's voice, not the product's.
//
// THE CHANNEL (this is the one thing that must NOT change):
//
//   These refusals are DAMAGE, not a mistyped path. The store path the
//   caller named WAS usable — the product found a broken receipt or object
//   in it. The work ran and found the wrong bytes, so the refusal keeps
//   the WORK channel (exit 1), exactly like the reader's other damage
//   refusals ("object and receipt disagree, refusing to decode"). The path
//   mistakes keep the usage/IO channel (exit 2) — that split is the
//   contract src/store-input.mjs established, and this file does not move
//   it.
//
// THE CONTRACT:
//
//   Every refusal here carries a code and a repair, and NO errno:
//
//     store-receipt-not_a_file      a receipt path cannot be used as a file
//     store-receipt-unreadable      a receipt cannot be read
//     store-receipt-missing         a receipt listed in the directory is
//                                   gone when it is read
//     store-receipt-not_json        a receipt holds no JSON document
//     store-receipt-foreign_program a receipt claims a different program
//     store-receipt-malformed       a receipt carries no usable fingerprint
//     store-object-not_a_file       an object path cannot be used as a file
//     store-object-unreadable       an object cannot be read
//     store-object-missing          a receipt claims an object the store
//                                   does not hold
//     store-object-not_json         an object holds no JSON document
//     store-object-not_an_idl       a stored object has no instruction list
//     store-object-program_mismatch an object declares another program
//     store-object-rehash_mismatch  an object no longer re-hashes to the
//                                   fingerprint its receipt claims
//
//   The wording is deliberately NOT strerror's own ("cannot be read" rather
//   than "permission denied"), for the reason the other two classifiers
//   documented: a refusal and its repair travel on the same channel a leak
//   detector scans, and a repair that reads like the kernel must not be
//   counted as one.
//
//   The path in a message is STORE-RELATIVE ("receipts/<name>"), never
//   absolute: the store lives in the operator's home directory, and a
//   refusal that quotes it prints that home into a CI log.
//
// WHY A SEPARATE FILE AND NOT A REUSE OF src/store-input.mjs:
//
// src/store-input.mjs classifies a PATH THE CALLER NAMED (wrong store,
// wrong receipts/ directory): nothing ran, exit 2, "you pointed me at
// nothing". This file classifies DAMAGE THE PRODUCT FOUND (a broken
// receipt, a broken object): the work ran, exit 1, "the thing you pointed
// at is broken". Reusing one classifier for both would collapse "your path
// is wrong" and "your store is damaged" — the exact collapse this repo
// keeps refusing to ship.
//
// THE MESSAGES THAT MUST NOT MOVE:
//
//   The reader's sentences are quoted by the README,
//   docs/measured-history.md, the lock's report and several tests:
//   "… is not a receipt for …", "claims object <hash> but the store object
//   is missing", "… is not JSON …", "… re-hashes to sha256:<hash> …
//   disagree, refusing to decode". They stay at the FRONT of the message —
//   this module APPENDS the code in parentheses — so a reader, a report
//   slice and a test regex that matched the old sentence still match it.

const REASONS = {
  not_a_file: 'cannot be used as a file',
  unreadable: 'cannot be read',
  missing: 'is gone',
  not_json: 'does not hold a JSON document',
  foreign_program: 'claims a different program',
  malformed: 'carries no usable fingerprint',
  not_an_idl: 'holds no instruction list',
  program_mismatch: 'declares a different program than its receipt binds',
  rehash_mismatch: 'no longer matches the fingerprint its receipt claims',
};

const REPAIRS = {
  not_a_file: 'remove the file that stands where a receipt or object belongs, then re-run "sememe pull <program-id>"',
  unreadable: 'make the file readable (chmod) and re-run "sememe pull <program-id>"',
  missing: 're-run "sememe pull <program-id>" so the store holds the receipt and its object again',
  not_json: 're-run "sememe pull <program-id>"; a receipt or object that is not JSON was never written by sememe',
  foreign_program: 're-run "sememe pull <program-id>" so the store holds a receipt for this program again',
  malformed: 're-run "sememe pull <program-id>"; a receipt without a usable fingerprint cannot be verified',
  not_an_idl: 're-run "sememe pull <program-id>"; an object without an instruction list is not an interface',
  program_mismatch: 're-run "sememe pull <program-id>"; the stored object describes another program',
  rehash_mismatch: 're-run "sememe pull <program-id>"; the object in the store is not the one the receipt pins',
};

/** The errno classes this file knows by name. A failure outside the set is
 *  classified `unreadable` rather than passed through: an unnamed kernel
 *  error is exactly what this file exists to end. `null` means "this is
 *  not a filesystem error at all" (a JSON parse error, a product refusal)
 *  and must keep its own voice. */
export function classifyDamageErrno(error) {
  const code = error?.code;
  if (typeof code !== 'string') return null;
  if (code === 'ENOENT') return 'missing';
  if (code === 'EISDIR' || code === 'ENOTDIR') return 'not_a_file';
  return 'unreadable';
}

/** True for a code this module minted. Used by the CLI and by tests to tell
 *  a NAMED store-damage refusal from an ordinary error, without matching on
 *  message text. It deliberately does NOT match src/store-input.mjs codes
 *  (`store-receipts-*`, `store-objects-*`, `store-*`): those are the
 *  caller-named PATH class, these are the DAMAGE class. */
export function isStoreDamageCode(code) {
  return typeof code === 'string' && /^store-(?:receipt|object)-[a-z_]+$/.test(code);
}

/** Build a named refusal for damage the reader found.
 *
 *  `message` is the product's own sentence, kept at the FRONT — the codes
 *  other tools quote must still match at the position they always matched
 *  (the lock slices this message; a prefix would push the evidence out of
 *  the slice). `kind` picks the repair. `path` is STORE-RELATIVE, so no
 *  host path ever reaches a log.
 *
 *  `exitCode` is 1 for every face here: the work ran and found damage. A
 *  path the caller named wrong keeps exit 2 — see src/store-input.mjs. */
export function storeDamageRefusal({ code, kind, message, path: relativePath = null, detail = '' }) {
  const repair = REPAIRS[kind] ?? REPAIRS.unreadable;
  const reason = REASONS[kind] ?? REASONS.unreadable;
  const head = message || `sememe store: the entry ${relativePath ?? ''} ${reason}`;
  const error = new Error(detail ? `${head} (${code}) — ${detail}` : `${head} (${code})`);
  error.code = code;
  error.fix = `fix: ${repair}`;
  error.exitCode = 1;
  error.reason = reason;
  error.storePath = relativePath;
  return error;
}
