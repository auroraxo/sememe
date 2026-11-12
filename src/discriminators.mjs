// Derive Anchor discriminators for IDLs that do not carry them.
//
// Why this exists: the on-chain IDL of a program is not always the IDL the
// program was built from. Legacy Anchor IDLs (the `anchor:idl` account form)
// and several deployed programs publish instruction NAMES and ARGUMENT LAYOUTS
// but no `discriminator` arrays. Measured on Kamino Lend
// (KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD), pulled on-chain 2026-10-29:
// 66 of 66 instructions and 5 of 5 events carry NO discriminator.
//
// Such an IDL is not a decoder input: without a discriminator there is no way
// to tell which instruction a payload is. It is also what the coverage
// measurement called "usable" — a schema that names instructions but cannot
// decode a single byte.
//
// The rule is Anchor's own, not a guess:
//   instruction: sha256("global:" + snake_case(name))[0..8]
//   event:       sha256("event:" + name)[0..8]
// (anchor-lang `discriminator` helper; the IDL generator uses the same one).
//
// The rule is verified, not assumed. `verifyDerivedDiscriminators` compares
// derived values against discriminators that ARE present in the IDL, so a
// program that stores them acts as the oracle. Measured on two independent
// real programs: Whirlpool 66/66 instructions, Jupiter AMM v6 19/19
// instructions and 6/6 events agree with the derivation.
//
// Nothing here overwrites a stored discriminator. A present value wins; the
// derivation only fills gaps. A conflict is an error, not a silent override.

import { createHash } from 'node:crypto';
import { isShankDiscriminant } from './shank.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest();

/** Anchor's snake_case of an instruction name (Rust fn name -> wire name). */
export function snakeCase(name) {
  if (typeof name !== 'string' || !name) throw new Error('instruction name must be a non-empty string');
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Anchor's global instruction discriminator for a name. */
export function globalDiscriminator(name) {
  return Array.from(sha256(`global:${snakeCase(name)}`).subarray(0, 8));
}

/** Anchor's event discriminator for an event name. */
export function eventDiscriminator(name) {
  if (typeof name !== 'string' || !name) throw new Error('event name must be a non-empty string');
  return Array.from(sha256(`event:${name}`).subarray(0, 8));
}

const isDiscriminator = (value) => Array.isArray(value)
  && value.length === 8
  && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);

/**
 * Any stored discriminator bytes, whatever length the source published. A
 * non-8-byte array is NOT a gap: it is a stored value under a different
 * dispatch scheme (measured: HADRo… publishes 38 one-byte instruction
 * discriminators — a real, chain-accepted wire table that Anchor's sighash
 * derivation cannot describe). The codec matches and re-encodes on the stored
 * prefix length, so preservation here is what makes those bytes decodable.
 */
const isStoredDiscriminator = (value) => Array.isArray(value)
  && value.length > 0
  && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);

/**
 * Compare derived discriminators against the ones an IDL already stores.
 *
 * @returns {{ checked: number, agree: number, conflicts: object[] }}
 */
export function verifyDerivedDiscriminators(idl) {
  const conflicts = [];
  let checked = 0;
  let agree = 0;
  for (const instruction of idl?.instructions ?? []) {
    if (!isDiscriminator(instruction?.discriminator)) continue;
    checked++;
    const derived = globalDiscriminator(instruction.name);
    const same = derived.every((byte, index) => byte === instruction.discriminator[index]);
    if (same) agree++;
    else conflicts.push({
      kind: 'instruction',
      name: instruction.name,
      stored: instruction.discriminator.slice(),
      derived,
    });
  }
  for (const event of idl?.events ?? []) {
    if (!isDiscriminator(event?.discriminator)) continue;
    checked++;
    const derived = eventDiscriminator(event.name);
    const same = derived.every((byte, index) => byte === event.discriminator[index]);
    if (same) agree++;
    else conflicts.push({
      kind: 'event',
      name: event.name,
      stored: event.discriminator.slice(),
      derived,
    });
  }
  return { checked, agree, conflicts };
}

/**
 * Return a copy of the IDL with discriminators filled in where they are
 * missing. Stored discriminators are never changed — at ANY length, not just
 * Anchor's 8 (pre-fix, a stored 1-byte array fell through to the sighash fill
 * and HADRo's whole wire table was silently replaced by bytes no payload
 * carries; measured 0/195 decoded pre-fix, 123/195 post-fix). Only an 8-byte
 * stored value makes a claim under Anchor's rule, so only those are checked
 * for a conflict; a stored value that disagrees with the derivation is
 * reported as a conflict.
 *
 * @returns {{ idl: object, filled: { instructions: number, events: number }, conflicts: object[] }}
 */
export function withDerivedDiscriminators(idl) {
  const copy = structuredClone(idl);
  let instructions = 0;
  let events = 0;
  const conflicts = [];
  for (const instruction of copy.instructions ?? []) {
    // A shank discriminant is a 1-byte variant selector, not a sighash. The
    // two schemes are independent: deriving Anchor's sighash for a shank
    // instruction yields a table that matches no real wire (measured: all 18
    // lighthouse instructions filled with bogus sighashes before this rule
    // existed). The stored discriminant is copied verbatim — it is a STORED
    // value under a different field name, so it is not counted as an Anchor
    // derivation and never checked against the sighash rule.
    if (isShankDiscriminant(instruction)) {
      instruction.discriminator = [instruction.discriminant.value];
      continue;
    }
    if (isStoredDiscriminator(instruction.discriminator)) {
      // STORED bytes under any scheme: copied verbatim, never filled. Only
      // Anchor's own 8-byte form is checked against his sighash rule — a
      // 1-byte stored value is a different dispatch scheme and makes no
      // sighash claim, so there is nothing to conflict.
      if (isDiscriminator(instruction.discriminator)) {
        const derived = globalDiscriminator(instruction.name);
        if (!derived.every((byte, index) => byte === instruction.discriminator[index])) {
          conflicts.push({ kind: 'instruction', name: instruction.name, stored: instruction.discriminator.slice(), derived });
        }
      }
      continue;
    }
    instruction.discriminator = globalDiscriminator(instruction.name);
    instructions++;
  }
  for (const event of copy.events ?? []) {
    if (isStoredDiscriminator(event.discriminator)) {
      // Same rule as instructions: stored bytes at any length are kept
      // verbatim; only the 8-byte Anchor form is conflict-checked.
      if (isDiscriminator(event.discriminator)) {
        const derived = eventDiscriminator(event.name);
        if (!derived.every((byte, index) => byte === event.discriminator[index])) {
          conflicts.push({ kind: 'event', name: event.name, stored: event.discriminator.slice(), derived });
        }
      }
      continue;
    }
    event.discriminator = eventDiscriminator(event.name);
    events++;
  }
  return { idl: copy, filled: { instructions, events }, conflicts };
}
