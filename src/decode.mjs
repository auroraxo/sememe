// Decode a Solana instruction payload with a locally stored, verified IDL.
//
// The store layout is the one produced by `sememe pull`:
//   <store>/receipts/<program>-<slot>-<source>-<fingerprint>.json
//   <store>/objects/<fingerprint>.json
// The receipt binds the program id to the object, so decoding is offline and
// reproducible: same store + same payload => same result, no network call.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  decodeData,
  decodeInstructionData,
  encodeInstructionData,
  encodeEventData,
  toJsonSafe,
} from './codec.mjs';
import { decodeBase58 } from './base58.mjs';
import { withDerivedDiscriminators } from './discriminators.mjs';
import {
  withDerivedAccountDiscriminators, identifyAccount, decodeAccountData,
} from './account.mjs';

// Kept as a re-export: callers of `src/decode.mjs` import `decodeBase58`
// from here, and the implementation now lives in `src/base58.mjs` so the
// decode core has no third-party import at all.
export { decodeBase58 } from './base58.mjs';

export function decodeHex(input) {
  const cleaned = input.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw Error('hex payload must have an even number of hex digits');
  }
  return Buffer.from(cleaned, 'hex');
}

export function parsePayload(input) {
  if (typeof input !== 'string') throw Error('payload must be a string');
  const trimmed = input.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return decodeHex(trimmed);
  if (/^[0-9a-fA-F]{16,}$/.test(trimmed) && trimmed.length % 2 === 0) return decodeHex(trimmed);
  return decodeBase58(trimmed);
}

/** Find the newest stored IDL for a program id. */
export async function findStoredIdl(storeDir, program) {
  const receipts = path.join(storeDir, 'receipts');
  let names;
  try { names = await readdir(receipts); }
  catch (error) {
    if (error?.code === 'ENOENT') throw Error(`no sememe store at ${storeDir}: run "sememe pull" first`);
    throw error;
  }
  const candidates = names.filter((name) => name.startsWith(`${program}-`));
  if (!candidates.length) throw Error(`no stored IDL for program ${program} in ${storeDir}`);
  candidates.sort();
  const receiptName = candidates[candidates.length - 1];
  const receipt = JSON.parse(await readFile(path.join(receipts, receiptName), 'utf8'));
  const fingerprint = String(receipt.fingerprint).replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw Error(`store receipt has a malformed fingerprint: ${receipt.fingerprint}`);
  const objectPath = path.join(storeDir, 'objects', `${fingerprint}.json`);
  const idl = JSON.parse(await readFile(objectPath, 'utf8'));
  if (!Array.isArray(idl.instructions)) throw Error(`stored object for ${program} has no instructions`);
  return { idl, receipt, receiptName, objectPath };
}

/**
 * Decode one account's data with the locally stored, verified IDL.
 *
 * Same provenance guarantee as decodePayload: the receipt binds the program id
 * to a fingerprinted object, so decoding is offline and reproducible.
 * `name` skips identification (useful when the caller already knows); without
 * it the account's discriminator picks the type.
 */
export async function decodeStoredAccount(storeDir, program, dataInput, { name, trailing } = {}) {
  const { idl: storedIdl, receipt, receiptName, objectPath } = await findStoredIdl(storeDir, program);
  const { idl, filled, conflicts } = withDerivedAccountDiscriminators(storedIdl);
  const bytes = typeof dataInput === 'string'
    ? (dataInput.startsWith('data:') || /[^0-9a-fA-F]/.test(dataInput.trim())
      ? Buffer.from(dataInput.trim().replace(/^base64,/, ''), 'base64')
      : decodeHex(dataInput))
    : Buffer.from(dataInput);
  const identified = name ? { name } : identifyAccount(idl, bytes);
  if (!identified) {
    throw Error(`no account type in the stored IDL matches the first 8 bytes of these ${bytes.length} byte(s)`);
  }
  const decoded = decodeAccountData(idl, bytes, identified.name, trailing ? { trailing } : {});
  return {
    program,
    account: decoded.name,
    args: decoded.args,
    bytes: decoded.total,
    consumed: decoded.consumed,
    roundTripByteExact: decoded.roundTripByteExact,
    discriminator: decoded.discriminator,
    // True when the account bytes actually carry the discriminator the IDL
    // names. False means the caller forced a type name onto bytes that
    // belong to a different (or corrupted) account.
    discriminatorMatches: decoded.hasDiscriminator,
    trailing: decoded.trailing,
    discriminator: decoded.discriminator,
    discriminatorSource: filled > 0 ? (conflicts.length ? 'stored+derived' : 'derived') : 'stored',
    discriminatorDerivation: { filledAccounts: filled, conflicts: conflicts.length },
    idl: { fingerprint: receipt.fingerprint, slot: receipt.slot, source: receipt.source, receipt: receiptName },
    object: objectPath,
  };
}

/**
 * Decode one program payload (instruction or Anchor event self-CPI).
 * Returns the decoded instruction/event plus provenance and a byte-exactness check:
 * re-encoding the decoded value must reproduce the input bytes.
 *
 * `trailing` selects what happens to bytes the stored IDL does not explain:
 * 'report' (default) decodes the described prefix and reports the rest under
 * `trailing`; 'error' refuses the payload. See src/codec.mjs for why 'report'
 * is the default and what real mainnet bytes motivated it.
 */
export async function decodePayload(storeDir, program, payloadInput, { allowTrailing, trailing } = {}) {
  const { idl: storedIdl, receipt, receiptName, objectPath } = await findStoredIdl(storeDir, program);
  // Legacy on-chain IDLs (measured: Kamino Lend, 66 instructions) carry no
  // discriminators at all — they name instructions but cannot decode a byte.
  // Fill the gaps with Anchor's own rule; stored discriminators are never
  // touched, and any conflict with a stored value is reported back to the
  // caller instead of being silently overridden.
  const { idl, filled, conflicts } = withDerivedDiscriminators(storedIdl);
  const bytes = parsePayload(payloadInput);
  const decoded = decodeData(idl, bytes, { allowTrailing, trailing });
  let reencoded;
  if (decoded.kind === 'instruction') {
    reencoded = encodeInstructionData(idl, decoded.instruction, decoded.args);
  } else {
    reencoded = encodeEventData(idl, decoded.event, decoded.args, { tagged: decoded.tagged });
  }
  const described = bytes.subarray(0, decoded.consumed);
  return {
    program,
    kind: decoded.kind,
    instruction: decoded.kind === 'instruction' ? decoded.instruction : undefined,
    event: decoded.kind === 'event' ? decoded.event : undefined,
    name: decoded.kind === 'instruction' ? decoded.instruction : decoded.event,
    discriminator: decoded.discriminator,
    tagged: decoded.tagged,
    args: toJsonSafe(decoded.args),
    bytes: bytes.length,
    consumed: decoded.consumed,
    // True when the re-encoded bytes equal the whole input. With unexplained
    // trailing bytes this is false by construction, so the described prefix is
    // checked separately: `describedRoundTripByteExact` says the IDL-described
    // part reproduces exactly, `trailing.count` says how much was unexplained.
    roundTripByteExact: reencoded.equals(bytes),
    describedRoundTripByteExact: reencoded.equals(described),
    trailing: decoded.trailing,
    // Provenance of the discriminator that matched: stored = the bytes the
    // program wrote on-chain; derived = Anchor's sha256 rule filled a gap.
    discriminatorSource: conflicts.length === 0 && (filled.instructions + filled.events) > 0
      ? 'derived'
      : (filled.instructions + filled.events) > 0 ? 'stored+derived' : 'stored',
    discriminatorDerivation: {
      filledInstructions: filled.instructions,
      filledEvents: filled.events,
      conflicts: conflicts.length,
    },
    idl: { fingerprint: receipt.fingerprint, slot: receipt.slot, source: receipt.source, receipt: receiptName },
    object: objectPath,
  };
}
