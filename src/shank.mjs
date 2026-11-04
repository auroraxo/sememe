// Shank / Kinobi dialect support for IDL-driven decoding.
//
// Why this exists: not every published IDL is an Anchor IDL. Shank-generated
// IDLs (and the Codama/Kinobi clients built from them) describe the SAME Borsh
// field layouts but a DIFFERENT dispatch and length dialect:
//   - instructions carry `discriminant: { type: "u8", value: N }` — a single
//     variant-order byte — instead of an 8-byte Anchor sighash;
//   - enums are Borsh 1-byte variant indexes (sememe already decoded these);
//   - the lighthouse family encodes array/string lengths as LEB128
//     (`CompactU64`, `CompactBytes`, `*Assertions` — custom types the IDL
//     references but does not define; the wire form is pinned upstream in
//     lighthouse_common::CompactU64 / LEB128Vec and mirrored by the program's
//     own generated JS client, clients/js/src/hooked.ts at Jac0xb/lighthouse).
//
// Measured ground truth (2026-11-04): all 42 Lighthouse payloads in the
// 156-fixture foreign sweep (step-ingestooor @001cf39) dispatch on their shank
// discriminant byte (0x06 = AssertAccountInfoMulti, 0x0a =
// AssertTokenAccountMulti — both present in the first-party IDL) and decode +
// re-encode byte-exactly under this dialect.
//
// Rules, all falsifiable:
// - A shank discriminant is NEVER overwritten by Anchor's sighash derivation:
//   the two schemes are independent; deriving one from the other produces a
//   table that matches no real wire. (The pre-fix behavior filled all 18
//   lighthouse instructions with bogus sighashes — measured wrong.)
// - The hooked LEB128 types engage only for an IDL in the shank dialect and
//   only for a name the IDL does not define itself; a name defined in the
//   IDL's own `types` always wins, and an unknown undefined name still
//   refuses (`unknown defined type`). Nothing is guessed from shape.

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** True when `instruction` carries a shank 1-byte discriminant. */
export function isShankDiscriminant(instruction) {
  const raw = instruction?.discriminant;
  return isPlainObject(raw) && raw.type === 'u8'
    && Number.isInteger(raw.value) && raw.value >= 0 && raw.value <= 255;
}

/** The 1-byte discriminator as a Buffer, or null when not shank-shaped. */
export function shankDiscriminatorBytes(instruction) {
  return isShankDiscriminant(instruction) ? Buffer.from([instruction.discriminant.value]) : null;
}

/**
 * The hooked LEB128 types, pinned from lighthouse_common (Jac0xb/lighthouse,
 * programs/lighthouse/src/instruction.rs: `CompactU64`, `LEB128Vec<T>`) and
 * the program's generated clients/js/src/hooked.ts:
 *   - scalar: unsigned LEB128 (7-bit groups, little-endian, max 10 bytes)
 *   - bytes:  unsigned LEB128 length prefix + that many raw bytes
 *   - vec:    unsigned LEB128 length prefix + that many Borsh elements
 * The `*Assertions` element types stay in the IDL's own `types`; only the
 * length dialect is hooked.
 */
export const SHANK_LEB128_TYPES = new Map([
  ['CompactU64', { kind: 'scalar' }],
  ['CompactBytes', { kind: 'bytes' }],
  ['AccountInfoAssertions', { kind: 'vec', element: 'AccountInfoAssertion' }],
  ['AccountDataAssertions', { kind: 'vec', element: 'AccountDataAssertion' }],
  ['MintAccountAssertions', { kind: 'vec', element: 'MintAccountAssertion' }],
  ['TokenAccountAssertions', { kind: 'vec', element: 'TokenAccountAssertion' }],
  ['StakeAccountAssertions', { kind: 'vec', element: 'StakeAccountAssertion' }],
  ['UpgradeableLoaderStateAssertions', { kind: 'vec', element: 'UpgradeableLoaderStateAssertion' }],
]);

/**
 * Whether an IDL is in the shank dialect: declared via metadata.origin, or
 * shaped so (at least one instruction carries a 1-byte discriminant).
 */
export function isShankIdl(idl) {
  if (idl?.metadata?.origin === 'shank') return true;
  return (idl?.instructions ?? []).some((instruction) => isShankDiscriminant(instruction));
}
