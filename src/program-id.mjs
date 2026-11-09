// Is this string a program id? A DEPENDENCY-FREE check.
//
// WHY THIS FILE EXISTS
//
// `sememe conform --only <program-id>` filters a transaction's instructions
// to one program. A filter that cannot match anything must be REFUSED by
// name, not silently honoured (measured 2026-11-09, published v0.4.12): a
// filter that named a program the transaction never invokes produced a
// report with zero instructions, zero disagreements and exit 0 — a green
// CI gate over nothing.
//
// The first half of that defect is a filter that is not even a program id:
// `--only not-a-program-id` can never match, and it produced the same green
// report. Refusing it needs a definition of "program id", and the definition
// must not drag in the acquisition peer: the decode core is imported by
// consumers with NO npm dependencies at all (pinned by test/deps.test.mjs),
// and a CLI refusal must not be the thing that makes them install
// @solana/web3.js.
//
// A Solana program id is 32 raw bytes in base58. That is exactly what
// `src/base58.mjs` already encodes and decodes with no dependencies, so
// "is this a program id" is answered here as:
//
//   1. it decodes as base58 at all;
//   2. it decodes to exactly 32 bytes;
//   3. it RE-ENCODES to the same string (canonical form — a base58 string
//      with leading zero bytes has several spellings, and a filter that
//      names a program in a non-canonical spelling would silently match
//      nothing while looking perfectly valid).
//
// The same check is used by the pull path through src/peer.mjs's PublicKey;
// this file is the dependency-free twin for the paths that must not load the
// peer. The two agree on what a canonical program id is — one round-trip
// through base58 is the same arithmetic PublicKey performs.
import { decodeBase58, encodeBase58 } from './base58.mjs';

/** A Solana program id is 32 bytes. */
export const PROGRAM_ID_BYTES = 32;

/**
 * Is `value` a canonical base58 program id?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isProgramId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  let bytes;
  try {
    bytes = decodeBase58(trimmed);
  } catch {
    return false;
  }
  if (bytes.length !== PROGRAM_ID_BYTES) return false;
  try {
    return encodeBase58(bytes) === trimmed;
  } catch {
    return false;
  }
}

/**
 * The refusal text for a filter that is not a program id.
 *
 * The message names the FLAG and the VALUE, because a caller who typed the
 * wrong thing must be able to see what was read: "unknown value" without the
 * value is a verdict, not a repair.
 */
export function notAProgramIdMessage(flag, value) {
  return `sememe conform: ${flag} ${JSON.stringify(value)} is not a program id — `
    + 'it names 32 bytes in base58, and can never match an instruction';
}
