// Conformance of a WHOLE TRANSACTION against the stored interfaces.
//
// `src/account-list.mjs` answers "does this account list match this
// instruction's declaration". This file answers "what does the stored
// interface say about every instruction of this transaction", using the
// same verified store the decoder uses.
//
// The transaction shape is the RPC `encoding: "json"` shape (getTransaction
// or getBlock), because that is what a consumer has. Two facts of that shape
// matter and are easy to get wrong:
//
//   - `message.accountKeys` holds only addresses. The SIGNER and WRITABLE
//     flags live in `message.header` as COUNTS, in the canonical order
//         [signers-writable, signers-readonly, non-signers-writable,
//      non-signers-readonly]
//     and the loaded (address-lookup-table) addresses follow, writable
//     first. Reading the flags off the key objects — as many tools do when
//     they use the `jsonParsed` encoding — is a DIFFERENT shape; this file
//     handles the `json` shape and says so when the shape is not one it
//     understands.
//   - an instruction's `accounts` are INDICES into that key list, not
//     addresses. Resolving them wrongly turns a signer question into a
//     no-op.
//
// When the shape cannot be understood (no header, no account keys, an
// encoding this file does not model), the transaction is REFUSED with a
// named reason instead of being reported as "conforms". An unknown shape
// must never be reported as a clean bill of health.

import { checkAccountList, instructionByDiscriminator, declaredAccounts, summarizeConformance } from './account-list.mjs';
import { withDerivedDiscriminators } from './discriminators.mjs';
import { findStoredIdls } from './store-read.mjs';
import { isProgramId } from './program-id.mjs';

export class ConformanceRefusal extends Error {
  constructor(reason, detail = '') {
    super(`conformance refused: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.name = 'ConformanceRefusal';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * The canonical key list of a transaction, with each key's signer and
 * writable flags derived from the message header.
 *
 * @returns {{ keys: Array<{address: string, signer: boolean, writable: boolean}>, byIndex: Array }}
 */
export function transactionKeys(transaction) {
  const message = transaction?.transaction?.message;
  const meta = transaction?.meta ?? {};
  if (!message || !Array.isArray(message.accountKeys)) {
    throw new ConformanceRefusal('unreadable-transaction', 'no transaction.message.accountKeys');
  }
  const header = message.header;
  if (!header || !Number.isSafeInteger(header.numRequiredSignatures)) {
    throw new ConformanceRefusal('unreadable-transaction', 'no message.header (jsonParsed encoding or a truncated response)');
  }
  const readonlySigned = Number.isSafeInteger(header.numReadonlySignedAccounts) ? header.numReadonlySignedAccounts : 0;
  const readonlyUnsigned = Number.isSafeInteger(header.numReadonlyUnsignedAccounts) ? header.numReadonlyUnsignedAccounts : 0;

  const addresses = message.accountKeys.map((key) => (typeof key === 'string' ? key : key?.pubkey));
  if (addresses.some((address) => typeof address !== 'string' || !address)) {
    throw new ConformanceRefusal('unreadable-transaction', 'account key without an address');
  }

  const staticCount = addresses.length;
  const loaded = meta.loadedAddresses ?? {};
  const loadedWritable = Array.isArray(loaded.writable) ? loaded.writable : [];
  const loadedReadonly = Array.isArray(loaded.readonly) ? loaded.readonly : [];
  const all = [...addresses, ...loadedWritable, ...loadedReadonly];

  const keys = all.map((address, index) => {
    let signer = false;
    let writable = false;
    if (index < staticCount) {
      signer = index < header.numRequiredSignatures;
      const signerWritableCount = header.numRequiredSignatures - readonlySigned;
      if (signer) writable = index < signerWritableCount;
      else writable = index < header.numRequiredSignatures + readonlyUnsigned;
    } else {
      writable = index < staticCount + loadedWritable.length;
    }
    return { address, signer, writable };
  });

  return { keys, byIndex: keys };
}

/** The program id an instruction invokes, resolved against the key list. */
export function programIdOf(instruction, keys) {
  if (!instruction) return null;
  if (typeof instruction.programId === 'string') return instruction.programId;
  const index = instruction.programIdIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index >= keys.length) return null;
  return keys[index].address;
}

/** Every instruction of the transaction (top level and CPI), with the
 * account list resolved to addresses + flags. */
export function transactionInstructions(transaction) {
  const message = transaction?.transaction?.message;
  const meta = transaction?.meta ?? {};
  const { keys } = transactionKeys(transaction);
  const out = [];

  const push = (instruction, depth, position, parentIndex) => {
    const accounts = Array.isArray(instruction?.accounts) ? instruction.accounts : [];
    const resolved = accounts.map((index) => {
      const key = keys[index];
      return key
        ? { address: key.address, signer: key.signer, writable: key.writable }
        : { address: null, signer: null, writable: null };
    });
    out.push({
      depth,
      position,
      parentIndex,
      programId: programIdOf(instruction, keys),
      accounts: resolved,
      accountIndices: accounts.slice(),
      dataBase58: instruction?.data ?? '',
    });
  };

  (message?.instructions ?? []).forEach((instruction, index) => push(instruction, 0, index, null));
  const groups = meta.innerInstructions ?? message?.innerInstructions ?? [];
  for (const group of groups) {
    const parentIndex = group?.index ?? null;
    (group?.instructions ?? []).forEach((instruction, position) => push(instruction, group?.depth ?? 1, position, parentIndex));
  }
  return { instructions: out, keys };
}

/** The 8 discriminator bytes of an instruction's data, or null. */
export function discriminatorOf(dataBase58) {
  if (typeof dataBase58 !== 'string' || !dataBase58.length) return null;
  // base58 decode without a third-party import: the alphabet is fixed.
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const character of dataBase58) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value & 0xffn)); value >>= 8n; }
  for (const character of dataBase58) { if (character === '1') bytes.unshift(0); else break; }
  return bytes.length >= 8 ? bytes.slice(0, 8) : null;
}

/**
 * Check every instruction of a transaction against the interfaces stored for
 * the programs it invokes.
 *
 * WHAT THIS REFUSES (measured 2026-11-09 on the published v0.4.12 install):
 * a report over ZERO instructions used to exit 0 — a green CI gate over a
 * check that never ran. Two ways to get there, both silent:
 *
 *   * `--only <program>` where the program is never invoked by this
 *     transaction -> `rows: []`, `summary.instructions: 0`, exit 0, no
 *     disagreement reported, because there was nothing to disagree about;
 *   * `--only <not-a-program-id>` -> the same empty green, and the value
 *     could not even be a program id.
 *
 * The rule is the one this file already states for an unknown SHAPE: an
 * empty check is not a clean bill of health. When nothing can be checked,
 * the transaction (or the filter) is REFUSED with a named reason that
 * carries the repair — for a filter miss, the program ids the transaction
 * actually invokes, so a typo is visible instead of green.
 *
 * @param {object}   transaction  an RPC `encoding: "json"` transaction
 * @param {string}   storeDir     a sememe store directory
 * @param {object}   [options]
 * @param {string[]} [options.only]  restrict to these program ids
 * @returns {Promise<{ rows: object[], summary: object }>}
 * @throws {ConformanceRefusal} when the check would cover no instruction
 */
export async function checkTransaction(transaction, storeDir, options = {}) {
  const { only = null } = options;
  const { instructions } = transactionInstructions(transaction);
  const executed = transaction?.meta?.err === null || transaction?.meta?.err === undefined
    ? true
    : false;

  // Decide what CAN be checked before reading the store: an empty check is a
  // refusal, and the refusal must not depend on which interfaces happen to be
  // stored (that would make the verdict about the store, not about the filter).
  if (only !== null) {
    for (const entry of only) {
      if (!isProgramId(entry)) {
        throw new ConformanceRefusal(
          'filter-is-not-a-program-id',
          `${JSON.stringify(String(entry))} — a program id is 32 bytes in base58; ` + 'this filter can never match an instruction',
        );
      }
    }
  }
  const invoked = [...new Set(instructions.map((i) => i.programId).filter(Boolean))];
  const eligible = instructions.filter((i) => i.programId && (!only || only.includes(i.programId)));
  if (eligible.length === 0) {
    if (!instructions.length) {
      throw new ConformanceRefusal(
        'transaction-has-no-instruction',
        'the transaction exposes no instruction to check — nothing here can be reported as conforming',
      );
    }
    if (!invoked.length) {
      throw new ConformanceRefusal(
        'transaction-has-no-resolvable-program-id',
        `all ${instructions.length} instruction(s) lack a program id that resolves inside message.accountKeys — `
          + 'this shape cannot be checked',
      );
    }
    if (only) {
      throw new ConformanceRefusal(
        'filter-matched-no-instruction',
        `--only ${JSON.stringify(only)} selects none of this transaction's instructions; it invokes: ${invoked.join(', ')}`,
      );
    }
    throw new ConformanceRefusal('no-instruction-is-checkable', `the transaction invokes: ${invoked.join(', ')}`);
  }

  const rows = [];
  const idlCache = new Map();
  for (const instruction of instructions) {
    if (!instruction.programId) continue;
    if (only && !only.includes(instruction.programId)) continue;
    let idl = idlCache.get(instruction.programId);
    if (idl === undefined) {
      try {
        const sources = await findStoredIdls(storeDir, instruction.programId);
        idl = sources.primary?.idl ?? sources.secondary?.idl ?? null;
      } catch (error) {
        // THE READER'S REFUSAL IS NOT A VERDICT ABOUT THE TRANSACTION.
        //
        // findStoredIdls is the ONE store reader that refuses damage by name
        // (src/store-read.mjs): a receipt whose object no longer re-hashes to
        // its fingerprint, a receipt bound to another program, a missing
        // object, a malformed receipt, a rewritten origin. Swallowing that
        // here turned every refusal into `no-stored-interface` and the gate
        // exited 0 — measured 2026-11-10 on the order-engine fixture: a
        // tampered receipt made the transaction's REAL disagreement
        // (undeclared-signing-account) disappear behind 12
        // `no-stored-interface` rows and a green exit.
        //
        // Exactly ONE failure is not damage: the store holds no receipt for
        // this program (code `no-stored-idl`). That is an honest acquisition
        // gap and keeps its own verdict below. A missing store
        // (`no-sememe-store`) and every reader refusal are REFUSED by name,
        // carrying the reader's own message and the repair.
        const code = error?.code ?? null;
        if (code !== 'no-stored-idl') {
          const reason = code === 'no-sememe-store' ? 'no-sememe-store' : 'store-reader-refused';
          throw new ConformanceRefusal(
            reason,
            `${instruction.programId}: ${String(error?.message ?? error)} — ` +
              'the conformance gate cannot read this program from the store, so it cannot say the transaction conforms; ' +
              'repair: restore the receipt (re-run "sememe pull") or point --store at a verified store',
          );
        }
        idl = null;
      }
      idlCache.set(instruction.programId, idl);
    }
    const discriminator = discriminatorOf(instruction.dataBase58);
    if (!idl) {
      rows.push({
        program: instruction.programId,
        instruction: null,
        executed,
        depth: instruction.depth,
        verdict: 'no-stored-interface',
        violations: [],
        extras: [],
        notes: [],
        unknownSigner: [],
        positions: { declared: null, observed: instruction.accounts.length },
      });
      continue;
    }
    if (!discriminator) {
      rows.push({
        program: instruction.programId,
        instruction: null,
        executed,
        depth: instruction.depth,
        verdict: 'unknown-discriminator',
        violations: [],
        extras: [],
        notes: [],
        unknownSigner: [],
        positions: { declared: null, observed: instruction.accounts.length },
      });
      continue;
    }
    const { idl: filled } = withDerivedDiscriminators(idl);
    const match = instructionByDiscriminator(filled, discriminator);
    const result = checkAccountList(match, instruction.accounts, {
      program: instruction.programId,
      programId: instruction.programId,
      executed,
      depth: instruction.depth,
    });
    rows.push({
      ...result,
      depth: instruction.depth,
      accountCount: instruction.accounts.length,
      declaredAccountCount: match ? declaredAccounts(match).length : null,
      instructionNames: match ? match.name : null,
    });
  }

  const summary = summarizeConformance(rows);

  return { rows, summary };
}
