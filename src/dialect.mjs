// IDL dialect detection — the gate that turns a codec CRASH into a NAMED
// REFUSAL for interfaces sememe does not speak.
//
// Why this exists: not every program publishes an Anchor or shank IDL.
// Measured 2026-11-12 on DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z
// (first-party interface: cryptodiablo/diabloarb, sdk/diabloarb-executor.
// idl.json @ f5005ac4 — raw little-endian, "NOT Anchor/Borsh" by its own
// description):
//   - `types` is a DICT keyed by name ({Hop:…, Base:…, Route:…}), not the
//     Anchor array — and context() iterated `idl.types ?? []`, so every one
//     of the program's 102 sampled payloads died with the unnamed
//     `TypeError: object is not iterable (cannot read property
//     Symbol(Symbol.iterator))` instead of a refusal. Measured pre-fix:
//     crash-voice 102/102, named-voice 0.
//   - instructions dispatch on a 1-byte `tag` with fields under `data`
//     (no `args`, no `discriminator`, no `discriminant`). withDerived-
//     Discriminators filled all 4 with Anchor sighashes that match no wire
//     (measured: filled {instructions: 4, events: 0}).
//   - the program declares itself under `program_id` (not `address` /
//     `metadata.address`), so adopt() and readVerified() — which only check
//     `idl.address` — adopted the diabloarb file happily under
//     So11111111111111111111111111111111111111112, a DIFFERENT program
//     (measured: adopt succeeded; this is the mislabelling face).
//
// The rules, applied at every store/codec boundary so the reason is identical
// everywhere:
//   - the members the codec ITERATES must be arrays. A mapping dialect
//     (instructions/types/events/accounts as a dict) is refused by name.
//   - a name-only legacy IDL (no discriminator, no discriminant, no stored
//     bytes) stays SUPPORTED: `sememe conform` uses those account lists for
//     layout checking, and the decode path already refuses such a payload by
//     name ("unknown instruction discriminator") at the exact 0-decoded
//     boundary the Kamino measurement pins. Naming that shape "unsupported"
//     would change attested behavior without a measured wire failure.
//   - a tag-dispatch instruction (fields under `data`, no `args`) is refused:
//     the dialect names no wire layout the codec can read, and Anchor sighash
//     derivation must not be applied to it (a derived table matches no wire).
//   - oracle fixtures (marinade/meteora/openbook anchor-ts-discriminators.json)
//     are captured artifacts, never passed to the codec as IDLs — the guard
//     cannot false-positive on them because nothing feeds them here.
//
// Nothing here changes decoding bytes for a supported interface: anchor and
// shank take the same paths as before, byte for byte.

import { isShankDiscriminant } from './shank.mjs';

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

const isByteArray = (value) => Array.isArray(value) && value.length > 0
  && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);

/** The one machine-readable name of this refusal, used by every boundary. */
export const UNSUPPORTED_DIALECT_CODE = 'unsupported-idl-dialect';

const MAPPING_HINT = ' (mapping dialects like diabloarb tag-dispatch are not decodable)';

/**
 * True when `instruction` names a tag-dispatch dialect entry: fields under
 * `data` and/or an explicit `tag`, with no anchor `args` array. A plain
 * name-only legacy entry ({ name }) is NOT tagged — it stays a supported
 * (if selector-less) anchor shape whose account lists drive conform.
 */
export function isTagDispatchInstruction(instruction) {
  return isPlainObject(instruction) && !Array.isArray(instruction.args)
    && (instruction.data !== undefined || instruction.tag !== undefined);
}

/**
 * The named refusal reason for an IDL the codec cannot read, or null when
 * the shape is fine. `unsupportedIdlReason` is the ONE definition of the
 * reason text so every entry point (codec context, discriminator fill,
 * union, decode, adopt, store read) states the same refusal.
 */
export function unsupportedIdlReason(idl) {
  if (!isPlainObject(idl)) return 'unsupported IDL dialect: not an IDL object';
  // Mapping dialects put the members the codec iterates into a dict
  // (measured: diabloarb `types` as {Hop, Base, Route}).
  for (const key of ['instructions', 'types', 'events', 'accounts']) {
    if (idl[key] !== undefined && !Array.isArray(idl[key])) {
      return `unsupported IDL dialect: ${key} must be an array, got ${typeof idl[key]}${MAPPING_HINT}`;
    }
  }
  if (!Array.isArray(idl.instructions)) return 'unsupported IDL dialect: no instructions array';
  for (const instruction of idl.instructions) {
    if (!isPlainObject(instruction)) {
      return 'unsupported IDL dialect: instruction entries must be objects';
    }
    // A tag-dispatch instruction carries its fields under `data` and has no
    // `args`: the dialect names no field list the codec could read, and the
    // Anchor sighash derivation must not be applied to it.
    if (isTagDispatchInstruction(instruction)) {
      return `unsupported IDL dialect: instruction ${JSON.stringify(instruction.name ?? null)}`
        + ` carries no anchor args (tag/data dispatch)${MAPPING_HINT}`;
    }
  }
  for (const event of idl.events ?? []) {
    if (!isPlainObject(event)) return 'unsupported IDL dialect: event entries must be objects';
  }
  return null;
}

/**
 * Which dispatch dialect an IDL claims — the pure-shape question the
 * measurement pins. `name-only` is a supported dialect (a legacy Anchor IDL
 * that publishes names and layouts but no selectors): the decode path
 * refuses those payloads by name, and the conform path uses their account
 * lists.
 */
export function idlDialect(idl) {
  if (unsupportedIdlReason(idl)) return 'unsupported';
  const instructions = idl.instructions;
  if (instructions.length === 0) return 'anchor';
  for (const instruction of instructions) {
    if (isShankDiscriminant(instruction)) return 'shank';
    if (isByteArray(instruction?.discriminator)) return 'anchor';
  }
  return 'name-only';
}

/**
 * The program an IDL declares for itself, under any of the field names
 * measured in the wild: `address` (Anchor on-chain), `metadata.address`
 * (shank), `program_id` (diabloarb and other raw dialects).
 */
export function declaredProgram(idl) {
  const candidates = [idl?.address, idl?.metadata?.address, idl?.program_id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Throw the caller's error type when the IDL is not structurally decodable.
 * One line at each of the boundaries, so the guard cannot drift between them.
 */
export function assertIdlShape(idl, makeError) {
  const reason = unsupportedIdlReason(idl);
  if (!reason) return;
  const error = makeError(reason);
  if (error && typeof error === 'object') {
    error.code = UNSUPPORTED_DIALECT_CODE;
  }
  throw error;
}
