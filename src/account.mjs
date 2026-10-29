// Decode a program's account state from the stored, verified on-chain IDL.
//
// Why this file exists: instructions are only half of a program's interface.
// An account carries state, and the meaning of that state lives in the same
// IDL — but the IDL describes it differently:
//   - a newer IDL lists accounts as `{ name, discriminator, type }`
//   - a legacy IDL lists accounts as `{ name, type }` with no discriminator
// Anchor's own rule for the account discriminator is
//   sha256("account:" + PascalCase(name))[0..8]
// (anchor-ts `BorshAccountsCoder.accountDiscriminator`). The rule is filled in
// only where the IDL stores no discriminator; a stored value always wins and a
// conflict is reported, never silently overridden.
//
// An account's bytes are NOT a discriminator + a fixed struct in the general
// case. Two shapes occur on mainnet and both are handled here:
//   1. Anchor accounts: 8-byte discriminator ++ borsh(struct fields)
//   2. Accounts whose data starts with the struct itself (no discriminator):
//      the first bytes are the first fields, so the struct may simply not
//      fit in the account (a `vec` at the end is truncated) and the decode
//      stops at the first field that needs bytes the account does not have.
//
// The decoder is strict about what it can prove: it reports which bytes it
// consumed, whether the re-encoded bytes reproduce the account exactly, and
// any bytes the IDL does not explain. A decode that consumed fewer bytes than
// the account holds is NOT a failure — it means the account is larger than the
// struct the IDL describes, which is normal for accounts with a trailing
// `vec` that grew.

import { createHash } from 'node:crypto';
import {
  decodeTypePartial, encodeType, toJsonSafe, CodecError,
} from './codec.mjs';

const ACCOUNT_DISCRIMINATOR_SIZE = 8;

const sha256 = (text) => createHash('sha256').update(text).digest();

/** Anchor's account discriminator for a name: sha256("account:" + PascalCase). */
export function accountDiscriminator(name) {
  if (typeof name !== 'string' || !name) throw new CodecError('account name must be a non-empty string', null);
  const preimage = `account:${name}`;
  return Array.from(sha256(preimage).subarray(0, ACCOUNT_DISCRIMINATOR_SIZE));
}

/**
 * Fill in missing account discriminators with Anchor's rule.
 * Stored discriminators are never changed; a conflict is returned.
 *
 * @returns {{ idl: object, filled: number, conflicts: object[] }}
 */
export function withDerivedAccountDiscriminators(idl) {
  const copy = structuredClone(idl);
  let filled = 0;
  const conflicts = [];
  for (const account of copy.accounts ?? []) {
    const stored = account?.discriminator;
    const isStored = Array.isArray(stored) && stored.length === ACCOUNT_DISCRIMINATOR_SIZE
      && stored.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
    const derived = accountDiscriminator(account.name);
    if (isStored) {
      const same = derived.every((byte, index) => byte === stored[index]);
      if (!same) {
        conflicts.push({ name: account.name, stored: stored.slice(), derived });
      }
      continue;
    }
    account.discriminator = derived;
    filled++;
  }
  return { idl: copy, filled, conflicts };
}

/**
 * The IDL's account type definition (a struct shape) for one account name.
 * Two IDL shapes exist and both occur on mainnet:
 *   - newer IDL: `accounts: [{ name, discriminator }]` with the struct under
 *     `types: [{ name, type: { kind: 'struct', fields } }]`
 *   - legacy IDL: `accounts: [{ name, type: { fields } }]` inline
 */
function accountType(idl, name) {
  const account = (idl.accounts ?? []).find((candidate) => candidate?.name === name);
  if (!account) {
    const known = (idl.accounts ?? []).map((candidate) => candidate?.name).filter(Boolean);
    throw new CodecError(
      `unknown account ${JSON.stringify(name)}; this IDL has ${known.length} account(s)`, null);
  }
  if (account.type && typeof account.type === 'object') return { account, type: account.type };
  const typedef = (idl.types ?? []).find((candidate) => candidate?.name === name);
  if (!typedef || !typedef.type) {
    throw new CodecError(`account ${name} has no type in this IDL (neither inline nor in types)`, null);
  }
  return { account, type: typedef.type };
}

function typeContext(idl) {
  const types = new Map();
  for (const typedef of idl?.types ?? []) {
    if (typedef && typeof typedef.name === 'string') types.set(typedef.name, typedef);
  }
  return { types };
}

/**
 * Decode one account's raw data with the stored IDL.
 *
 * `data` is the account's byte content (the value behind `getMultipleAccounts`,
 * already base64-decoded).
 *
 * @returns {{ name, discriminator, args, consumed, total, trailing,
 *             roundTripByteExact, describedRoundTripByteExact, hasDiscriminator }}
 */
export function decodeAccountData(idl, data, name, options = {}) {
  if (!(data instanceof Uint8Array)) throw new CodecError('account data must be a Uint8Array/Buffer', null);
  const { trailing = 'report' } = options;
  if (trailing !== 'report' && trailing !== 'error') {
    throw new CodecError(`unknown trailing policy ${trailing}`, null);
  }
  const { account, type } = accountType(idl, name);
  const ctx = typeContext(idl);
  const bytes = Buffer.from(data);

  // Does this account carry the Anchor account discriminator? Compare the
  // first 8 bytes with the discriminator the IDL names (stored or derived).
  const expected = Array.isArray(account.discriminator) && account.discriminator.length === ACCOUNT_DISCRIMINATOR_SIZE
    ? Buffer.from(account.discriminator)
    : null;
  const hasDiscriminator = expected ? bytes.subarray(0, ACCOUNT_DISCRIMINATOR_SIZE).equals(expected) : false;

  // With a discriminator the struct starts after it; without one the struct
  // starts at byte 0 (a non-Anchor or legacy account).
  //
  // The offset follows the IDL, not the bytes: if the IDL names a
  // discriminator for this account type, the struct starts after 8 bytes even
  // when the bytes in hand carry a different discriminator (a corrupted or
  // foreign account). `hasDiscriminator` records whether the bytes actually
  // carry the expected one.
  const offset = expected ? ACCOUNT_DISCRIMINATOR_SIZE : 0;
  const body = bytes.subarray(offset);

  let decoded;
  let consumed = 0;
  try {
    const result = decodeTypePartial(type, body, ctx, `${name}`);
    decoded = result.value;
    consumed = result.consumed;
  } catch (error) {
    // A truncated account is a normal mainnet condition: the struct's last
    // field is often a `vec` that grew past the account size, or the account
    // is smaller than the struct. Report it instead of pretending it decoded.
    if (!(error instanceof CodecError)) throw error;
    throw new CodecError(
      `account ${name}: ${error.message} (account holds ${body.length} byte(s) after the discriminator)`, name);
  }

  const trailingCount = body.length - consumed;
  if (trailingCount > 0 && trailing === 'error') {
    throw new CodecError(
      `account ${name}: ${trailingCount} byte(s) after the described struct are not described by the IDL`, name);
  }

  // Re-encoding the decoded struct must reproduce the bytes it came from.
  let reencoded = null;
  try {
    reencoded = encodeType(type, decoded, ctx, `${name}`);
  } catch {
    reencoded = null;
  }
  const described = body.subarray(0, consumed);
  return {
    name,
    discriminator: expected ? expected.toString('hex') : null,
    hasDiscriminator,
    args: toJsonSafe(decoded),
    consumed: consumed + offset,
    total: bytes.length,
    trailing: { count: trailingCount, hex: trailingCount > 0 ? body.subarray(consumed).toString('hex') : '' },
    roundTripByteExact: reencoded ? reencoded.equals(body) : false,
    describedRoundTripByteExact: reencoded ? reencoded.equals(described) : false,
  };
}

/**
 * Identify which account type a blob of account data belongs to, using the
 * discriminator table the IDL provides (stored or derived).
 *
 * @returns {{ name, discriminator } | null}
 */
export function identifyAccount(idl, data) {
  if (!(data instanceof Uint8Array) || data.length < ACCOUNT_DISCRIMINATOR_SIZE) return null;
  const head = Buffer.from(data.subarray(0, ACCOUNT_DISCRIMINATOR_SIZE)).toString('hex');
  for (const account of idl?.accounts ?? []) {
    const discriminator = account?.discriminator;
    if (!Array.isArray(discriminator) || discriminator.length !== ACCOUNT_DISCRIMINATOR_SIZE) continue;
    if (Buffer.from(discriminator).toString('hex') === head) {
      return { name: account.name, discriminator: head };
    }
  }
  return null;
}
