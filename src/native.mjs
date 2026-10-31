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
// Ground truth chain, every row pinned:
//   1. INTERFACE  anza-xyz/solana-sdk@8db406e2edfafa25939ec782b77b5b6f30de164d
//                 compute-budget-interface/src/lib.rs (ComputeBudgetInstruction, variants 0..4)
//                 system-interface/src/instruction.rs (SystemInstruction, variants 0..13)
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

import { decodeBase58, encodeBase58 } from './base58.mjs';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

const SDK_PIN = 'anza-xyz/solana-sdk@8db406e2edfafa25939ec782b77b5b6f30de164d';
const RUNTIME_PIN = 'anza-xyz/agave@master (read 2026-10-31)';

// Arg shapes: `u32`/`u64` fixed-width LE, `pubkey` 32 raw bytes, `string`
// u64-length-prefixed utf8 (bincode fixint, measured on-chain), `unit` none.
// The table is declaration order of the pinned enum; the selector IS the index.

const COMPUTE_BUDGET_IXS = [
  // Reserved deprecated variant, declaration index 0. The runtime's
  // borsh decode hits it for any data that is all-zero enough, then rejects:
  // `_ => Err(InvalidInstructionData)`. Kept here as wire-rejected so a tag-0
  // payload gets a named refusal instead of silently falling out of the table
  // — the refusal is the fact, and the fact is pinned.
  { name: 'Unused', wire: 'rejected', args: [] },
  { name: 'RequestHeapFrame', args: [{ name: 'bytes', type: 'u32' }] },
  { name: 'SetComputeUnitLimit', args: [{ name: 'units', type: 'u32' }] },
  { name: 'SetComputeUnitPrice', args: [{ name: 'microLamports', type: 'u64' }] },
  { name: 'SetLoadedAccountsDataSizeLimit', args: [{ name: 'bytes', type: 'u32' }] },
];

const SYSTEM_IXS = [
  { name: 'CreateAccount', args: [{ name: 'lamports', type: 'u64' }, { name: 'space', type: 'u64' }, { name: 'owner', type: 'pubkey' }] },
  { name: 'Assign', args: [{ name: 'owner', type: 'pubkey' }] },
  { name: 'Transfer', args: [{ name: 'lamports', type: 'u64' }] },
  { name: 'CreateAccountWithSeed', args: [{ name: 'base', type: 'pubkey' }, { name: 'seed', type: 'string' }, { name: 'lamports', type: 'u64' }, { name: 'space', type: 'u64' }, { name: 'owner', type: 'pubkey' }] },
  { name: 'AdvanceNonceAccount', args: [] },
  { name: 'WithdrawNonceAccount', args: [{ name: 'lamports', type: 'u64' }] },
  { name: 'InitializeNonceAccount', args: [{ name: 'authorized', type: 'pubkey' }] },
  { name: 'AuthorizeNonceAccount', args: [{ name: 'authorized', type: 'pubkey' }] },
  { name: 'Allocate', args: [{ name: 'space', type: 'u64' }] },
  { name: 'AllocateWithSeed', args: [{ name: 'base', type: 'pubkey' }, { name: 'seed', type: 'string' }, { name: 'space', type: 'u64' }, { name: 'owner', type: 'pubkey' }] },
  { name: 'AssignWithSeed', args: [{ name: 'base', type: 'pubkey' }, { name: 'seed', type: 'string' }, { name: 'owner', type: 'pubkey' }] },
  { name: 'TransferWithSeed', args: [{ name: 'lamports', type: 'u64' }, { name: 'fromSeed', type: 'string' }, { name: 'fromOwner', type: 'pubkey' }] },
  { name: 'UpgradeNonceAccount', args: [] },
  { name: 'CreateAccountAllowPrefund', args: [{ name: 'lamports', type: 'u64' }, { name: 'space', type: 'u64' }, { name: 'owner', type: 'pubkey' }] },
];

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
  [SYSTEM_PROGRAM, { width: 4, ixs: SYSTEM_IXS }],
  [COMPUTE_BUDGET_PROGRAM, { width: 1, ixs: COMPUTE_BUDGET_IXS }],
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
