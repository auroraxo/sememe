// The SPL Token-Metadata decoder: the Token-2022 FALLBACK path.
//
// Why this file exists: Token-2022's processor (program/src/processor.rs at
// the pinned revision) tries the 1-byte PodTokenInstruction selector first
// and, when that fails, falls through to `TokenMetadataInstruction::unpack`.
// A metadata instruction therefore carries an EIGHT-BYTE discriminator and
// never matches the token table's 1-byte tags. Before this module, sememe
// refused those payloads as `unknown-selector` — a true statement about the
// token table and a false statement about the program.
//
// The wire table is derived from the vendored upstream crate by
// src/token-metadata-interface.mjs and committed as a reviewable artifact
// (interface/token-metadata.json), and it is re-derived AT LOAD: the module
// refuses to decode unless the committed artifact equals a fresh derivation
// of the vendored bytes. That is the same two-check contract as
// src/token.mjs and src/native.mjs:
//
//   1. the derivation runs against the VENDORED BYTES themselves, so a
//      swapped or edited source file cannot silently change the table it
//      describes;
//   2. the committed artifact must EQUAL that derivation, so a tampered or
//      stale artifact refuses the load instead of decoding from it.
//
// Strictness mirrors upstream EXACTLY, and this was verified against the
// upstream crate itself rather than assumed: upstream's `unpack` calls
// `try_from_slice`, which REFUSES a payload with unexplained trailing
// bytes. A decoder that named such a payload would claim the chain accepts
// bytes the chain rejects, so trailing bytes are a refusal here too.
//
// What is deliberately NOT claimed: the account-side layout (the TokenMetadata
// TLV account) is a different structure and is not decoded here; only the
// instruction data is.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase58, encodeBase58 } from './base58.mjs';
import {
  deriveTokenMetadataInterface, TOKEN_METADATA_PIN,
} from './token-metadata-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const TOKEN_METADATA_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Load the token-metadata interface: DERIVE it from the vendored upstream
 * crate, then require the committed artifact to agree with the derivation
 * byte for byte.
 */
function loadInterface() {
  const artifactPath = path.join(ROOT, 'interface', 'token-metadata.json');
  const derived = deriveTokenMetadataInterface();
  let current;
  try {
    current = readFileSync(artifactPath, 'utf8');
  } catch (error) {
    throw new Error(`token-metadata interface artifact is missing: ${error.message}`);
  }
  const expected = `${JSON.stringify(derived, null, 2)}\n`;
  if (current !== expected) {
    throw new Error(
      'token-metadata interface refuses to load: interface/token-metadata.json does not equal ' +
      `a fresh derivation of ${derived.source.file} (${derived.source.fileSha256})`,
    );
  }
  if (!derived.instructions.length || derived.selector?.width !== 8) {
    throw new Error('token-metadata interface artifact is malformed');
  }
  return derived;
}

const ARTIFACT = loadInterface();
const BY_DISCRIMINATOR = new Map(ARTIFACT.instructions.map((ix) => [ix.discriminator, ix]));
const BY_NAME = new Map(ARTIFACT.instructions.map((ix) => [ix.name, ix]));
const FIELD_BY_TAG = new Map(ARTIFACT.fieldEnum.map((entry) => [entry.tag, entry]));
const FIELD_BY_NAME = new Map(ARTIFACT.fieldEnum.map((entry) => [entry.name, entry]));

export class TokenMetadataCodecError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'TokenMetadataCodecError';
    this.reason = reason;
  }
}

/** The names this table can claim. */
export function tokenMetadataNames() {
  return ARTIFACT.instructions.map((entry) => entry.name);
}

/** Provenance for the token-metadata table. */
export function tokenMetadataProvenance() {
  return {
    label: ARTIFACT.label,
    interface: `${ARTIFACT.source.crate}@${ARTIFACT.source.version} (${ARTIFACT.source.pin.slice(0, 8)}) ${ARTIFACT.source.file}`,
    encoding: ARTIFACT.argEncoding,
    runtime: ARTIFACT.runtime,
    variants: ARTIFACT.instructions.length,
    selectorWidth: ARTIFACT.selector.width,
  };
}

function readLe(bytes, offset, size) {
  let value = 0n;
  for (let index = size - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

function u64ToNumber(value, what) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error(`${what} exceeds Number.MAX_SAFE_INTEGER`);
  return Number(value);
}

/**
 * Decode one arg. Returns { value, size }.
 *
 * `borsh_enum` needs the table (to know whether a variant carries a nested
 * payload), so the FIELD enum is passed in.
 */
function decodeArg(spec, bytes, offset, what) {
  if (spec.type === 'borsh_string') {
    if (offset + 4 > bytes.length) throw new TokenMetadataCodecError('truncated-string-length', `${what}: truncated u32 length at ${offset}`);
    const length = readLe(bytes, offset, 4);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TokenMetadataCodecError('string-too-long', `${what}: length ${length} is not a usable length`);
    }
    const size = Number(length);
    if (offset + 4 + size > bytes.length) {
      throw new TokenMetadataCodecError('truncated-string', `${what}: string claims ${size} byte(s), ${bytes.length - offset - 4} left`);
    }
    const raw = bytes.subarray(offset + 4, offset + 4 + size);
    const text = Buffer.from(raw).toString('utf8');
    if (Buffer.from(text, 'utf8').compare(raw) !== 0) {
      throw new TokenMetadataCodecError('invalid-utf8', `${what}: string bytes are not valid utf8`);
    }
    return { value: text, size: 4 + size };
  }
  if (spec.type === 'borsh_bool') {
    if (offset + 1 > bytes.length) throw new TokenMetadataCodecError('truncated-bool', `${what}: truncated bool at ${offset}`);
    const byte = bytes[offset];
    if (byte !== 0 && byte !== 1) {
      throw new TokenMetadataCodecError('invalid-bool', `${what}: bool byte ${byte} (borsh writes 0 or 1)`);
    }
    return { value: byte === 1, size: 1 };
  }
  if (spec.type === 'borsh_enum') {
    if (offset + 1 > bytes.length) throw new TokenMetadataCodecError('truncated-enum-tag', `${what}: truncated enum tag at ${offset}`);
    const tag = bytes[offset];
    const entry = FIELD_BY_TAG.get(tag);
    if (!entry) throw new TokenMetadataCodecError('unknown-enum-variant', `${what}: enum tag ${tag} is not a declared variant`);
    if (!entry.payload) return { value: { variant: entry.name, tag }, size: 1 };
    // The variant carries a nested payload: a Borsh string.
    const nested = decodeArg({ type: entry.payload }, bytes, offset + 1, `${what}.${entry.name}`);
    return { value: { variant: entry.name, tag, value: nested.value }, size: 1 + nested.size };
  }
  if (spec.type === 'maybe_null_address') {
    if (offset + 32 > bytes.length) throw new TokenMetadataCodecError('truncated-address', `${what}: truncated address at ${offset}`);
    const raw = bytes.subarray(offset, offset + 32);
    const isNone = raw.every((byte) => byte === 0);
    return {
      value: isNone ? null : encodeBase58(raw),
      size: 32,
    };
  }
  if (spec.type === 'borsh_option_u64') {
    if (offset >= bytes.length) throw new TokenMetadataCodecError('truncated-option-tag', `${what}: truncated option tag at ${offset}`);
    const tag = bytes[offset];
    if (tag === 0) return { value: null, size: 1 };
    if (tag !== 1) throw new TokenMetadataCodecError('invalid-option-tag', `${what}: option tag ${tag} (borsh writes 0 or 1)`);
    if (offset + 9 > bytes.length) throw new TokenMetadataCodecError('truncated-option-payload', `${what}: truncated option payload at ${offset}`);
    return { value: readLe(bytes, offset + 1, 8), size: 9 };
  }
  throw new TokenMetadataCodecError('unknown-arg-type', `unknown arg type ${spec.type}`);
}

function encodeArg(spec, value, what) {
  if (spec.type === 'borsh_string') {
    const raw = Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(raw.length, 0);
    return Buffer.concat([length, raw]);
  }
  if (spec.type === 'borsh_bool') {
    if (typeof value !== 'boolean') throw Error(`${what}: not a boolean`);
    return Buffer.from([value ? 1 : 0]);
  }
  if (spec.type === 'borsh_enum') {
    if (value === null || typeof value !== 'object') throw Error(`${what}: not a field value`);
    // The variant may be given by NAME (the human label upstream uses) or by
    // its byte tag; both must resolve to the same upstream variant, and a
    // name this table does not know is an error rather than a guess.
    let tag;
    if (typeof value.tag === 'number') {
      tag = value.tag;
    } else if (typeof value.variant === 'string') {
      tag = FIELD_BY_NAME.get(value.variant)?.tag;
      if (tag === undefined) throw Error(`${what}: unknown Field variant ${value.variant}`);
    } else {
      throw Error(`${what}: a field needs a variant name or tag`);
    }
    const entry = FIELD_BY_TAG.get(tag);
    if (!entry) throw Error(`${what}: unknown Field tag ${tag}`);
    if (!entry.payload) return Buffer.from([tag]);
    return Buffer.concat([Buffer.from([tag]), encodeArg({ type: entry.payload }, value.value, `${what}.${entry.name}`)]);
  }
  if (spec.type === 'maybe_null_address') {
    if (value === null || value === undefined) return Buffer.alloc(32);
    const raw = Buffer.from(decodeBase58(String(value)));
    if (raw.length !== 32) throw Error(`${what}: not a 32-byte address`);
    return raw;
  }
  if (spec.type === 'borsh_option_u64') {
    if (value === null || value === undefined) return Buffer.from([0]);
    const v = typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value)
      : typeof value === 'number' ? BigInt(value)
        : typeof value === 'bigint' ? value
          : (() => { throw Error(`${what}: not a u64`); })();
    if (v < 0n || v >= 1n << 64n) throw Error(`${what}: out of u64 range`);
    const out = Buffer.alloc(9);
    out[0] = 1;
    for (let index = 0; index < 8; index++) out[index + 1] = Number((v >> BigInt(index * 8)) & 0xffn);
    return out;
  }
  throw Error(`unknown arg type ${spec.type}`);
}

/**
 * Decode one token-metadata instruction payload.
 *
 * Returns null with a NAMED REASON attached via `tokenMetadataRefusal` when
 * the bytes cannot honestly be named.
 *
 * Trailing bytes are ALWAYS a refusal (`trailing-bytes`), because upstream's
 * own `unpack` refuses them: verified against the upstream crate, where a
 * trailing byte is a BorshIoError. The caller's `trailing` option cannot
 * relax this — a payload with trailing bytes is one the chain REJECTS.
 */
export function decodeTokenMetadataInstruction(program, bytes) {
  if (program !== TOKEN_METADATA_PROGRAM) return { refused: 'not-token-metadata' };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new TokenMetadataCodecError('empty-payload', `${program}: no instruction data`);
  }
  if (bytes.length < 8) {
    throw new TokenMetadataCodecError('truncated-discriminator', `${program}: ${bytes.length} byte(s) cannot carry an 8-byte discriminator`);
  }
  const discriminator = Buffer.from(bytes.subarray(0, 8)).toString('hex');
  const entry = BY_DISCRIMINATOR.get(discriminator);
  if (!entry) {
    throw new TokenMetadataCodecError(
      'unknown-selector',
      `${program}: 8-byte discriminator ${discriminator} is not in the pinned ${ARTIFACT.label} table`,
    );
  }
  const args = {};
  let offset = 8;
  for (const spec of entry.args) {
    const decoded = decodeArg(spec, bytes, offset, `${entry.name}.${spec.name}`);
    args[spec.name] = decoded.value;
    offset += decoded.size;
  }
  const trailingBytes = bytes.length - offset;
  if (trailingBytes > 0) {
    // Upstream's `unpack` calls `try_from_slice`, which REFUSES a payload
    // with unexplained trailing bytes — verified against the upstream crate,
    // where a trailing byte is a BorshIoError. The `trailing` option is
    // therefore NOT honoured here: reporting a trailing payload as decoded
    // would claim the chain accepts bytes the chain rejects.
    throw new TokenMetadataCodecError(
      'trailing-bytes',
      `${program}: ${entry.name} explains ${offset} of ${bytes.length} byte(s); upstream's unpack refuses trailing bytes`,
    );
  }
  return {
    name: entry.name,
    discriminator,
    selectorWidth: 8,
    args,
    consumed: offset,
    bytes: bytes.length,
    trailing: { count: trailingBytes },
    roundTripByteExact: encodeTokenMetadataInstruction(entry.name, args).equals(Buffer.from(bytes)),
    scheme: ARTIFACT.scheme,
    source: 'pinned-vendored-upstream',
  };
}

/** Why the last `decodeTokenMetadataInstruction` refused, or null. */
export function tokenMetadataRefusal(program, bytes) {
  try {
    const result = decodeTokenMetadataInstruction(program, bytes);
    return result.refused ? result.refused : null;
  } catch (error) {
    return error instanceof TokenMetadataCodecError ? error.reason : `thrown: ${error.message}`;
  }
}

/** Re-encode one token-metadata instruction from a name + args. */
export function encodeTokenMetadataInstruction(name, values = {}) {
  const entry = BY_NAME.get(name);
  if (!entry) throw new TokenMetadataCodecError('unknown-variant', name);
  const chunks = [Buffer.from(entry.discriminator, 'hex')];
  for (const spec of entry.args) {
    const value = values[spec.name];
    if (value === undefined && spec.type !== 'borsh_option_u64' && spec.type !== 'maybe_null_address') {
      throw new TokenMetadataCodecError('missing-arg', `${name}.${spec.name}`);
    }
    chunks.push(encodeArg(spec, value, `${name}.${spec.name}`));
  }
  return Buffer.concat(chunks);
}

/** The discriminators this table claims, for coverage callers. */
export function tokenMetadataDiscriminators() {
  return ARTIFACT.instructions.map((entry) => entry.discriminator);
}
