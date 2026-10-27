// Decode a Solana instruction payload with a locally stored, verified IDL.
//
// The store layout is the one produced by `sememe pull`:
//   <store>/receipts/<program>-<slot>-<source>-<fingerprint>.json
//   <store>/objects/<fingerprint>.json
// The receipt binds the program id to the object, so decoding is offline and
// reproducible: same store + same payload => same result, no network call.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { decodeInstructionData, encodeInstructionData, toJsonSafe } from './codec.mjs';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decodeBase58(input) {
  if (typeof input !== 'string' || input.length === 0) throw Error('base58 payload must be a non-empty string');
  let value = 0n;
  for (const character of input) {
    const index = BASE58.indexOf(character);
    if (index < 0) throw Error(`invalid base58 character ${JSON.stringify(character)}`);
    value = value * 58n + BigInt(index);
  }
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value & 0xffn)); value >>= 8n; }
  for (const character of input) { if (character === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

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
 * Decode one instruction payload.
 * Returns the decoded instruction plus provenance and a byte-exactness check:
 * re-encoding the decoded value must reproduce the input bytes.
 *
 * `trailing` selects what happens to bytes the stored IDL does not explain:
 * 'report' (default) decodes the described prefix and reports the rest under
 * `trailing`; 'error' refuses the payload. See src/codec.mjs for why 'report'
 * is the default and what real mainnet bytes motivated it.
 */
export async function decodePayload(storeDir, program, payloadInput, { allowTrailing, trailing } = {}) {
  const { idl, receipt, receiptName, objectPath } = await findStoredIdl(storeDir, program);
  const bytes = parsePayload(payloadInput);
  const decoded = decodeInstructionData(idl, bytes, { allowTrailing, trailing });
  const reencoded = encodeInstructionData(idl, decoded.instruction, decoded.args);
  const described = bytes.subarray(0, decoded.consumed);
  return {
    program,
    instruction: decoded.instruction,
    discriminator: decoded.discriminator,
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
    idl: { fingerprint: receipt.fingerprint, slot: receipt.slot, source: receipt.source, receipt: receiptName },
    object: objectPath,
  };
}
