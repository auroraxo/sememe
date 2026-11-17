// src/lock-voice.mjs — ONE classification place for the LOCK SURFACE: the
// refusals the lock itself produces.
//
// WHY THIS FILE EXISTS (measured 2026-11-17, this host, this tree, and
// reproduced against the PUBLISHED sememe@0.4.34 installed into an empty
// app):
//
// Three classifier families already speak the product's voice: the file the
// CALLER names (src/file-input.mjs), the store directory the CALLER names
// (src/store-input.mjs) and the damage the reader FINDS ITSELF
// (src/store-damage.mjs). A refusal there carries a code a script can
// branch on, a repair the operator can run, and a channel that says whether
// the work ran.
//
// The LOCK surface did not. It is the CI gate the README tells a stranger
// to run after checkout, and it answered in prose only:
//
//   sememe verify --store store --lock bad.lock
//     -> {"error":"sememe lock file bad.lock is not JSON (lock-v1-parse)"}
//        exit 1
//
//   sememe verify --store store --lock drift.lock
//     -> {"error":"store does not match sememe.lock (1 drifted, 0 missing,
//        0 unverified, 0 relabelled, 0 unbound) — drifted: <program> pinned
//        sha256:… vs store sha256:…"}
//        exit 1
//
// Three faults, the same three the other classifiers ended:
//
//   1. NO BRANCHABLE NAME. The lock document's reason sits INSIDE the prose
//      ("(lock-v1-parse)"), so `error.code` is undefined and a script must
//      read English to branch. The gate failure has NO reason at all, so a
//      pipeline cannot tell "the store drifted" from "a receipt is damaged"
//      without parsing the sentence.
//   2. NO REPAIR. Not one of these refusals names what the operator can
//      run, while the whole point of the store-damage classifier is that
//      "the bytes are not the ones the receipt pins" comes with "re-run
//      sememe pull".
//   3. THE WRONG SUBJECT FOR THE BIGGEST ONE. The gate failure is the
//      product's own CI gate failing — the answer a pipeline reads to decide
//      what broke — and it reported counts in prose only.
//
// THE CONTRACT:
//
//   Every refusal here carries a code and a repair, and NO errno:
//
//     lock-v1-parse       the lock file holds no JSON document
//     lock-v1-shape       the document is not a v1 lock (programs map etc.)
//     lock-v1-fingerprint a pinned fingerprint is not sha256:<64 hex>
//     lock-v1-origin      a pinned origin is not a string
//     lock-pins-nothing   nothing is pinned, so the gate could never detect
//                         drift (a lock over zero answers, or a store that
//                         holds no receipt)
//     lock-mismatch       the store does not match the lock: the gate
//                         failed. The violation kinds travel with it, per
//                         program, so no prose has to be parsed.
//
//   The codes are the SAME strings the lock already named in its prose
//   ("lock-v1-parse", "lock-pins-nothing", …) — they are not renamed, only
//   lifted out of the sentence and into the channel where a script can read
//   them. The sentences other tools quote (the README, docs/measured-history
//   .md, several tests) stay byte-for-byte as they were.
//
// THE CHANNEL (this is the one thing that must NOT change):
//
//   Every refusal here keeps the WORK channel (exit 1): the file WAS read
//   and the work ran — the bytes were wrong. A lock path that does not
//   exist is a different class entirely (the caller named it wrong) and
//   keeps the usage/IO channel (exit 2) in src/file-input.mjs. The split
//   between "you pointed me at nothing" and "the work failed" is the
//   contract src/file-input.mjs established; this file does not move it.
//
// WHAT IS NOT A REFUSAL HERE:
//
//   A store that does not exist ("no sememe store at …: run \"sememe pull\"
//   first") and a program the store simply lacks ("no stored IDL for
//   program …") are ANSWERS, not refusals: the store-damage pin asserts
//   they must NOT acquire a code or a repair
//   (test/store-damage-voice.test.mjs, C7). This file does not touch
//   them.

/** The lock codes this module mints. A Set, not a regex: the lock's codes
 *  are a closed vocabulary, and a name that is not in it is somebody
 *  else's code. */
const LOCK_CODES = new Set([
  'lock-v1-parse',
  'lock-v1-shape',
  'lock-v1-fingerprint',
  'lock-v1-origin',
  'lock-pins-nothing',
  'lock-mismatch',
]);

/** The repairs, one per kind. Deliberately not phrased like the kernel's
 *  own strerror text: a refusal and its repair travel on the same channel,
 *  and a repair that reads like the kernel must not be counted as one. */
const REPAIRS = {
  'lock-v1-parse':
    'the lock file must contain a JSON document — re-create it with "sememe lock" over the store it should pin',
  'lock-v1-shape':
    'the lock file must be a v1 lock document — re-create it with "sememe lock" over the store it should pin',
  'lock-v1-fingerprint':
    'every pinned fingerprint must be sha256:<64 hex> — re-create the lock with "sememe lock"',
  'lock-v1-origin':
    'a pinned origin must be a string — re-create the lock with "sememe lock"',
  'lock-pins-nothing':
    're-create the lock with "sememe lock" over a store that holds at least one receipt',
  'lock-mismatch':
    're-pull the programs the report names, or re-run "sememe lock" if the store holds the newer answers',
};

/** The per-kind repairs of the GATE failure. Each kind breaks in a
 *  different way and is fixed in a different way, so the gate refusal
 *  names the repair of the kind it actually found — the same rule the
 *  store-damage classifier follows for a receipt against an object. */
const MISMATCH_REPAIRS = {
  drifted: 'the store answers with different bytes than the lock pins — re-pull those programs, or re-run "sememe lock" if the store holds the newer answers',
  missing: 'the store holds no receipt for a pinned program — re-run "sememe pull <program-id>" for it',
  unverified: 'an object in the store fails the reader\'s own re-hash check — re-run "sememe pull <program-id>" for it',
  relabelled: 'a declared origin changed after the fact — restore the original receipt, or re-run "sememe lock" to pin the current one',
  unbound: 'the store declares an origin the lock does not pin — re-run "sememe lock" to bind it',
};

/** True for a code this module minted. Used by the CLI and by tests to tell
 *  a NAMED lock refusal from an ordinary error, without matching on message
 *  text. It deliberately does NOT match the caller-named path classes
 *  (`lock-file-*`, `store-*`): those are a different class. */
export function isLockCode(code) {
  return typeof code === 'string' && LOCK_CODES.has(code);
}

/** The repair for the gate failure, given the kinds it found. The kinds
 *  are the ones the report carries, so the repair can never name a kind
 *  that did not happen. */
export function mismatchRepair(kinds) {
  const named = [...new Set(kinds)].filter((kind) => MISMATCH_REPAIRS[kind]);
  if (!named.length) return REPAIRS['lock-mismatch'];
  return named.map((kind) => MISMATCH_REPAIRS[kind]).join('; ');
}

/** Build a named refusal for the lock surface.
 *
 *  `message` is the product's own sentence, used VERBATIM — the sentences
 *  are quoted by the README, docs/measured-history.md, the lock's report
 *  and several tests, and they stay byte-for-byte as they were. The code is
 *  appended in parentheses ONLY when the sentence does not already name it
 *  (the lock's own sentences name it, at the end or in the middle), so the
 *  prose and the channel can never disagree about which reason this is.
 *
 *  `violations` carries the gate's per-kind program lists, so a pipeline
 *  can branch on "drifted" against "a receipt is damaged" without reading
 *  the sentence.
 *
 *  `exitCode` is 1 for every face here: the work ran and found the wrong
 *  bytes. A lock path the CALLER named wrong keeps exit 2 — see
 *  src/file-input.mjs. */
export function lockRefusal({ code, message, fix, violations = null, exitCode = 1 }) {
  if (!isLockCode(code)) {
    throw Error(`lockRefusal was asked for a code it does not mint: ${code}`);
  }
  const text = String(message ?? '');
  const sentence = text.includes(`(${code})`) ? text : `${text} (${code})`;
  const repair = fix ?? REPAIRS[code] ?? REPAIRS['lock-mismatch'];
  const error = new Error(sentence);
  error.code = code;
  error.fix = `fix: ${repair}`;
  error.exitCode = exitCode;
  if (violations) error.violations = violations;
  return error;
}

/** The gate's violation payload: the programs of each kind, so a caller can
 *  branch per kind without parsing the sentence. */
export function violationsOf(report) {
  return {
    drifted: report.drifted.map((d) => d.program),
    missing: [...report.missing],
    unverified: report.unverified.map((u) => (u.scope === 'extra'
      ? `${u.program} (extra: the lock does not pin it)`
      : u.program)),
    relabelled: report.relabelled.map((r) => (r.scope === 'extra' ? `${r.program} (extra)` : r.program)),
    unbound: report.unbound.map((r) => r.program),
  };
}
