// wire-tx.mjs — read a Solana transaction from its WIRE bytes.
//
// Why this file exists: sememe's decode path used to accept only the RPC
// `encoding: "json"` shape, where the chain's own parser has already turned
// the wire bytes into instruction objects. That is the shape sememe's OWN
// harvester produces — so the decoder could read its own fixtures and nothing
// else. A foreign repository, an archive, a dashboard or an indexer holds the
// DEFAULT shape: `encoding: "base64"`, the transaction as bytes.
//
// So the integration was not an integration. This file closes that gap: it
// parses the wire bytes of a transaction into exactly the shape
// `tools/lib/payloads.mjs` already understands, so the product's decode path
// can be pointed at a foreign repository's data without that repository
// changing anything.
//
// The three wire layouts, pinned from the pinned upstream parser
// (@solana/web3.js 1.99.0, Apache-2.0, used here as a DISPOSABLE ORACLE to
// establish the byte order — never imported at runtime, sememe's decode path
// stays dependency-free):
//
//   LEGACY message (version absent/"legacy"):
//     header(3 x u8) | accountCount(compact-u16) | accountKeys(32 each)
//       | recentBlockhash(32) | instructionCount(compact-u16)
//       | instructions | addressTableLookupCount(compact-u16) | lookups
//     instructions: programIdIndex(u8) | accountCount(compact-u16)
//       | accountIndexes(u8 each) | dataLength(compact-u16) | data
//
//   V0 message (prefix byte 0x80):
//     same as legacy, plus the versioned prefix in front.
//
//   V1 message (prefix byte 0x81) — a DIFFERENT layout, and the reason a
//   naive parser breaks:
//     header(3 x u8) | configMask(u32 LE) | recentBlockhash(32)
//       | instructionCount(u8) | staticAccountKeysLength(u8)
//       | staticAccountKeys(32 each) | [config fields] | instructions
//     instructions: programIdIndex(u8) | accountCount(u8) | dataLength(u8)
//       | accountIndexes(u8 each) | data
//     The transaction-level framing differs too: for V1 the MESSAGE comes
//     first and the signatures are APPENDED at the end (the sigcount is the
//     raw u8 at offset 1); for V0/legacy the compact-u16 sigcount comes
//     first and the signatures follow it, then the message.
//
// configMask bits (V1 only, from the upstream constants):
//   0b00011 priority fee (two bits, both set or both clear)
//   0b00100 compute unit limit (u32 LE)
//   0b01000 loaded accounts data size limit (u32 LE)
//   0b10000 heap size (u32 LE)
//
// Every read is bounds-checked and every count is validated against the
// remaining bytes, so a damaged or truncated transaction produces a NAMED
// refusal instead of a plausible-looking wrong answer. That is the property
// the whole tool depends on: a payload sememe names must be bytes it can
// reproduce.

import { decodeBase58, encodeBase58 } from '../../src/base58.mjs';
import { createPublicKey, verify as verifySignature } from 'node:crypto';

const PUBLIC_KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const VERSION_PREFIX_MASK = 0x7f;
const VERSION_0_PREFIX = 0x80;
const VERSION_1_PREFIX = 0x81;

const CONFIG_MASK_PRIORITY_FEE_BITS = 0b00011;
const CONFIG_MASK_COMPUTE_UNIT_LIMIT_BIT = 0b00100;
const CONFIG_MASK_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT = 0b01000;
const CONFIG_MASK_HEAP_SIZE_BIT = 0b10000;

/** A refusal with a name, so callers can report it instead of crashing. */
export class WireRefusal extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.name = 'WireRefusal';
    this.reason = reason;
    this.detail = detail;
  }
}

const refuse = (reason, detail) => { throw new WireRefusal(reason, detail); };

/**
 * The shortvec reader the WIRE uses, strict to Solana's shortvec rule: at
 * most three bytes, the value at most 0xffff (the encoding is a u16; agave is
 * the implementation that accepts blocks into the ledger, so bytes it would
 * reject do not occur on mainnet — refusing them can never reject a real
 * transaction, while accepting them would let a damaged document mis-slice
 * every later field).
 *
 * @param {Buffer} bytes
 * @param {number} offset
 * @returns {[number, number]} [value, offsetAfter] — the offset AFTER the
 *   encoding, like every other reader in this file.
 */
export function decodeCompactU16(bytes, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (let i = 0; i < 3; i += 1) {
    if (index >= bytes.length) refuse('wire-truncated', `shortvec length at offset ${offset} runs past the end`);
    const byte = bytes[index];
    index += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > 0xffff) refuse('wire-shortvec-overflow', `shortvec length at offset ${offset} exceeds 0xffff (Solana shortvec encodes a u16)`);
      return [value, index];
    }
    shift += 7;
  }
  refuse('wire-shortvec-overflow', `shortvec length at offset ${offset} exceeds 0xffff (Solana shortvec encodes a u16)`);
}

/**
 * A u8 count, but named: the V1 message uses plain u8 lengths where V0 uses
 * shortvec, and mixing them up shifts every later field.
 */
const readU8 = (bytes, offset, what) => {
  if (offset >= bytes.length) refuse('wire-truncated', `${what} at offset ${offset} runs past the end`);
  return [bytes[offset], offset + 1];
};

const readBytes = (bytes, offset, length, what) => {
  if (length < 0 || offset + length > bytes.length) {
    refuse('wire-truncated', `${what} of ${length} bytes at offset ${offset} runs past the end (${bytes.length} bytes available)`);
  }
  return [bytes.subarray(offset, offset + length), offset + length];
};

const readU32Le = (bytes, offset, what) => {
  const [slice, next] = readBytes(bytes, offset, 4, what);
  return [slice[0] + slice[1] * 2 ** 8 + slice[2] * 2 ** 16 + slice[3] * 2 ** 24, next];
};

const readU64Le = (bytes, offset, what) => {
  const [slice, next] = readBytes(bytes, offset, 8, what);
  let value = 0n;
  for (let i = slice.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(slice[i]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) refuse('wire-u64-overflow', `${what} at offset ${offset} exceeds the safe integer range`);
  return [Number(value), next];
};

/**
 * Verify the transaction's ed25519 signatures against its message bytes.
 *
 * This is what makes wire ingestion SELF-VERIFYING: a flipped byte inside the
 * message (an account key, an instruction length) would otherwise silently
 * produce a WRONG decode — a payload attributed to a program it never
 * touched. The signature covers exactly the message bytes, so any such damage
 * is detected and refused by name instead of decoded wrongly. node:crypto
 * verifies ed25519 natively; the public keys are the transaction's own first
 * account keys.
 *
 * @param {Buffer} messageBytes the exact message slice the signatures cover
 * @param {string[]} signatures base58 signatures (only the first
 *   numRequiredSignatures carry meaning)
 * @param {string[]} accountKeys base58 account keys; index < numRequiredSignatures signs
 * @param {number} numRequiredSignatures
 */
function requireValidSignatures(messageBytes, signatures, accountKeys, numRequiredSignatures) {
  if (numRequiredSignatures < 1) return;
  if (!Array.isArray(signatures) || signatures.length < numRequiredSignatures) {
    refuse('wire-signature-missing', `expected ${numRequiredSignatures} signature(s), found ${signatures?.length ?? 0}`);
  }
  for (let i = 0; i < numRequiredSignatures; i += 1) {
    let publicKey;
    try {
      publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeBase58(accountKeys[i] ?? '')]),
        format: 'der',
        type: 'spki',
      });
    } catch (error) {
      refuse('wire-signature-key', `signer ${i} (${String(accountKeys[i]).slice(0, 12)}…) is not a valid ed25519 key: ${String(error?.message ?? error).slice(0, 80)}`);
    }
    let signatureBytes;
    try {
      signatureBytes = decodeBase58(signatures[i]);
    } catch (error) {
      refuse('wire-signature-malformed', `signature ${i} is not valid base58`);
    }
    if (signatureBytes.length !== 64) {
      refuse('wire-signature-malformed', `signature ${i} is ${signatureBytes.length} bytes, ed25519 signatures are 64`);
    }
    let ok = false;
    try {
      ok = verifySignature(null, messageBytes, publicKey, signatureBytes);
    } catch {
      ok = false;
    }
    if (!ok) {
      refuse('wire-signature-invalid', `signature ${i} does not verify against the message bytes — the document is damaged or forged`);
    }
  }
}

/**
 * Parse the LEGACY / V0 message.
 *
 * The two differ in exactly one place: a V0 message ends with the
 * address-table-lookup section, a legacy message has none. Reading a lookup
 * count where the legacy message has none consumed the transaction's trailing
 * bytes and refused every legacy transaction — measured, then fixed.
 *
 * @param {Buffer} bytes
 * @param {number} offset where the message starts
 * @returns {{message: object, next: number}}
 */
function parseLegacyMessage(bytes, offset) {
  let index = offset;
  const versioned = (bytes[index] & VERSION_PREFIX_MASK) !== bytes[index];
  if (versioned) {
    if (bytes[index] !== VERSION_0_PREFIX) refuse('wire-unsupported-version', `message prefix 0x${bytes[index].toString(16)} is not v0`);
    index += 1;
  }
  const [numRequiredSignatures, a] = readU8(bytes, index, 'numRequiredSignatures');
  const [numReadonlySignedAccounts, b] = readU8(bytes, a, 'numReadonlySignedAccounts');
  const [numReadonlyUnsignedAccounts, c] = readU8(bytes, b, 'numReadonlyUnsignedAccounts');
  index = c;

  const [accountCount, d] = decodeCompactU16(bytes, index);
  index = d;
  const accountKeys = [];
  for (let i = 0; i < accountCount; i += 1) {
    const [key, next] = readBytes(bytes, index, PUBLIC_KEY_LENGTH, `account key ${i}`);
    accountKeys.push(encodeBase58(key));
    index = next;
  }

  const [blockhashBytes, e] = readBytes(bytes, index, PUBLIC_KEY_LENGTH, 'recentBlockhash');
  index = e;
  const recentBlockhash = encodeBase58(blockhashBytes);

  const [instructionCount, f] = decodeCompactU16(bytes, index);
  index = f;
  const instructions = [];
  for (let i = 0; i < instructionCount; i += 1) {
    const [programIdIndex, g] = readU8(bytes, index, `instruction ${i} programIdIndex`);
    const [accountIndexCount, h] = decodeCompactU16(bytes, g);
    const [accountIndexes, i2] = readBytes(bytes, h, accountIndexCount, `instruction ${i} account indexes`);
    const [dataLength, j] = decodeCompactU16(bytes, i2);
    const [data, k] = readBytes(bytes, j, dataLength, `instruction ${i} data`);
    index = k;
    instructions.push({
      programIdIndex,
      accounts: [...accountIndexes],
      data: encodeBase58(data),
    });
  }

  const addressTableLookups = [];
  if (versioned) {
    const [lookupCount, l] = decodeCompactU16(bytes, index);
    index = l;
    for (let i = 0; i < lookupCount; i += 1) {
      const [tableKey, m] = readBytes(bytes, index, PUBLIC_KEY_LENGTH, `address table lookup ${i}`);
      index = m;
      const [writableCount, n] = decodeCompactU16(bytes, index);
      const [writableIndexes, o] = readBytes(bytes, n, writableCount, `lookup ${i} writable indexes`);
      index = o;
      const [readonlyCount, p] = decodeCompactU16(bytes, index);
      const [readonlyIndexes, q] = readBytes(bytes, p, readonlyCount, `lookup ${i} readonly indexes`);
      index = q;
      addressTableLookups.push({
        accountKey: encodeBase58(tableKey),
        writableIndexes: [...writableIndexes],
        readonlyIndexes: [...readonlyIndexes],
      });
    }
  }

  return {
    next: index,
    message: {
      version: versioned ? 'v0' : 'legacy',
      header: { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts },
      accountKeys,
      recentBlockhash,
      instructions,
      addressTableLookups,
    },
  };
}

/**
 * Parse the V1 message. Its layout differs from V0 in every count and in the
 * position of the blockhash, so it gets its own reader instead of a flag.
 */
function parseV1Message(bytes, offset) {
  let index = offset;
  if (bytes[index] !== VERSION_1_PREFIX) refuse('wire-unsupported-version', `message prefix 0x${bytes[index].toString(16)} is not v1`);
  index += 1;

  const [numRequiredSignatures, a] = readU8(bytes, index, 'numRequiredSignatures');
  const [numReadonlySignedAccounts, b] = readU8(bytes, a, 'numReadonlySignedAccounts');
  const [numReadonlyUnsignedAccounts, c] = readU8(bytes, b, 'numReadonlyUnsignedAccounts');
  index = c;

  const [configMask, d] = readU32Le(bytes, index, 'configMask');
  index = d;
  if ((configMask & ~0b11111) !== 0) refuse('wire-config-mask', `unexpected bits set in the transaction config mask (0x${configMask.toString(16)})`);
  const priorityFeeBits = configMask & CONFIG_MASK_PRIORITY_FEE_BITS;
  if (priorityFeeBits !== 0 && priorityFeeBits !== CONFIG_MASK_PRIORITY_FEE_BITS) {
    refuse('wire-config-mask', 'expected both or neither of the priority fee bits to be set');
  }

  const [blockhashBytes, e] = readBytes(bytes, index, PUBLIC_KEY_LENGTH, 'recentBlockhash');
  index = e;
  const recentBlockhash = encodeBase58(blockhashBytes);

  const [instructionCount, f] = readU8(bytes, index, 'instructionCount');
  index = f;
  const [staticAccountKeysLength, g] = readU8(bytes, index, 'staticAccountKeysLength');
  index = g;
  const accountKeys = [];
  for (let i = 0; i < staticAccountKeysLength; i += 1) {
    const [key, next] = readBytes(bytes, index, PUBLIC_KEY_LENGTH, `static account key ${i}`);
    accountKeys.push(encodeBase58(key));
    index = next;
  }

  const transactionConfig = {
    computeUnitLimit: null,
    heapSize: null,
    loadedAccountsDataSizeLimit: null,
    priorityFee: null,
  };
  if (priorityFeeBits !== 0) {
    const [fee, next] = readU64Le(bytes, index, 'priorityFee');
    index = next;
    transactionConfig.priorityFee = fee;
  }
  if (configMask & CONFIG_MASK_COMPUTE_UNIT_LIMIT_BIT) {
    const [limit, next] = readU32Le(bytes, index, 'computeUnitLimit');
    index = next;
    transactionConfig.computeUnitLimit = limit;
  }
  if (configMask & CONFIG_MASK_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT) {
    const [limit, next] = readU32Le(bytes, index, 'loadedAccountsDataSizeLimit');
    index = next;
    transactionConfig.loadedAccountsDataSizeLimit = limit;
  }
  if (configMask & CONFIG_MASK_HEAP_SIZE_BIT) {
    const [heap, next] = readU32Le(bytes, index, 'heapSize');
    index = next;
    transactionConfig.heapSize = heap;
  }

  // The instruction headers come first (programIdIndex, account count, data
  // length), then the bodies — the V1 layout, not the V0 one. The data
  // length is a u16 LE (b0 + b1*256 in the upstream reader), NOT a u8 like
  // its neighbours: reading it as one byte left every payload one byte short.
  const headers = [];
  for (let i = 0; i < instructionCount; i += 1) {
    const [programIdIndex, h] = readU8(bytes, index, `instruction ${i} programIdIndex`);
    const [accountIndexCount, j] = readU8(bytes, h, `instruction ${i} account count`);
    const [dataLengthLo, k0] = readU8(bytes, j, `instruction ${i} data length`);
    const [dataLengthHi, k] = readU8(bytes, k0, `instruction ${i} data length high byte`);
    headers.push({ programIdIndex, accountIndexCount, dataLength: dataLengthLo + dataLengthHi * 256 });
    index = k;
  }
  const instructions = [];
  for (const [i, header] of headers.entries()) {
    const [accountIndexes, m] = readBytes(bytes, index, header.accountIndexCount, `instruction ${i} account indexes`);
    index = m;
    const [data, n] = readBytes(bytes, index, header.dataLength, `instruction ${i} data`);
    index = n;
    instructions.push({
      programIdIndex: header.programIdIndex,
      accounts: [...accountIndexes],
      data: encodeBase58(data),
    });
  }

  return {
    next: index,
    message: {
      version: 'v1',
      header: { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts },
      accountKeys,
      recentBlockhash,
      instructions,
      addressTableLookups: [],
      transactionConfig,
    },
  };
}

/**
 * Parse one transaction's wire bytes into the shape the product's payload
 * extractor understands.
 *
 * The returned object mirrors an RPC `encoding: "json"` transaction:
 *   { transaction: { message: { accountKeys, instructions, header, recentBlockhash } },
 *     meta, signature, version }
 * so `tools/lib/payloads.mjs` can read it unchanged.
 *
 * @param {Buffer} bytes the transaction wire bytes
 * @returns {{transaction: object, meta: object, signature: string|null, version: string|number}}
 */
export function parseWireTransaction(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) refuse('wire-empty', 'no transaction bytes');

  let signature = null;
  let version;
  let message;

  if (bytes[0] === VERSION_1_PREFIX) {
    // V1 framing: MESSAGE first, signatures appended at the end, and the
    // signature count is a raw u8 at offset 1.
    const [numRequiredSignatures, a] = readU8(bytes, 1, 'numRequiredSignatures');
    const messageLength = bytes.length - numRequiredSignatures * SIGNATURE_LENGTH;
    if (messageLength <= 0) refuse('wire-signatures-truncated', 'the transaction carries no message bytes');
    const parsed = parseV1Message(bytes, 0);
    message = parsed.message;
    // The RPC reports v1 as the number 1 (v0 as 0, legacy as "legacy").
    version = 1;
    const signatureBytes = bytes.subarray(messageLength, messageLength + SIGNATURE_LENGTH);
    if (signatureBytes.length === SIGNATURE_LENGTH) signature = encodeBase58(signatureBytes);
    if (parsed.next !== messageLength) {
      refuse('wire-layout-mismatch', `the v1 message ends at ${parsed.next} but the framing expects ${messageLength}`);
    }
    const messageSlice = bytes.subarray(0, messageLength);
    const sigs = [];
    for (let i = 0; i < numRequiredSignatures; i += 1) {
      const start = messageLength + i * SIGNATURE_LENGTH;
      sigs.push(encodeBase58(bytes.subarray(start, start + SIGNATURE_LENGTH)));
    }
    requireValidSignatures(messageSlice, sigs, message.accountKeys, numRequiredSignatures);
    void a;
  } else {
    // V0/legacy framing: compact-u16 signature count, signatures, message.
    const [signatureCount, consumed] = decodeCompactU16(bytes, 0);
    let index = consumed;
    const signatures = [];
    for (let i = 0; i < signatureCount; i += 1) {
      const [sig, next] = readBytes(bytes, index, SIGNATURE_LENGTH, `signature ${i}`);
      signatures.push(encodeBase58(sig));
      index = next;
    }
    const parsed = parseLegacyMessage(bytes, index);
    message = parsed.message;
    // The RPC reports v1 as the number 1, v0 as 0, legacy as "legacy".
    version = message.version === 'v0' ? 0 : 'legacy';
    signature = signatures[0] ?? null;
    const messageSlice = bytes.subarray(index);
    requireValidSignatures(messageSlice, signatures, message.accountKeys, message.header.numRequiredSignatures);
  }

  return {
    version,
    signature,
    transaction: {
      message: {
        accountKeys: message.accountKeys,
        header: message.header,
        instructions: message.instructions,
        recentBlockhash: message.recentBlockhash,
        ...(message.transactionConfig ? { transactionConfig: message.transactionConfig } : {}),
      },
    },
    meta: { err: null, innerInstructions: [] },
  };
}

/**
 * Normalize ONE entry of an RPC `encoding: "base64"` response.
 *
 * The RPC returns the transaction as a two-element array:
 *   ["<base64 wire bytes>", "base64"]
 * for getBlock (transaction entries) and getTransaction alike. The meta
 * (inner instructions, loaded addresses) is a sibling of the transaction, not
 * part of it — the wire bytes carry the OUTER instructions only, the inner
 * ones arrive as base58 in the meta.
 *
 * @param {object} entry one entry of `result.transactions` (or a getTransaction result)
 * @returns {{transaction: object, meta: object, signature: string|null, version: string|number}}
 */
export function normalizeRpcWireTransaction(entry) {
  const raw = entry?.transaction;
  if (!Array.isArray(raw) || raw.length < 1 || typeof raw[0] !== 'string') {
    refuse('wire-not-base64', 'the transaction is not a base64 wire payload (expected ["<base64>", "base64"])');
  }
  let bytes;
  try {
    bytes = Buffer.from(raw[0], 'base64');
  } catch (error) {
    refuse('wire-not-base64', `the base64 payload could not be read: ${String(error?.message ?? error).slice(0, 120)}`);
  }
  if (!bytes.length) refuse('wire-not-base64', 'the base64 payload decodes to zero bytes');

  const parsed = parseWireTransaction(bytes);
  const meta = entry?.meta ?? {};
  // The wire carries the outer instructions; the meta carries the inner ones
  // (base58, already parsed by the chain's own RPC layer).
  parsed.meta = {
    ...meta,
    innerInstructions: meta.innerInstructions ?? [],
    loadedAddresses: meta.loadedAddresses ?? {},
  };
  return parsed;
}

/**
 * The same, for a whole RPC response document.
 *
 * Accepts what an archive or a foreign repo actually holds:
 *   - a getBlock response: { result: { transactions: [...] } }
 *   - a getTransaction response: { result: { transaction: [...], meta } }
 *   - a bare array of transactions
 *
 * @param {object} document
 * @returns {{transactions: object[], source: string}}
 */
/**
 * Normalize ONE transaction of the FLATTENED dialect — measured on
 * step-finance-oss/step-ingestooor (MIT) on 2026-11-04: 37 of that repo's
 * 156 fixture files hold the transaction FLATTENED, i.e. `instructions` and
 * `accounts` sit at the FILE level and `transaction.message` keeps only the
 * blockhash (or is absent entirely). The chain's own parser produced these
 * files; a foreign repo stores what IT received.
 *
 * The dialect carries the same information as the standard one:
 *   - instruction `data` as base58, `programId` spelled out,
 *   - `accounts` at file level: the account list (pubkey/signer/writable/
 *     source), the same list the standard dialect keeps in
 *     `message.accountKeys`,
 *   - inner instructions under `meta.innerInstructions`.
 *
 * What this dialect does NOT carry: the `message` shell, the address-table
 * lookups, and the signatures (only `signature` at file level). So no
 * signature claim is made here either — the same limit as the json path.
 *
 * The account list is what the payload extractor resolves program ids and
 * account indexes against, so it is rebuilt from the file-level `accounts`
 * into the standard `message.accountKeys` shape. Instructions the chain
 * already parsed carry no `data` field: they are counted by name
 * (`chainParsed`), never decoded as empty payloads.
 *
 * @param {object} entry one flattened transaction document
 * @returns {{transaction: object, meta: object, signature: string|null,
 *            version: string|number, chainParsed: number}}
 */
export function normalizeFlatTransaction(entry) {
  const instructions = entry?.instructions;
  if (!Array.isArray(instructions)) {
    refuse('flat-not-a-transaction', 'the entry carries no instructions (is this a flattened transaction document?)');
  }
  const rawAccounts = entry.accounts;
  if (rawAccounts !== undefined && !Array.isArray(rawAccounts)) {
    refuse('flat-accounts-malformed', 'accounts is present but not an array');
  }
  const accountKeys = (rawAccounts ?? []).map((account) => {
    if (typeof account === 'string') return account;
    if (account && typeof account === 'object' && typeof account.pubkey === 'string') return account.pubkey;
    return null;
  }).filter(Boolean);
  const message = entry?.transaction?.message ?? {};
  let chainParsed = 0;
  const countParsed = (list) => {
    for (const instruction of list ?? []) {
      if (instruction && typeof instruction === 'object' && !('data' in instruction)) chainParsed += 1;
    }
  };
  countParsed(instructions);
  for (const group of entry?.meta?.innerInstructions ?? []) countParsed(group?.instructions);
  return {
    transaction: {
      message: {
        accountKeys,
        header: message.header ?? null,
        instructions,
        recentBlockhash: message.recentBlockhash ?? entry?.recentBlockhash ?? null,
        ...(Array.isArray(message.addressTableLookups) ? { addressTableLookups: message.addressTableLookups } : {}),
      },
    },
    meta: {
      ...(entry?.meta ?? {}),
      innerInstructions: entry?.meta?.innerInstructions ?? [],
      loadedAddresses: { writable: [], readonly: [] },
    },
    signature: typeof entry?.signature === 'string' ? entry.signature : null,
    version: entry?.version ?? 'legacy',
    chainParsed,
  };
}

export function transactionsFromRpcDocument(document) {
  const result = document?.result;
  if (Array.isArray(result?.transactions)) return { transactions: result.transactions, source: 'getBlock' };
  if (result?.transaction) return { transactions: [result], source: 'getTransaction' };
  // A BARE getTransaction result, without the RPC envelope — the shape a
  // foreign repository's own test fixtures hold (measured on
  // step-finance-oss/step-ingestooor and CryptGodSon/Solana-Explorer:
  // { blockTime, slot, meta, transaction: { message, signatures } }). The
  // same bare result in the base64 shape (transaction: [b64, "base64"]) is
  // accepted; the per-entry encoding detection decides which parser runs.
  if (document?.transaction?.message || Array.isArray(document?.transaction)) {
    return { transactions: [document], source: 'getTransaction-result' };
  }
  // The FLATTENED dialect (measured on step-finance-oss/step-ingestooor, MIT,
  // 2026-11-04): the transaction's instructions and its account list sit at
  // the file level, and `transaction.message` keeps only the blockhash (or is
  // absent). A foreign repo stores what the chain's parser handed it.
  if (Array.isArray(document?.instructions)) {
    return { transactions: [document], source: 'flattened-transaction' };
  }
  if (Array.isArray(document?.transactions)) return { transactions: document.transactions, source: 'array' };
  if (Array.isArray(document)) return { transactions: document, source: 'array' };
  refuse('not-an-rpc-response', 'no RPC result found (expected result.transactions, result.transaction, a bare transaction result, or a transactions array)');
}

/**
 * Normalize ONE transaction of an RPC `encoding: "json"` response — the
 * shape a foreign repository's OWN test fixtures hold (measured on
 * step-finance-oss/step-ingestooor and CryptGodSon/Solana-Explorer,
 * 2026-11-04): the chain's parser has already split the wire into fields,
 * instruction `data` arrives as base58, every instruction carries its
 * `programId` spelled out, and inner instructions live under `meta`.
 *
 * The document holds NO bytes to verify a signature against, so this path
 * makes no verification CLAIM — that is what the base64 path is for. What it
 * does enforce is the parts the decode depends on:
 *   - the account list must resolve (static keys, then loadedAddresses); a
 *     document that resolves an instruction by an index beyond that list is
 *     refused instead of silently attributing the payload to nothing,
 *   - the reported version is passed through unchanged,
 *   - an instruction the chain already `parsed` carries NO bytes: it is
 *     counted by name (`chainParsed`), never fed to the decoder as empty.
 *
 * Note on address tables: in this encoding the lookup-table keys are usually
 * ALREADY EXPANDED inside `message.accountKeys` (entries with
 * `source: "lookupTable"`, measured on both foreign repos), so requiring
 * `meta.loadedAddresses` would refuse real documents. The guard fires only
 * when an instruction actually resolves by an index the key list cannot
 * cover.
 *
 * @param {object} entry one transaction of a `encoding:"json"` response
 * @returns {{transaction: object, meta: object, signature: string|null,
 *            version: string|number, chainParsed: number}}
 */
export function normalizeRpcJsonTransaction(entry) {
  const message = entry?.transaction?.message;
  if (!message || !Array.isArray(message.instructions)) {
    refuse('json-not-a-transaction', 'the entry carries no transaction.message.instructions (is this an encoding:"json" getTransaction result?)');
  }
  if (!Array.isArray(message.accountKeys) || message.accountKeys.length === 0) {
    refuse('json-account-keys-missing', 'message.accountKeys is missing or empty — instruction indexes cannot resolve');
  }
  const staticKeys = message.accountKeys.map((key) => (typeof key === 'string' ? key : key?.pubkey)).filter(Boolean);
  const loaded = entry.meta?.loadedAddresses ?? {};
  if (loaded.writable !== undefined && !Array.isArray(loaded.writable)) {
    refuse('json-loaded-addresses', 'meta.loadedAddresses.writable is present but not an array');
  }
  if (loaded.readonly !== undefined && !Array.isArray(loaded.readonly)) {
    refuse('json-loaded-addresses', 'meta.loadedAddresses.readonly is present but not an array');
  }
  const resolved = staticKeys.length + (loaded.writable?.length ?? 0) + (loaded.readonly?.length ?? 0);
  const declaredVersion = entry.version ?? 'legacy';
  // An instruction that names its program by INDEX needs the key list to
  // cover that index; refusing beats attributing the payload to nothing.
  const checkIndex = (instructions) => {
    for (const instruction of instructions ?? []) {
      const index = instruction?.programIdIndex;
      if (Number.isSafeInteger(index) && index >= resolved) {
        refuse('json-index-unresolvable', `programIdIndex ${index} is beyond the ${resolved} resolvable account keys and the document spells out no programId`);
      }
    }
  };
  checkIndex(message.instructions);
  for (const group of entry.meta?.innerInstructions ?? []) checkIndex(group?.instructions);
  // Count, per transaction, how many instructions the chain already parsed:
  // those rows exist in the document WITHOUT their bytes, so the decoder must
  // never see them (an empty payload is not a transfer of nothing — it is a
  // missing document field).
  let chainParsed = 0;
  const countParsed = (instructions) => {
    for (const instruction of instructions ?? []) {
      if (instruction && typeof instruction === 'object' && !('data' in instruction)) chainParsed += 1;
    }
  };
  countParsed(message.instructions);
  for (const group of entry.meta?.innerInstructions ?? []) countParsed(group?.instructions);
  return {
    transaction: {
      message: {
        accountKeys: staticKeys,
        header: message.header ?? null,
        instructions: message.instructions,
        recentBlockhash: message.recentBlockhash ?? null,
        ...(Array.isArray(message.addressTableLookups) ? { addressTableLookups: message.addressTableLookups } : {}),
      },
    },
    meta: {
      ...(entry.meta ?? {}),
      innerInstructions: entry.meta?.innerInstructions ?? [],
      loadedAddresses: { writable: loaded.writable ?? [], readonly: loaded.readonly ?? [] },
    },
    signature: entry.transaction.signatures?.[0] ?? null,
    version: declaredVersion,
    chainParsed,
  };
}
