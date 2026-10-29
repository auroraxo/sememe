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
 * missing. Stored discriminators are never changed; a stored value that
 * disagrees with the derivation is reported as a conflict.
 *
 * @returns {{ idl: object, filled: { instructions: number, events: number }, conflicts: object[] }}
 */
export function withDerivedDiscriminators(idl) {
  const copy = structuredClone(idl);
  let instructions = 0;
  let events = 0;
  const conflicts = [];
  for (const instruction of copy.instructions ?? []) {
    if (isDiscriminator(instruction.discriminator)) {
      const derived = globalDiscriminator(instruction.name);
      if (!derived.every((byte, index) => byte === instruction.discriminator[index])) {
        conflicts.push({ kind: 'instruction', name: instruction.name, stored: instruction.discriminator.slice(), derived });
      }
      continue;
    }
    instruction.discriminator = globalDiscriminator(instruction.name);
    instructions++;
  }
  for (const event of copy.events ?? []) {
    if (isDiscriminator(event.discriminator)) {
      const derived = eventDiscriminator(event.name);
      if (!derived.every((byte, index) => byte === event.discriminator[index])) {
        conflicts.push({ kind: 'event', name: event.name, stored: event.discriminator.slice(), derived });
      }
      continue;
    }
    event.discriminator = eventDiscriminator(event.name);
    events++;
  }
  return { idl: copy, filled: { instructions, events }, conflicts };
}
