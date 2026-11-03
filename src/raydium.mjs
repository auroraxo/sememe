// The Raydium AMM v4 decoder: the vendored-upstream path for a LEGACY
// (pre-Anchor) program that publishes no interface at all.
//
// Why this file exists: measured 2026-11-02 on the unbiased four-block mainnet
// sample, Raydium AMM v4 was the LAST program with no interface sememe could
// acquire — 9 payloads (the whole remaining acquisition gap; every other
// program in the sample was already named). Neither of the two pullable IDL
// addresses answers for it (re-probed live at capture time), and its wire is
// not an Anchor 8-byte discriminator: it is a hand-written `pack()`/`unpack()`
// pair over a SPARSE u8 tag set. So, exactly like the System/ComputeBudget and
// SPL Token tables, the interface is DERIVED from the vendored upstream Rust
// program source by `src/raydium-interface.mjs` and committed as a reviewable
// artifact (`interface/raydium-<program>.json`).
//
// Ground truth chain, every row derived and then VERIFIED, not typed:
//   1. INTERFACE  raydium-io/raydium-amm@91739d8d (Apache-2.0)
//                 program/src/instruction.rs  AmmInstruction / pack() / unpack()
//                 program/src/state.rs        AmmParams, Fees (LEN 64)
//                 DERIVED by tools/raydium-interface.mjs into
//                 interface/raydium-<program>.json. This module reads the
//                 artifact at load and re-hashes BOTH vendored files against
//                 the sha256 the artifact claims; a mismatch REFUSES the load
//                 instead of decoding from it — the two-check contract
//                 src/native.mjs and src/token.mjs already proved.
//   2. WIRE       the pack() arm's literal tag push cross-checked against the
//                 unpack() arm that binds the same integer; the arm's byte-write
//                 sequence cross-checked against unpack()'s reads by count and
//                 width; optional groups carry upstream's own `rest.len() >= N`
//                 threshold (a trailing group, NOT a 1-byte option tag);
//                 branches carry upstream's own discriminator values
//                 (AmmParams enum text or numeric literal).
//   3. RUNTIME    at this pin unpack() binds an explicit sparse u8 tag and an
//                 unknown tag is InvalidInstructionData; the seven variants
//                 upstream marks unsupported PANIC (unimplemented!()).
//
// What is deliberately NOT claimed: this table describes the program AT THE
// PIN. It carries no account list, no invariants and no state layout — only
// instruction data. Program ids 675kPX9… is the mainnet AMM v4 id; the table
// makes no claim about any other Raydium deployment.
//
// Strictness mirrors src/token.mjs: an unknown selector, a wire-rejected
// variant, an unmatched branch discriminator, a truncated payload or a
// truncated optional group is a refusal with a named reason — never a
// confident wrong label.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase58, encodeBase58 } from './base58.mjs';
import {
  deriveRaydiumInterface, RAYDIUM_SPECS, vendoredRaydiumHash,
} from './raydium-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export { RAYDIUM_AMM_V4 } from './raydium-interface.mjs';

/**
 * Load one Raydium interface: DERIVE it from the vendored upstream Rust, then
 * require the committed artifact to agree with the derivation byte for byte.
 *
 * Two checks, deliberately (the contract src/native.mjs already proved):
 *   - the derivation runs against the vendored bytes themselves, so a swapped
 *     or edited source file cannot silently change the table it describes;
 *   - the committed artifact must equal that derivation, so a tampered or
 *     stale artifact refuses the load instead of decoding from it.
 */
function loadInterface(spec) {
  const artifactPath = path.join(ROOT, 'interface', `raydium-${spec.program}.json`);
  const derived = deriveRaydiumInterface(spec);
  let current;
  try {
    current = readFileSync(artifactPath, 'utf8');
  } catch (error) {
    throw new Error(`raydium interface artifact for ${spec.label} is missing: ${error.message}`);
  }
  const expected = `${JSON.stringify(derived, null, 2)}\n`;
  if (current !== expected) {
    const claimed = derived.source.files.map((entry) => entry.sha256).join(', ');
    throw new Error(
      `raydium interface for ${spec.label} refuses to load: interface/raydium-${spec.program}.json does not ` +
      `equal a fresh derivation of ${derived.source.repo}@${derived.source.pin} (${claimed}, ` +
      `hashed now: ${vendoredRaydiumHash(spec)})`,
    );
  }
  if (!derived.instructions.length || !derived.selector?.width) {
    throw new Error(`raydium interface artifact for ${spec.label} is malformed`);
  }
  return derived;
}

const ARTIFACTS = new Map(RAYDIUM_SPECS.map((spec) => [spec.program, loadInterface(spec)]));
const BY_TAG = new Map(RAYDIUM_SPECS.map((spec) => [
  spec.program,
  new Map(ARTIFACTS.get(spec.program).instructions.map((entry) => [entry.tag, entry])),
]));
const BY_NAME = new Map(RAYDIUM_SPECS.map((spec) => [
  spec.program,
  new Map(ARTIFACTS.get(spec.program).instructions.map((entry) => [entry.name, entry])),
]));

export class RaydiumCodecError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'RaydiumCodecError';
    this.reason = reason;
  }
}

/** Whether `program` is a Raydium program this module owns. */
export function isRaydiumProgram(program) {
  return ARTIFACTS.has(program);
}

/** Program ids this module can decode, for callers that enumerate. */
export function raydiumPrograms() {
  return [...ARTIFACTS.keys()];
}

/** Provenance for one Raydium program, or null. */
export function raydiumProvenance(program) {
  const artifact = ARTIFACTS.get(program);
  if (!artifact) return null;
  const reachable = artifact.instructions.filter((entry) => entry.wire !== 'rejected');
  return {
    label: artifact.label,
    interface: `${artifact.source.repo}@${artifact.source.pin.slice(0, 8)} ` +
      `${artifact.source.files.map((entry) => entry.path).join(' + ')} AmmInstruction (explicit sparse tags)`,
    encoding: artifact.argEncoding,
    runtime: artifact.runtime,
    variants: artifact.instructions.length,
    reachable: reachable.length,
    refused: artifact.instructions.length - reachable.length,
    scheme: artifact.scheme,
    source: artifact.source,
  };
}

function readLe(bytes, offset, size) {
  let value = 0n;
  for (let index = size - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

const INT_WIDTH = { u8: 1, u16: 2, u32: 4, u64: 8 };

/** Decode one arg. Returns the value plus the bytes it consumed. */
function decodeArg(spec, bytes, offset, artifact, what) {
  const type = spec.type;
  if (type in INT_WIDTH) {
    const width = INT_WIDTH[type];
    if (offset + width > bytes.length) {
      throw new RaydiumCodecError('truncated', `${what}: truncated ${type} at ${offset} of ${bytes.length} byte(s)`);
    }
    const value = readLe(bytes, offset, width);
    // u8/u16/u32 are safe as Numbers (native.mjs does the same); u64 is not.
    return { value: width < 8 ? Number(value) : value, size: width };
  }
  if (type === 'pubkey') {
    if (offset + 32 > bytes.length) {
      throw new RaydiumCodecError('truncated', `${what}: truncated pubkey at ${offset} of ${bytes.length} byte(s)`);
    }
    return { value: encodeBase58(bytes.subarray(offset, offset + 32)), size: 32 };
  }
  if (type === 'amm_fees') {
    const len = artifact.ammFees.len;
    if (offset + len > bytes.length) {
      throw new RaydiumCodecError('truncated', `${what}: truncated fees struct (${len} bytes) at ${offset} of ${bytes.length} byte(s)`);
    }
    const value = {};
    let at = offset;
    for (const field of artifact.ammFees.fields) {
      value[field.name] = readLe(bytes, at, INT_WIDTH[field.type]);
      at += INT_WIDTH[field.type];
    }
    if (at - offset !== len) {
      throw new RaydiumCodecError('malformed-artifact',
        `${what}: amm_fees fields sum to ${at - offset} byte(s), artifact declares ${len}`);
    }
    return { value, size: len };
  }
  throw new RaydiumCodecError('unknown-arg-type', `${what}: arg type ${type} is not in the pinned table`);
}

/** Encode one arg back to bytes. Throws on any value that cannot be written. */
function encodeArg(spec, value, artifact, what) {
  const type = spec.type;
  if (type in INT_WIDTH) {
    const width = INT_WIDTH[type];
    const v = typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value)
      : typeof value === 'number' ? BigInt(value)
        : typeof value === 'bigint' ? value
          : (() => { throw new RaydiumCodecError('bad-arg', `${what}: not an integer`); })();
    if (v < 0n || v >= (1n << BigInt(width * 8))) {
      throw new RaydiumCodecError('bad-arg', `${what}: out of ${type} range`);
    }
    const out = Buffer.alloc(width);
    for (let index = 0; index < width; index++) out[index] = Number((v >> BigInt(index * 8)) & 0xffn);
    return out;
  }
  if (type === 'pubkey') {
    const raw = Buffer.from(decodeBase58(String(value)));
    if (raw.length !== 32) throw new RaydiumCodecError('bad-arg', `${what}: not a 32-byte pubkey`);
    return raw;
  }
  if (type === 'amm_fees') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RaydiumCodecError('bad-arg', `${what}: amm_fees must be an object of named fields`);
    }
    const chunks = [];
    for (const field of artifact.ammFees.fields) {
      if (value[field.name] === undefined) {
        throw new RaydiumCodecError('bad-arg', `${what}: missing fee field ${field.name}`);
      }
      chunks.push(encodeArg({ name: field.name, type: field.type }, value[field.name], artifact, `${what}.${field.name}`));
    }
    return Buffer.concat(chunks);
  }
  throw new RaydiumCodecError('unknown-arg-type', `${what}: arg type ${type} is not in the pinned table`);
}

/** The branch of `entry` that its discriminator selects, or null. */
function branchFor(entry, discriminator, artifact, what) {
  for (const branch of entry.branches) {
    if (Array.isArray(branch.values) && branch.values.includes(discriminator)) return branch;
  }
  // A wildcard branch (`values: null`) is upstream's own `match ... { _ => Err }`
  // arm: it is a refusal, not a catch-all decode.
  const wildcard = entry.branches.find((branch) => branch.values === null);
  if (wildcard) return wildcard;
  throw new RaydiumCodecError('unknown-branch',
    `${what}: discriminator ${JSON.stringify(discriminator)} selects no branch of the pinned ${entry.name}`);
}

/**
 * Decode one Raydium AMM v4 instruction payload.
 *
 * Returns `{refused: 'not-raydium'}` when the caller was never supposed to ask,
 * throws a `RaydiumCodecError` (named reason) when this program's own table
 * refuses, and returns a result — named AND re-encodable — otherwise.
 *
 * `trailing: 'report'` (default) returns the decoded instruction plus the byte
 * count the table does not explain; 'error' refuses instead.
 */
export function decodeRaydiumInstruction(program, bytes, { trailing = 'report' } = {}) {
  const artifact = ARTIFACTS.get(program);
  if (!artifact) return { refused: 'not-raydium' };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new RaydiumCodecError('empty-payload', `${program}: no instruction data`);
  }
  const tag = bytes[0];
  const entry = BY_TAG.get(program).get(tag);
  if (!entry) {
    throw new RaydiumCodecError('unknown-selector', `${program}: tag ${tag} is not in the pinned ${artifact.label} interface`);
  }
  if (entry.wire === 'rejected') {
    throw new RaydiumCodecError('wire-rejected',
      `${program}: ${entry.name} (tag ${tag}) is refused by upstream itself — ${entry.reason}`);
  }

  const args = {};
  const absent = [];
  let offset = 1;
  for (const spec of entry.args) {
    const decoded = decodeArg(spec, bytes, offset, artifact, `${entry.name}.${spec.name}`);
    args[spec.name] = decoded.value;
    offset += decoded.size;
  }

  if (entry.optional) {
    // Upstream's rule is a LENGTH GUARD, not an option tag: the group is there
    // only when at least `presentWhenRemainingAtLeast` bytes remain. Fewer
    // bytes than that are NOT the group, and are reported as trailing.
    const threshold = entry.optional.presentWhenRemainingAtLeast;
    const remaining = bytes.length - offset;
    if (remaining >= threshold) {
      for (const spec of entry.optional.args) {
        const decoded = decodeArg(spec, bytes, offset, artifact, `${entry.name}.${spec.name}`);
        args[spec.name] = decoded.value;
        offset += decoded.size;
      }
    } else {
      for (const spec of entry.optional.args) absent.push(spec.name);
    }
  }

  if (entry.branches) {
    const branch = branchFor(entry, args[entry.branches[0].on], artifact, `${entry.name}.${entry.branches[0].on}`);
    if (branch.wire === 'rejected') {
      throw new RaydiumCodecError('wire-rejected',
        `${program}: ${entry.name} with ${entry.branches[0].on}=${JSON.stringify(args[entry.branches[0].on])} ` +
        `is refused by upstream itself — ${branch.reason}`);
    }
    for (const spec of branch.args) {
      const decoded = decodeArg(spec, bytes, offset, artifact, `${entry.name}.${spec.name}`);
      args[spec.name] = decoded.value;
      offset += decoded.size;
    }
  }

  const trailingBytes = bytes.length - offset;
  if (trailingBytes > 0 && trailing === 'error') {
    throw new RaydiumCodecError('trailing-bytes', `${program}: ${entry.name} explains ${offset} of ${bytes.length} byte(s)`);
  }
  return {
    name: entry.name,
    tag,
    selectorWidth: 1,
    args,
    // Optional fields the payload did NOT carry: the group is absent because
    // the payload was shorter than upstream's own length threshold.
    absent,
    consumed: offset,
    bytes: bytes.length,
    trailing: { count: trailingBytes },
    roundTripByteExact: encodeRaydiumInstruction(program, entry.name, args).equals(Buffer.from(bytes)),
    scheme: artifact.scheme,
    source: 'pinned-vendored-upstream',
  };
}

/** Why the last `decodeRaydiumInstruction` refused, or null if it did not. */
export function raydiumRefusal(program, bytes) {
  try {
    const result = decodeRaydiumInstruction(program, bytes);
    return result.refused ? result.refused : null;
  } catch (error) {
    return error instanceof RaydiumCodecError ? error.reason : `thrown: ${error.message}`;
  }
}

/**
 * Re-encode one Raydium instruction from a name + args. Throws on mismatch.
 *
 * An optional group is written only when EVERY one of its args is supplied, so
 * a decode that found the group absent re-encodes to exactly the shorter wire;
 * supplying only part of the group is refused rather than guessed.
 */
export function encodeRaydiumInstruction(program, name, values = {}) {
  const artifact = ARTIFACTS.get(program);
  if (!artifact) throw new RaydiumCodecError('not-raydium', program);
  const entry = BY_NAME.get(program).get(name);
  if (!entry) throw new RaydiumCodecError('unknown-variant', `${program}: ${name}`);
  if (entry.wire === 'rejected') {
    throw new RaydiumCodecError('wire-rejected', `${program}: ${name} is refused by upstream itself — ${entry.reason}`);
  }
  const chunks = [Buffer.from([entry.tag])];
  const write = (spec) => {
    const value = values[spec.name];
    if (value === undefined || value === null) {
      throw new RaydiumCodecError('missing-arg', `${name}.${spec.name}`);
    }
    chunks.push(encodeArg(spec, value, artifact, `${name}.${spec.name}`));
  };
  for (const spec of entry.args) write(spec);
  if (entry.optional) {
    const supplied = entry.optional.args.map((spec) => values[spec.name] ?? null);
    const present = supplied.filter((value) => value !== null).length;
    if (present > 0 && present < supplied.length) {
      const missing = entry.optional.args.filter((spec) => values[spec.name] == null).map((spec) => spec.name);
      throw new RaydiumCodecError('partial-optional',
        `${name}: optional group ${entry.optional.args.map((spec) => spec.name).join('+')} is all-or-none; missing ${missing.join(', ')}`);
    }
    if (present === supplied.length) for (const spec of entry.optional.args) write(spec);
  }
  if (entry.branches) {
    const discriminator = values[entry.branches[0].on];
    if (discriminator === undefined || discriminator === null) {
      throw new RaydiumCodecError('missing-arg', `${name}.${entry.branches[0].on}`);
    }
    const branch = branchFor(entry, discriminator, artifact, `${name}.${entry.branches[0].on}`);
    if (branch.wire === 'rejected') {
      throw new RaydiumCodecError('wire-rejected',
        `${name}: ${entry.branches[0].on}=${JSON.stringify(discriminator)} is refused by upstream itself — ${branch.reason}`);
    }
    for (const spec of branch.args) write(spec);
  }
  return Buffer.concat(chunks);
}

/** Names the table can claim for `program` (coverage callers). */
export function raydiumNames(program) {
  const artifact = ARTIFACTS.get(program);
  return artifact ? artifact.instructions.filter((entry) => entry.wire !== 'rejected').map((entry) => entry.name) : [];
}

/** Whether `name` belongs to `program`'s Raydium table. */
export function isRaydiumName(program, name) {
  return BY_NAME.get(program)?.has(name) ?? false;
}
