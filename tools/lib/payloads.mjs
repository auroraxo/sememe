// Pure payload extraction, shared by the harvesters and the tests.
//
// Kept separate from the network code so the logic that decides WHICH bytes
// become fixture records can be tested without touching the network: a
// mistake here silently produces a fixture that measures the wrong thing.
//
// The RPC response shapes differ between calls, and both are handled here:
//   - getTransaction / getBlock with encoding:"json" return instructions as
//     { programIdIndex, accounts, data, stackHeight }. The program id is NOT
//     spelled out: it must be resolved against the transaction's account list,
//     which is the static keys followed by the address lookup table entries
//     (static, then loaded writable, then loaded readonly).
//   - older/other encodings may spell out `programId` directly.
// Ignoring either case would silently produce an EMPTY payload list and a
// fixture that measures nothing while looking successful.

import { decodeBase58 } from '../../src/base58.mjs';

/**
 * RPC `encoding: 'json'` yields instruction data as base58; the fixtures and
 * the codec speak hex, so convert once at the edge with the repo's own
 * decoder (same bytes, no third-party import).
 */
export function toHex(data) {
  if (typeof data !== 'string' || !data.length) return '';
  return Buffer.from(decodeBase58(data)).toString('hex');
}

/**
 * All account keys of one transaction, in the order the indices refer to:
 * static keys first, then address lookup table entries (writable, then
 * readonly). Returns `[]` when the shape is not understood, so a caller can
 * treat an unresolvable transaction as "no payloads" instead of guessing.
 */
export function accountKeyList(transaction) {
  const message = transaction?.transaction?.message;
  const meta = transaction?.meta ?? {};
  const raw = message?.accountKeys;
  if (!Array.isArray(raw)) return [];
  const staticKeys = raw.map((key) => (typeof key === 'string' ? key : key?.pubkey)).filter(Boolean);
  const loaded = meta.loadedAddresses ?? {};
  return [
    ...staticKeys,
    ...(Array.isArray(loaded.writable) ? loaded.writable : []),
    ...(Array.isArray(loaded.readonly) ? loaded.readonly : []),
  ];
}

/** The program id an instruction invokes, or null when it cannot be resolved. */
export function programIdOf(instruction, accounts) {
  if (!instruction) return null;
  if (typeof instruction.programId === 'string') return instruction.programId;
  const index = instruction.programIdIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index >= accounts.length) return null;
  return accounts[index] ?? null;
}

/**
 * Every instruction of `target` in one decoded transaction, CPI included.
 *
 * Top-level instructions AND inner (CPI) instructions are collected: a
 * program invoked through a CPI is exactly as real as one invoked directly,
 * and dropping them would quietly understate how often the decoder is fed.
 *
 * Returns `[]` for a transaction that never invokes the target — that
 * transaction stays in the denominator instead of disappearing.
 *
 * @param {object} transaction getTransaction / getBlock transaction entry
 * @param {string} target program id to collect
 */
export function extractPayloads(transaction, target) {
  const payloads = [];
  const message = transaction?.transaction?.message;
  const meta = transaction?.meta ?? {};
  const accounts = accountKeyList(transaction);

  const topLevel = message?.instructions ?? [];
  for (const [index, instruction] of topLevel.entries()) {
    if (programIdOf(instruction, accounts) !== target) continue;
    payloads.push({
      ix: index,
      depth: 0,
      dataBase58: instruction.data ?? '',
      dataHex: toHex(instruction.data),
    });
  }

  // Inner instructions live under meta in the JSON encoding.
  const innerGroups = meta.innerInstructions ?? message?.innerInstructions ?? [];
  for (const group of innerGroups) {
    for (const [position, instruction] of (group?.instructions ?? []).entries()) {
      if (programIdOf(instruction, accounts) !== target) continue;
      payloads.push({
        ix: group?.index ?? 0,
        depth: group?.depth ?? 1,
        innerIndex: position,
        dataBase58: instruction.data ?? '',
        dataHex: toHex(instruction.data),
      });
    }
  }
  return payloads;
}
