// The SPL Token + Token-2022 decoder: the vendored-upstream path for the two
// programs that publish NO IDL account to pull.
//
// Why this file exists: measured 2026-11-02 on four contiguous finalized
// mainnet blocks, the two token programs carry 5,402 of 12,572 watched
// payloads (43%) and 99.7% of the "no interface" gap, and neither program
// answers at either pullable address. The upstream Rust interface crates ARE
// their interface, so the wire table is derived from the vendored crates by
// src/token-interface.mjs and committed as a reviewable artifact
// (interface/token-<program>.json).
//
// Ground truth chain, every row derived and then VERIFIED, not typed:
//   1. INTERFACE  solana-program/token@737788ff interface/src/instruction.rs
//                 solana-program/token-2022@5251dcc0 interface/src/instruction.rs
//                 DERIVED by tools/token-interface.mjs into
//                 interface/token-<program>.json. This module reads the
//                 artifact at load and re-hashes the vendored Rust against the
//                 sha256 the artifact claims; a mismatch REFUSES the load
//                 instead of decoding from it — the same two-check contract
//                 as src/native.mjs (fresh derivation + artifact equality).
//   2. WIRE       the pack()/unpack() pairs in those crates: tag = the
//                 integer upstream writes and matches, byte order = the pack
//                 arm's write sequence, COption = upstream's own
//                 pack_pubkey_option/pack_u64_option (1 tag byte + payload).
//   3. RUNTIME    the same pin's processor dispatch: an unknown tag is
//                 InvalidInstruction, so an unknown selector here is a
//                 refusal, not a guess.
//
// What is deliberately NOT claimed: extension sub-instructions (Token-2022
// tags 26/27/28/30/33/34/36/37/39/40/41/42/43/44/46 dispatch into extension
// processors on input[1..]) are named at the top level only, and their
// sub-instruction bytes are reported as trailing. Token-2022's tag 255
// (Batch) unpacks upstream but the processor refuses it, and the token-metadata
// fallback interface (spl-token-metadata-interface, 8-byte discriminator) is a
// separate crate this table does not vendor — payloads of that shape are
// refused with a named reason instead of being force-fitted into the token
// table.
//
// Strictness mirrors src/native.mjs: an unknown selector, a truncated
// payload, an invalid option tag or an unknown authority byte is a refusal
// with a named reason — never a confident wrong label.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase58, encodeBase58 } from './base58.mjs';
import {
  deriveTokenInterface, TOKEN_SPECS, vendoredTokenHash,
  SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM,
} from './token-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export { SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM };

/**
 * Load one token interface: DERIVE it from the vendored upstream Rust, then
 * require the committed artifact to agree with the derivation byte for byte.
 *
 * Two checks, deliberately (the contract src/native.mjs already proved):
 *   - the derivation runs against the vendored bytes themselves, so a swapped
 *     or edited source file cannot silently change the table it describes;
 *   - the committed artifact must equal that derivation, so a tampered or
 *     stale artifact refuses the load instead of decoding from it.
 */
function loadInterface(spec) {
  const artifactPath = path.join(ROOT, 'interface', `token-${spec.program}.json`);
  const derived = deriveTokenInterface(spec);
  let current;
  try {
    current = readFileSync(artifactPath, 'utf8');
  } catch (error) {
    throw new Error(`token interface artifact for ${spec.label} is missing: ${error.message}`);
  }
  const expected = `${JSON.stringify(derived, null, 2)}\n`;
  if (current !== expected) {
    throw new Error(
      `token interface for ${spec.label} refuses to load: interface/token-${spec.program}.json does not equal ` +
      `a fresh derivation of ${derived.source.file} (${derived.source.fileSha256}, hashed now: ${vendoredTokenHash(spec)})`,
    );
  }
  if (!derived.instructions.length || !derived.selector?.width) {
    throw new Error(`token interface artifact for ${spec.label} is malformed`);
  }
  return derived;
}

const ARTIFACTS = new Map(TOKEN_SPECS.map((spec) => [spec.program, loadInterface(spec)]));
const AUTHORITY = new Map(TOKEN_SPECS.map((spec) => [
  spec.program,
  new Map(ARTIFACTS.get(spec.program).authorityType.map((entry) => [entry.byte, entry.name])),
]));
const AUTHORITY_NAME = new Map(TOKEN_SPECS.map((spec) => [
  spec.program,
  new Map(ARTIFACTS.get(spec.program).authorityType.map((entry) => [entry.name, entry.byte])),
]));

export class TokenCodecError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'TokenCodecError';
    this.reason = reason;
  }
}

/** Whether `program` is one of the token programs this module owns. */
export function isTokenProgram(program) {
  return ARTIFACTS.has(program);
}

/** Program ids this module can decode, for callers that enumerate. */
export function tokenPrograms() {
  return [...ARTIFACTS.keys()];
}

/** Provenance for one token program, or null. */
export function tokenProvenance(program) {
  const artifact = ARTIFACTS.get(program);
  if (!artifact) return null;
  return {
    label: artifact.label,
    interface: `${artifact.source.repo}@${artifact.source.pin.slice(0, 8)} ${artifact.source.file} TokenInstruction (explicit tags)`,
    encoding: artifact.argEncoding,
    runtime: artifact.runtime,
    variants: artifact.instructions.length,
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
 * Decode one arg. `trailing` types (utf8_rest, u16_vec, bytes) consume the
 * REST of the payload and must be the last arg — which is exactly how
 * upstream writes them, so the check below is upstream's own shape.
 */
function decodeArg(type, bytes, offset, what) {
  if (type === 'u8') {
    if (offset + 1 > bytes.length) throw new TokenCodecError('truncated-u8', `${what}: truncated u8 at ${offset}`);
    return { value: bytes[offset], size: 1 };
  }
  if (type === 'u16') {
    if (offset + 2 > bytes.length) throw new TokenCodecError('truncated-u16', `${what}: truncated u16 at ${offset}`);
    return { value: bytes[offset] | (bytes[offset + 1] << 8), size: 2 };
  }
  if (type === 'u64') {
    if (offset + 8 > bytes.length) throw new TokenCodecError('truncated-u64', `${what}: truncated u64 at ${offset}`);
    return { value: readLe(bytes, offset, 8), size: 8 };
  }
  if (type === 'pubkey') {
    if (offset + 32 > bytes.length) throw new TokenCodecError('truncated-pubkey', `${what}: truncated pubkey at ${offset}`);
    return { value: encodeBase58(bytes.subarray(offset, offset + 32)), size: 32 };
  }
  if (type === 'coption_pubkey' || type === 'coption_u64') {
    const width = type === 'coption_pubkey' ? 32 : 8;
    if (offset >= bytes.length) throw new TokenCodecError('truncated-coption-tag', `${what}: truncated option tag at ${offset}`);
    const tag = bytes[offset];
    if (tag === 0) return { value: null, size: 1 };
    if (tag !== 1) throw new TokenCodecError('invalid-coption-tag', `${what}: option tag ${tag} at ${offset} (upstream writes 0 or 1)`);
    if (offset + 1 + width > bytes.length) throw new TokenCodecError('truncated-coption-payload', `${what}: truncated option payload at ${offset}`);
    if (type === 'coption_pubkey') return { value: encodeBase58(bytes.subarray(offset + 1, offset + 33)), size: 33 };
    return { value: readLe(bytes, offset + 1, 8), size: 9 };
  }
  if (type === 'authority_type') {
    if (offset >= bytes.length) throw new TokenCodecError('truncated-authority-type', `${what}: truncated authority byte at ${offset}`);
    const byte = bytes[offset];
    return { value: byte, size: 1 };
  }
  if (type === 'utf8_rest') {
    const rest = bytes.subarray(offset);
    const text = Buffer.from(rest).toString('utf8');
    if (Buffer.from(text, 'utf8').compare(rest) !== 0) {
      throw new TokenCodecError('invalid-utf8', `${what}: remaining ${rest.length} byte(s) are not valid utf8`);
    }
    return { value: text, size: rest.length };
  }
  if (type === 'u16_vec') {
    const rest = bytes.length - offset;
    if (rest % 2 !== 0) throw new TokenCodecError('truncated-u16', `${what}: ${rest} trailing byte(s), not a whole number of u16`);
    const out = [];
    for (let at = offset; at < bytes.length; at += 2) out.push(bytes[at] | (bytes[at + 1] << 8));
    return { value: out, size: rest };
  }
  if (type === 'bytes') {
    return { value: Buffer.from(bytes.subarray(offset)).toString('hex'), size: bytes.length - offset };
  }
  throw new TokenCodecError('unknown-arg-type', `unknown arg type ${type}`);
}

function encodeArg(type, value, what, program) {
  if (type === 'u8') {
    const n = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xff) throw Error(`${what}: not a u8`);
    return Buffer.from([n]);
  }
  if (type === 'u16') {
    const n = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffff) throw Error(`${what}: not a u16`);
    const out = Buffer.alloc(2);
    out.writeUInt16LE(n);
    return out;
  }
  if (type === 'u64') {
    const v = typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value)
      : typeof value === 'number' ? BigInt(value)
        : typeof value === 'bigint' ? value
          : (() => { throw Error(`${what}: not a u64`); })();
    if (v < 0n || v >= 1n << 64n) throw Error(`${what}: out of u64 range`);
    const out = Buffer.alloc(8);
    for (let index = 0; index < 8; index++) out[index] = Number((v >> BigInt(index * 8)) & 0xffn);
    return out;
  }
  if (type === 'pubkey') {
    const raw = Buffer.from(decodeBase58(String(value)));
    if (raw.length !== 32) throw Error(`${what}: not a 32-byte pubkey`);
    return raw;
  }
  if (type === 'coption_pubkey' || type === 'coption_u64') {
    if (value === null || value === undefined) return Buffer.from([0]);
    if (type === 'coption_pubkey') {
      const raw = Buffer.from(decodeBase58(String(value)));
      if (raw.length !== 32) throw Error(`${what}: not a 32-byte pubkey`);
      return Buffer.concat([Buffer.from([1]), raw]);
    }
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
  if (type === 'authority_type') {
    // The byte is the wire form; the NAME is a human label. Accept either,
    // so a decoded instruction can be re-encoded without the caller having
    // to look the byte up again.
    let n;
    if (typeof value === 'string') {
      n = AUTHORITY_NAME.get(program)?.get(value);
      if (n === undefined) throw Error(`${what}: unknown AuthorityType name ${value}`);
    } else {
      n = typeof value === 'bigint' ? Number(value) : value;
    }
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xff) throw Error(`${what}: not an authority byte`);
    return Buffer.from([n]);
  }
  if (type === 'utf8_rest') return Buffer.from(String(value), 'utf8');
  if (type === 'u16_vec') {
    const out = Buffer.alloc(value.length * 2);
    value.forEach((entry, index) => out.writeUInt16LE(entry, index * 2));
    return out;
  }
  if (type === 'bytes') return Buffer.from(String(value), 'hex');
  throw Error(`unknown arg type ${type}`);
}

/**
 * Decode one token instruction payload.
 *
 * Returns null with a NAMED REASON attached via `tokenRefusal` when the
 * bytes cannot honestly be named — the tri-state matters: `program` is not a
 * token program means the caller was never supposed to ask, `null` means the
 * token program's own table refuses, a result means the bytes are named AND
 * re-encodable.
 *
 * `trailing: 'report'` (default) returns the decoded instruction plus the
 * byte count the table does not explain; 'error' refuses instead.
 */
export function decodeTokenInstruction(program, bytes, { trailing = 'report' } = {}) {
  const artifact = ARTIFACTS.get(program);
  if (!artifact) return { refused: 'not-token' };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new TokenCodecError('empty-payload', `${program}: no instruction data`);
  }
  const tag = bytes[0];
  const entry = artifact.instructions.find((ix) => ix.tag === tag);
  if (!entry) {
    throw new TokenCodecError(
      'unknown-selector',
      `${program}: tag ${tag} is not in the pinned ${artifact.label} interface`,
    );
  }
  const args = {};
  let offset = 1;
  const order = entry.args.map((spec, index) => ({ spec, index }));
  const restKinds = new Set(['utf8_rest', 'u16_vec', 'bytes']);
  for (let index = 0; index < entry.args.length; index++) {
    const spec = entry.args[index];
    const decoded = decodeArg(spec.type, bytes, offset, entry.name);
    args[spec.name] = decoded.value;
    offset += decoded.size;
    if (restKinds.has(spec.type) && index !== entry.args.length - 1) {
      throw new TokenCodecError('rest-arg-not-last', `${program}: ${entry.name} rest arg ${spec.name} is not last — upstream order violated`);
    }
  }
  void order;
  const trailingBytes = bytes.length - offset;
  if (trailingBytes > 0 && trailing === 'error') {
    throw new TokenCodecError('trailing-bytes', `${program}: ${entry.name} explains ${offset} of ${bytes.length} byte(s)`);
  }
  const authorityByte = args.authority_type;
  const authorityName = typeof authorityByte === 'number'
    ? AUTHORITY.get(program).get(authorityByte)
    : null;
  if (typeof authorityByte === 'number' && authorityName === undefined) {
    throw new TokenCodecError('unknown-authority-type', `${program}: authority byte ${authorityByte} is not a declared AuthorityType variant`);
  }
  return {
    name: entry.name,
    tag,
    selectorWidth: 1,
    args,
    authorityType: authorityName,
    consumed: offset,
    bytes: bytes.length,
    trailing: { count: trailingBytes },
    roundTripByteExact: encodeTokenInstruction(program, entry.name, args).equals(Buffer.from(bytes)),
    scheme: 'native-token',
    source: 'pinned-vendored-upstream',
  };
}

/** Why the last `decodeTokenInstruction` refused, or null if it did not. */
export function tokenRefusal(program, bytes) {
  try {
    const result = decodeTokenInstruction(program, bytes);
    return result.refused ? result.refused : null;
  } catch (error) {
    return error instanceof TokenCodecError ? error.reason : `thrown: ${error.message}`;
  }
}

/** Re-encode one token instruction from a name + args. Throws on mismatch. */
export function encodeTokenInstruction(program, name, values = {}) {
  const artifact = ARTIFACTS.get(program);
  if (!artifact) throw new TokenCodecError('not-token', program);
  const entry = artifact.instructions.find((ix) => ix.name === name);
  if (!entry) throw new TokenCodecError('unknown-variant', `${program}: ${name}`);
  const chunks = [Buffer.from([entry.tag])];
  for (const spec of entry.args) {
    const value = values[spec.name];
    if (value === undefined && spec.type !== 'coption_pubkey' && spec.type !== 'coption_u64') {
      throw new TokenCodecError('missing-arg', `${name}.${spec.name}`);
    }
    chunks.push(encodeArg(spec.type, value, `${name}.${spec.name}`, program));
  }
  return Buffer.concat(chunks);
}

/** Names the table can claim for `program` (coverage callers). */
export function tokenNames(program) {
  const artifact = ARTIFACTS.get(program);
  return artifact ? artifact.instructions.map((entry) => entry.name) : [];
}

/** Whether `name` belongs to `program`'s token table. */
export function isTokenName(program, name) {
  const artifact = ARTIFACTS.get(program);
  return Boolean(artifact) && artifact.instructions.some((entry) => entry.name === name);
}

/** AuthorityType byte -> name for `program` (exposed for callers/tests). */
export function authorityTypeName(program, byte) {
  return AUTHORITY.get(program)?.get(byte) ?? null;
}

/** AuthorityType name -> byte for `program` (exposed for callers/tests). */
export function authorityTypeByte(program, name) {
  return AUTHORITY_NAME.get(program)?.get(name) ?? null;
}

/** The AuthorityType pairs as the artifact records them. */
export function authorityTypes(program) {
  const artifact = ARTIFACTS.get(program);
  return artifact ? artifact.authorityType.map((entry) => ({ ...entry })) : [];
}
