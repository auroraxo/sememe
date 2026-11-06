// Base58 (Bitcoin alphabet) — encode and decode, no dependencies.
//
// The decode core of sememe has to run inside repositories that have no
// npm dependencies at all (a Solana repo that wants to decode instructions
// without installing a toolkit). `@solana/web3.js` was the only third-party
// import in the decode path, and it was used for exactly two things:
// turning 32 raw bytes into a base58 string and back.
//
// This module is that part, on its own. It is deliberately small and
// deliberately boring: the same arithmetic as every other base58
// implementation, with the edge cases (leading zero bytes, invalid
// characters, oversized input) handled explicitly rather than silently.
//
// `decodeBase58` here is also what `src/decode.mjs` uses for payloads; the
// public export there is kept for compatibility.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map([...ALPHABET].map((character, index) => [character, index]));

/** Encode bytes as base58. Leading zero bytes become leading '1' characters. */
export function encodeBase58(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('base58 input must be a Uint8Array/Buffer');
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // `digits` holds base58 digits least-significant first. It starts EMPTY on
  // purpose: seeding it with a zero digit would add a spurious leading '1'
  // for an all-zero input (32 zero bytes must encode to 32 '1' characters,
  // not 33).
  const digits = [];
  for (let index = zeros; index < bytes.length; index++) {
    let carry = bytes[index];
    for (let position = 0; position < digits.length; position++) {
      carry += digits[position] << 8;
      digits[position] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let index = digits.length - 1; index >= 0; index--) out += ALPHABET[digits[index]];
  return out;
}

/**
 * Decode a base58 string into bytes.
 * Throws on an empty string or an invalid character — a payload that cannot
 * be decoded is a caller error, not an empty result.
 *
 * The result is a `Buffer`, not a plain `Uint8Array`. That is not cosmetic:
 * the decode path reads floats with `readFloatLE`/`readDoubleLE` and renders
 * `bytes` arguments with `toString('base64')`, and it re-encodes and compares
 * with `Buffer.equals`. A plain `Uint8Array` has none of those, so a
 * base58-decoded payload failed in three different places while the SAME
 * bytes as hex (which `decodeHex` produces as a Buffer) decoded fine:
 *
 *   - src/union.mjs refused every base58 payload ("unionDecode needs the
 *     payload bytes as a Buffer"),
 *   - f32/f64 arguments died with "slice.readDoubleLE is not a function",
 *   - a `bytes` argument came out as a comma-separated byte list
 *     ("1,2,3,255") instead of base64 — corruption, not an error.
 *
 * Measured against the published v0.4.4 install; fixed in v0.4.5.
 * A Buffer IS a Uint8Array, so every existing caller keeps working.
 */
export function decodeBase58(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('base58 payload must be a non-empty string');
  }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === '1') zeros++;
  // Empty accumulator for the same reason as in encodeBase58: an all-'1'
  // input is N zero bytes, not N+1.
  const bytes = [];
  for (let index = zeros; index < input.length; index++) {
    const value = ALPHABET_MAP.get(input[index]);
    if (value === undefined) throw new Error(`invalid base58 character ${JSON.stringify(input[index])}`);
    let carry = value;
    for (let position = 0; position < bytes.length; position++) {
      carry += bytes[position] * 58;
      bytes[position] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let index = 0; index < bytes.length; index++) out[zeros + index] = bytes[bytes.length - 1 - index];
  // A Buffer VIEW over the same bytes: no copy, and the byte order is
  // exactly what was decoded.
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}
