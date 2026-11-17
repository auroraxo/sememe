// src/store-answer.mjs — the ONE place the product's store ANSWERS are minted.
//
// An answer is not a refusal: nothing is broken and nothing can be repaired —
// the store simply is not in the state the command needs. Two answers exist:
//
//   no-sememe-store   the store directory does not exist yet
//                     ("no sememe store at <dir>: run \"sememe pull\" first")
//   no-stored-idl     the store exists but holds no receipt for that program
//                     ("no stored IDL for program <id> in <dir>")
//
// THE DEFECT this module closed (measured 2026-11-17, this host, pre-fix tree
// dc2317d, and reproduced against the PUBLISHED sememe@0.4.35 installed into
// an empty app): the library MINTED both codes (src/store-read.mjs) but the
// CLI prints `code` only together with `fix` — so both answers reached the
// operator as bare prose with no branchable name:
//
//   sememe decode <program> <payload> --store <missing>
//     -> {"error":"no sememe store at …: run \"sememe pull\" first"} exit 1
//
// and the two `sememe lock` / `sememe verify` call sites did not even mint
// the code: they threw the sentence as a plain Error. A pipeline could not
// tell "the store was never pulled" (acquire) from "the work failed"
// (repair) without reading English.
//
// THE CONTRACT: an answer carries
//   * a PRODUCT CODE — no-sememe-store / no-stored-idl, branchable state;
//   * `answer: true` — its own semantics: ACQUIRE, do not repair. This is
//     what separates an answer from a refusal at the machine channel
//     WITHOUT parsing prose, and it is why `answer: true` never rides on a
//     refusal and `fix` never rides on an answer;
//   * NO `fix` — there is nothing to repair; the verbatim sentence already
//     says what to run;
//   * its VERBATIM sentence — quoted by bin/sememe.mjs, the README and
//     several tests, byte-for-byte.
// The channel does not move: exit 1, stderr, JSON — exactly where these
// answers already answered before they were named.
//
// Measured and pinned by research/answer-voice-2026-11-17.json (two trees,
// byte-identical probe) and test/answer-voice.test.mjs; the mutation ladder
// tools/mutation-ladder-answer-voice.sh proves the gate can go red.

/** The answer codes this module mints — the CLI's answer channel prints an
 *  error as an ANSWER only for these, keyed on `answer: true`. */
export const ANSWER_CODES = ['no-sememe-store', 'no-stored-idl'];

const ANSWER_CODE_SET = new Set(ANSWER_CODES);

/** True for the product's own answer codes; every refusal class must answer
 *  false for both (isStoreDamageCode, isStoreInputCode, isLockCode do —
 *  pinned in their own tests). */
export function isAnswerCode(code) {
  return ANSWER_CODE_SET.has(code);
}

function mintAnswer(code, message) {
  const error = Error(message);
  error.code = code;
  error.answer = true;
  // Deliberately NO `fix`: an answer is closed by acquisition ("run sememe
  // pull"), never by a repair. A fix here would make the CLI print it as a
  // refusal — an answer dressed as a fault.
  return error;
}

/** The store directory does not exist yet: acquire it, do not repair it. */
export function noStoreAnswer(storeDir) {
  return mintAnswer('no-sememe-store',
    `no sememe store at ${storeDir}: run "sememe pull" first`);
}

/** The store exists and simply holds no receipt for this program: an honest
 *  acquisition gap, never damage and never a fault. */
export function noStoredIdlAnswer(program, storeDir) {
  return mintAnswer('no-stored-idl',
    `no stored IDL for program ${program} in ${storeDir}`);
}
