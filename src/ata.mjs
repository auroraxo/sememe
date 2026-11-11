// The SPL Associated Token Account decoder: the vendored-upstream path for
// the program with the LARGEST measured acquisition gap.
//
// Why this file exists: measured 2026-11-11 across 6 finalized mainnet
// blocks, ATokenGPvbd... carried 1,410 watched payloads and answered at
// NEITHER pullable IDL address — research/ecosystem-coverage-2026-11-11.json
// lists it first in its acquisition queue: "no on-chain IDL at either
// address; needs a first-party published copy or a vendored upstream source".
// Its interface is the upstream Rust, so the wire table is derived from the
// vendored sources by src/ata-interface.mjs and committed as a reviewable
// artifact (`interface/ata-<program>.json`).
//
// Ground truth chain, every row derived and then VERIFIED, not typed:
//   1. INTERFACE  solana-program/associated-token-account@fbf5379
//                 interface/src/instruction.rs (AssociatedTokenAccountInstruction)
//                 program/src/processor.rs       (the runtime verdict)
//                 interface/src/lib.rs           (declare_id -> program id)
//                 DERIVED by tools/ata-interface.mjs into
//                 interface/ata-<program>.json. This module reads the
//                 artifact at load and re-hashes every vendored file against
//                 the sha256 the artifact claims; a mismatch REFUSES the load
//                 instead of decoding from it — the two-check contract
//                 src/native.mjs, src/token.mjs and src/raydium.mjs proved.
//   2. WIRE       borsh's enum encoding of a UNIT enum: the payload is the
//                 one-byte variant index, and no argument bytes follow. The
//                 index upstream's builders write (data: vec![2], // ...::RecoverNested)
//                 is cross-checked against the declaration index at
//                 derivation time.
//   3. RUNTIME    the pin's processor: `input.is_empty()` is executed as
//                 `Create` — so an EMPTY payload is a named Create, exactly
//                 what upstream runs, not an "unknown-selector" refusal;
//                 everything else is judged by `try_from_slice`, and an
//                 unjudged input is ProgramError::InvalidInstructionData —
//                 this module refuses it under the same name.
//
// What is deliberately NOT claimed: no account list, no address derivation
// (see upstream address.rs), no state layout — only instruction data. The
// table describes the program AT THE PIN.
//
// Strictness mirrors src/token.mjs: an unknown selector, a truncated payload
// or a payload with trailing bytes is a refusal with a named reason — never
// a confident wrong label.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAtaInterface, ATA_SPEC, ATA_PINS, ATA_PROGRAM, vendoredAtaHash } from './ata-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export { ATA_PROGRAM };

/**
 * Load the ATA interface: DERIVE it from the vendored upstream Rust, then
 * require the committed artifact to agree with the derivation byte for byte.
 *
 * Two checks, deliberately (the contract the three sibling modules proved):
 *   - the derivation runs against the vendored bytes themselves, so a swapped
 *     or edited source file cannot silently change the table it describes;
 *   - the committed artifact must equal that derivation, so a tampered or
 *     stale artifact refuses the load instead of decoding from it.
 */
function loadInterface(spec) {
  const artifactPath = path.join(ROOT, 'interface', `ata-${spec.program}.json`);
  const derived = deriveAtaInterface(spec);
  let current;
  try {
    current = readFileSync(artifactPath, 'utf8');
  } catch (error) {
    throw new Error(`ata interface artifact for ${spec.label} is missing: ${error.message}`);
  }
  const expected = `${JSON.stringify(derived, null, 2)}\n`;
  if (current !== expected) {
    const claimed = derived.source.files.map((entry) => entry.sha256).join(', ');
    throw new Error(
      `ata interface for ${spec.label} refuses to load: interface/ata-${spec.program}.json does not equal ` +
      `a fresh derivation of ${derived.source.file ?? 'the vendored sources'} (${claimed}, hashed now: ` +
      `${derived.source.files.map((entry) => vendoredAtaHash(entry.file)).join(', ')})`,
    );
  }
  if (!derived.instructions.length || !derived.selector?.width) {
    throw new Error(`ata interface artifact for ${spec.label} is malformed`);
  }
  return derived;
}

const ARTIFACT = loadInterface(ATA_SPEC);
const BY_TAG = new Map(ARTIFACT.instructions.map((entry) => [entry.tag, entry]));
const EMPTY_TAG = ARTIFACT.instructions.find(
  (entry) => entry.name === ARTIFACT.runtime.emptyInputFallback,
)?.tag;

export class AtaCodecError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'AtaCodecError';
    this.reason = reason;
  }
}

/** Whether `program` is the ATA program this module owns. */
export function isAtaProgram(program) {
  return program === ARTIFACT.program;
}

/** Program ids this module can decode, for callers that enumerate. */
export function ataPrograms() {
  return [ARTIFACT.program];
}

/** Provenance for the ATA table. */
export function ataProvenance(program = ATA_PROGRAM) {
  if (!isAtaProgram(program)) return null;
  return {
    label: ARTIFACT.label,
    interface: `${ARTIFACT.source.repo}@${ARTIFACT.source.pin.slice(0, 8)} ${ARTIFACT.source.files[0].file} ${ARTIFACT.source.enum}`,
    encoding: ARTIFACT.argEncoding,
    runtime: `${ARTIFACT.runtime.judge}; ${ARTIFACT.runtime.emptyInputFallback} = the empty-input fallback; unjudged input is ${ARTIFACT.runtime.unknownInputRefusal}`,
    license: ARTIFACT.source.license,
    variants: ARTIFACT.instructions.length,
  };
}

/**
 * Decode one ATA instruction payload.
 *
 * Returns `{ refused: 'not-ata' }` when the caller was never supposed to ask,
 * a named result when the bytes are upstream's own, and throws AtaCodecError
 * with a named reason when the bytes cannot honestly be named — the same
 * tri-state contract as src/token.mjs.
 */
export function decodeAtaInstruction(program, bytes, { trailing = 'report' } = {}) {
  if (!isAtaProgram(program)) return { refused: 'not-ata' };
  if (!(bytes instanceof Uint8Array)) {
    throw new AtaCodecError('empty-payload', `${program}: no instruction data`);
  }

  // Upstream's own runtime rule, read from the pin's processor: an empty
  // input IS a Create. Refusing it as "unknown-selector" would be a true
  // statement about a table and a false one about the program.
  if (bytes.length === 0) {
    if (EMPTY_TAG === undefined) {
      throw new AtaCodecError('empty-payload', `${program}: no instruction data and no empty-input fallback is pinned`);
    }
    return {
      name: ARTIFACT.runtime.emptyInputFallback,
      tag: EMPTY_TAG,
      selectorWidth: 0,
      args: {},
      consumed: 0,
      bytes: 0,
      trailing: { count: 0 },
      roundTripByteExact: EMPTY_TAG !== undefined && encodeAtaInstruction(program, ARTIFACT.runtime.emptyInputFallback).equals(Buffer.from(bytes)),
      scheme: 'native-ata',
      source: 'pinned-vendored-upstream',
      note: 'empty input is upstream\'s own Create fallback (processor at the pin)',
    };
  }

  const tag = bytes[0];
  const entry = BY_TAG.get(tag);
  if (!entry) {
    // The pin's judge: borsh try_from_slice rejects an index it does not
    // declare, and the processor maps that to InvalidInstructionData. The
    // name below is upstream's own refusal, not a guess.
    throw new AtaCodecError(
      'unknown-selector',
      `${program}: tag ${tag} is not in the pinned ${ARTIFACT.label} interface (upstream refuses it as ${ARTIFACT.runtime.unknownInputRefusal})`,
    );
  }

  const trailingBytes = bytes.length - 1;
  if (trailingBytes > 0 && trailing === 'error') {
    throw new AtaCodecError('trailing-bytes', `${program}: ${entry.name} explains 1 of ${bytes.length} byte(s)`);
  }

  return {
    name: entry.name,
    tag,
    selectorWidth: 1,
    args: {},
    consumed: 1,
    bytes: bytes.length,
    trailing: { count: trailingBytes },
    roundTripByteExact: encodeAtaInstruction(program, entry.name).equals(Buffer.from(bytes)),
    scheme: 'native-ata',
    source: 'pinned-vendored-upstream',
  };
}

/** Why the last `decodeAtaInstruction` refused, or null if it did not. */
export function ataRefusal(program, bytes) {
  try {
    const result = decodeAtaInstruction(program, bytes);
    return result.refused ? result.refused : null;
  } catch (error) {
    return error instanceof AtaCodecError ? error.reason : `thrown: ${error.message}`;
  }
}

/** Re-encode one ATA instruction from a name (a unit enum carries no args). */
export function encodeAtaInstruction(program, name) {
  if (!isAtaProgram(program)) throw new AtaCodecError('not-ata', program);
  const entry = ARTIFACT.instructions.find((ix) => ix.name === name);
  if (!entry) throw new AtaCodecError('unknown-variant', `${program}: ${name}`);
  return Buffer.from([entry.tag]);
}

/** Names the table can claim for `program` (coverage callers). */
export function ataNames(program) {
  if (!isAtaProgram(program)) return [];
  return ARTIFACT.instructions.map((entry) => entry.name);
}

/** Whether `name` belongs to `program`'s ATA table. */
export function isAtaName(program, name) {
  if (!isAtaProgram(program)) return false;
  return ARTIFACT.instructions.some((entry) => entry.name === name);
}

/** The vendored pins, for callers that want to show the source. */
export { ATA_PINS };
