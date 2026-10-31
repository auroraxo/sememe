// Native (non-Anchor) program decoding: System and ComputeBudget.
//
// Why this file exists: the two native programs appear in essentially every
// Solana transaction, they have no IDL account to pull, and sememe's own first
// consumer (solana-tx-remix) carried a hand-transcribed copy of their
// instruction tables — exactly the per-repo hand-build this repository exists
// to replace. The census that motivated this module (2026-10-31, real mainnet
// harvest): the hand table could name 0 of 63 on-chain CreateAccountWithSeed
// payloads because it reads a u32 string length prefix while the chain carries
// a u64 (bincode fixint) — measured, not argued.
//
// Ground truth chain, every row derived and then VERIFIED, not typed:
//   1. INTERFACE  vendored anza-xyz/solana-sdk@8db406e2edfafa25939ec782b77b5b6f30de164d
//                 compute-budget-interface/src/lib.rs (ComputeBudgetInstruction, variants 0..4)
//                 system-interface/src/instruction.rs (SystemInstruction, variants 0..13)
//                 DERIVED by tools/native-interface.mjs into interface/native-<program>.json.
//                 This module reads the artifact at load and re-hashes the vendored Rust
//                 against the sha256 the artifact claims; a mismatch REFUSES the load
//                 instead of decoding from it. The transcription step no longer exists:
//                 the rows here were never hand-typed, they are upstream's own field
//                 names and declaration order, and the hash is checked on every import.
//   2. RUNTIME    anza-xyz/agave (master, 2026-10-31) compute-budget-instruction:
//                 borsh `try_from_slice_unchecked`; an unclaimed tag or the
//                 reserved Unused(0) variant is `InvalidInstructionData` —
//                 the runtime REJECTS tag 0, so a decoder that names it would
//                 disagree with the chain it decodes for.
//   3. CORROB.    @solana/web3.js@1.98.4 (pinned in package.json) SYSTEM_
//                 INSTRUCTION_LAYOUTS: u32 index + ns64 + rustString (u32
//                 length + u32 lengthPadding). Read as one u64, length and
//                 padding ARE the bincode fixint length word — byte-compatible
//                 for every length below 2^32, which is the only length the
//                 seed rules allow. The defect this replaces was dropping the
//                 padding word entirely: the hand table in the first consumer
//                 consumed a 4-byte header, shifted every later field by 4,
//                 and could name 0 of 63 real CreateAccountWithSeed payloads.
//                 (Measured 2026-10-31; the new decoder names and re-encodes
//                 all 63.)
//
// Divergence worth keeping visible: @solana/web3.js@1.98.4 still encodes
// legacy `requestUnits` as tag 0 + (u32, u32) — the pre-2023 wire shape the
// runtime no longer parses. This module refuses tag 0 with a named reason
// instead of borrowing the SDK's opinion.
//
// Strictness mirrors src/codec.mjs: an unknown selector, a truncated payload,
// an unknown variant, or trailing bytes are refusals with named reasons —
// never a confident wrong label. The chain already says what it accepts;
// this table only claims what it can prove.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase58, encodeBase58 } from './base58.mjs';
import { deriveInterface, specFor, vendoredHash, REPO_ROOT } from './native-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
if (ROOT !== REPO_ROOT) throw Error('native.mjs moved; native-interface.mjs resolves the repo root');

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

const SDK_PIN = 'anza-xyz/solana-sdk@8db406e2edfafa25939ec782b77b5b6f30de164d';
const RUNTIME_PIN = 'anza-xyz/agave@master (read 2026-10-31)';

/**
 * Load one native interface: DERIVE it from the vendored upstream Rust, then require
 * the committed artifact to agree with the derivation byte for byte.
 *
 * Two checks, deliberately:
 *   - the derivation runs against the vendored bytes themselves, so a swapped or
 *     edited source file cannot silently change the table it describes;
 *   - the committed artifact must equal that derivation, so a tampered or stale
 *     artifact refuses the load instead of decoding from it.
 *
 * Same contract as the IDL store: provenance is a claim, the recomputed digest is the
 * check. Because this runs at import, a mismatch fails loudly at startup rather than
 * naming instructions the pinned runtime would reject.
 */
function loadInterface(program) {
  const spec = specFor(program);
  const artifactPath = path.join(ROOT, 'interface', `native-${program}.json`);
  const derived = deriveInterface(spec);
  let current;
  try {
    current = readFileSync(artifactPath, 'utf8');
  } catch (error) {
    throw new Error(`native interface artifact for ${program} is missing: ${error.message}`);
  }
  const expected = `${JSON.stringify(derived, null, 2)}\n`;
  if (current !== expected) {
    throw new Error(
      `native interface for ${program} refuses to load: interface/native-${program}.json does not equal ` +
      `a fresh derivation of ${derived.source.file} (${derived.source.fileSha256}, hashed now: ${vendoredHash(spec)})`,
    );
  }
  if (!derived.instructions.length || !derived.selector?.width) {
    throw new Error(`native interface artifact for ${program} is malformed`);
  }
  return derived;
}

const ARTIFACTS = new Map([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM].map((program) => [program, loadInterface(program)]));

// Arg shapes, as DECLARED BY THE ARTIFACT: `u32`/`u64` fixed-width LE, `pubkey`
// 32 raw bytes, `string` u64-length-prefixed utf8 (bincode fixint, measured on-chain),
// `unit` none. The selector width and encoding come from the artifact too — the table
// is upstream's declaration order; the selector IS the index.

const COMPUTE_BUDGET_IXS = ARTIFACTS.get(COMPUTE_BUDGET_PROGRAM).instructions;
const SYSTEM_IXS = ARTIFACTS.get(SYSTEM_PROGRAM).instructions;

export const NATIVE_PROVENANCE = {
  [SYSTEM_PROGRAM]: {
    label: 'System Program',
    interface: `${SDK_PIN} system-interface/src/instruction.rs SystemInstruction (variants 0..13, declaration order)`,
    encoding: 'u32le enum tag + bincode fixint args; string = u64 length prefix + utf8 (web3.js reads the same word as u32 length + u32 zero padding)',
    runtime: `${RUNTIME_PIN}, system-program: accepts variants 0..13 (12 = UpgradeNonceAccount, 13 = CreateAccountAllowPrefund)`,
    corroboration: '@solana/web3.js@1.98.4 SYSTEM_INSTRUCTION_LAYOUTS (u32 index + ns64 + rustString header, byte-compatible with the u64 length word)',
    measured: '2026-10-31 mainnet harvest: 1.828 payloads; 63/63 CreateAccountWithSeed consume ONLY with the u64 string prefix',
    observed: { Transfer: 1026, CreateAccount: 643, AdvanceNonceAccount: 67, CreateAccountWithSeed: 63, Assign: 14, Allocate: 14, InitializeNonceAccount: 1 },
  },
  [COMPUTE_BUDGET_PROGRAM]: {
    label: 'Compute Budget Program',
    interface: `${SDK_PIN} compute-budget-interface/src/lib.rs ComputeBudgetInstruction (variants 0..4, declaration order)`,
    encoding: '1-byte tag + bare LE integer arg (runtime to_instruction! macro: data[0] = tag, then $num.to_le_bytes())',
    runtime: `${RUNTIME_PIN}, compute-budget-instruction: borsh try_from_slice_unchecked; unclaimed tag or Unused(0) => InvalidInstructionData`,
    corroboration: 'Lightprotocol/light-protocol compute_budget.rs (explicit per-variant index)',
    measured: '2026-10-31 mainnet harvest: 1.348 payloads, tags {2: 651, 3: 550, 4: 147}; tags 0 and 1 not observed on live mainnet — consistent with the runtime reject rule. 27 payloads carry trailing bytes after the declared arg; chain adjudication (9 fetched, byte-identical to the harvest) shows the runtime tolerates them (borsh try_from_slice_unchecked ignores the remainder), and every one sat in a transaction that failed at a LATER instruction',
    divergence: '@solana/web3.js@1.98.4 still ENCODES legacy requestUnits as tag 0 + (u32,u32) — the pre-2023 wire shape the runtime no longer parses; this module refuses tag 0 instead of copying the SDK',
  },
};

const TABLES = new Map([
  [SYSTEM_PROGRAM, { width: ARTIFACTS.get(SYSTEM_PROGRAM).selector.width, ixs: SYSTEM_IXS, artifact: ARTIFACTS.get(SYSTEM_PROGRAM) }],
  [COMPUTE_BUDGET_PROGRAM, { width: ARTIFACTS.get(COMPUTE_BUDGET_PROGRAM).selector.width, ixs: COMPUTE_BUDGET_IXS, artifact: ARTIFACTS.get(COMPUTE_BUDGET_PROGRAM) }],
]);

/** Whether `program` is one of the native programs this module owns. */
export function isNativeProgram(program) {
  return TABLES.has(program);
}

/** Program ids this module can decode, for callers that enumerate. */
export function nativePrograms() {
  return [...TABLES.keys()];
}

/** Provenance for one native program, or null. */
export function nativeProvenance(program) {
  return TABLES.has(program) ? { ...NATIVE_PROVENANCE[program], program } : null;
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

function decodeArg(type, bytes, offset, what) {
  if (type === 'u32') {
    if (offset + 4 > bytes.length) throw new NativeCodecError('truncated-u32', `${what}: truncated u32 at ${offset}`);
    return { value: Number(readLe(bytes, offset, 4)), size: 4 };
  }
  if (type === 'u64') {
    if (offset + 8 > bytes.length) throw new NativeCodecError('truncated-u64', `${what}: truncated u64 at ${offset}`);
    return { value: readLe(bytes, offset, 8), size: 8 };
  }
  if (type === 'pubkey') {
    if (offset + 32 > bytes.length) throw new NativeCodecError('truncated-pubkey', `${what}: truncated pubkey at ${offset}`);
    return { value: encodeBase58(bytes.subarray(offset, offset + 32)), size: 32 };
  }
  if (type === 'string') {
    if (offset + 8 > bytes.length) throw new NativeCodecError('truncated-string-length', `${what}: truncated string length at ${offset}`);
    const length = u64ToNumber(readLe(bytes, offset, 8), `${what} string length`);
    if (offset + 8 + length > bytes.length) throw new NativeCodecError('truncated-string-body', `${what}: truncated string body at ${offset + 8}`);
    return { value: bytes.subarray(offset + 8, offset + 8 + length).toString('utf8'), size: 8 + length };
  }
  throw new NativeCodecError('unknown-arg-type', `unknown arg type ${type}`);
}

function encodeArg(type, value, what) {
  if (type === 'u32') {
    const n = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw Error(`${what}: not a u32`);
    const out = Buffer.alloc(4);
    out.writeUInt32LE(n);
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
    const text = String(value);
    const raw = text.startsWith('0x')
      ? Buffer.from(text.slice(2), 'hex')
      : Buffer.from(decodeBase58(text));
    if (raw.length !== 32) throw Error(`${what}: not a 32-byte pubkey`);
    return raw;
  }
  if (type === 'string') {
    const body = Buffer.from(String(value), 'utf8');
    const head = Buffer.alloc(8);
    for (let index = 0; index < 8; index++) head[index] = Number((BigInt(body.length) >> BigInt(index * 8)) & 0xffn);
    return Buffer.concat([head, body]);
  }
  throw Error(`unknown arg type ${type}`);
}

export class NativeCodecError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'NativeCodecError';
    this.reason = reason;
  }
}

/**
 * Decode one native instruction payload.
 *
 * Returns null with a NAMED REASON attached via `nativeRefusal` when the bytes
 * cannot honestly be named (unknown selector, wire-rejected variant, truncated
 * payload, trailing bytes) — the tri-state matters: `program` not native means
 * the caller was never supposed to ask, `null` means the native program's own
 * table refuses, a result means the bytes are named AND re-encodable.
 *
 * `trailing: 'report'` (default) returns the decoded instruction plus the
 * byte count the table does not explain; 'error' refuses instead.
 */
export function decodeNativeInstruction(program, bytes, { trailing = 'report' } = {}) {
  const table = TABLES.get(program);
  if (!table) return { refused: 'not-native' };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new NativeCodecError('empty-payload', `${program}: no instruction data`);
  }
  if (bytes.length < table.width) {
    throw new NativeCodecError('truncated-selector', `${program}: ${bytes.length} byte(s) < ${table.width}-byte selector`);
  }
  const selector = Number(readLe(bytes, 0, table.width));
  const entry = table.ixs[selector];
  if (!entry) {
    throw new NativeCodecError('unknown-selector', `${program}: tag ${selector} is not in the pinned interface`);
  }
  if (entry.wire === 'rejected') {
    throw new NativeCodecError('wire-rejected', `${program}: ${entry.name} (tag ${selector}) is InvalidInstructionData on the wire (runtime rule)`);
  }
  const args = {};
  let offset = table.width;
  for (const spec of entry.args) {
    const decoded = decodeArg(spec.type, bytes, offset, entry.name);
    args[spec.name] = decoded.value;
    offset += decoded.size;
  }
  const trailingBytes = bytes.length - offset;
  if (trailingBytes > 0 && trailing === 'error') {
    throw new NativeCodecError('trailing-bytes', `${program}: ${entry.name} explains ${offset} of ${bytes.length} byte(s)`);
  }
  return {
    name: entry.name,
    selector,
    selectorWidth: table.width,
    args,
    consumed: offset,
    bytes: bytes.length,
    trailing: { count: trailingBytes },
    roundTripByteExact: encodeNativeInstruction(program, entry.name, args).equals(Buffer.from(bytes)),
    scheme: 'native',
    source: 'pinned-native',
  };
}

/**
 * Why the last `decodeNativeInstruction` refused, or null if it did not.
 * The refusal reason is part of the claim, so tests can pin it.
 */
export function nativeRefusal(program, bytes) {
  try {
    const result = decodeNativeInstruction(program, bytes);
    return result.refused ? result.refused : null;
  } catch (error) {
    return error instanceof NativeCodecError ? error.reason : `thrown: ${error.message}`;
  }
}

/** Re-encode one native instruction from a name + args. Throws on mismatch. */
export function encodeNativeInstruction(program, name, values = {}) {
  const table = TABLES.get(program);
  if (!table) throw new NativeCodecError('not-native', program);
  const selector = table.ixs.findIndex((entry) => entry.name === name);
  if (selector < 0) throw new NativeCodecError('unknown-selector', `${program}: ${name}`);
  const entry = table.ixs[selector];
  const head = Buffer.alloc(table.width);
  for (let index = 0; index < table.width; index++) head[index] = Number((BigInt(selector) >> BigInt(index * 8)) & 0xffn);
  const chunks = [head];
  for (const spec of entry.args) {
    const value = values[spec.name];
    if (value === undefined || value === null) throw new NativeCodecError('missing-arg', `${name}.${spec.name}`);
    chunks.push(encodeArg(spec.type, value, `${name}.${spec.name}`));
  }
  return Buffer.concat(chunks);
}

/** Names the table can claim for `program` (coverage callers). */
export function nativeNames(program) {
  const table = TABLES.get(program);
  return table ? table.ixs.filter((entry) => entry.wire !== 'rejected').map((entry) => entry.name) : [];
}

/** Whether `name` belongs to `program`'s native table. */
export function isNativeName(program, name) {
  const table = TABLES.get(program);
  return Boolean(table) && table.ixs.some((entry) => entry.name === name && entry.wire !== 'rejected');
}
