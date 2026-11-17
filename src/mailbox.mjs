// The mailbox reader that SHIPS — reading a reeflog journal into payload
// records, with reeflog's retraction contract honoured.
//
// Why this file exists (2026-11-17)
// ---------------------------------
// The logic below lived only in `tools/harvest-reeflog.mjs`, and `tools/` is
// excluded from the npm `files` allowlist on purpose (the qualification
// harness is not a consumer's business). The consequence was measured on the
// channel a stranger actually installs, `sememe@0.4.33`:
//
//   the subpath "sememe/mailbox" -> ERR_PACKAGE_PATH_NOT_EXPORTED
//   the package entry          -> no mailbox/reeflog/harvest export at all
//
// so a consumer who held BOTH published packages — `reeflog-client` for the
// mailbox and `sememe` for the decoder — had no way to join them without
// cloning this repository. The integration itself was never the problem:
// measured 2026-11-17 with `reeflog-client@0.7.32` + `sememe@0.4.33` installed
// from npm into an empty app, against a real 2,417-event mainnet-beta
// journal: 63 events delivered, 1,307 instructions, 71 for the pinned
// program, 71/71 decoded and 71/71 byte-exact — every line of it running from
// a checkout. The capability was reachable only by me.
//
// The contract this module keeps
// ------------------------------
// reeflog delivers two independent signals that the chain unmade an event
// (`src/main.rs`, `run_reorg_tail`): `tail` prints each row's CURRENT seal,
// `reorg tail` prints the retraction itself on its own cursor. The seal is a
// snapshot taken while the row is read, so a retraction recorded afterwards
// never appears in it — that is why the second channel exists at all.
//
//   * a row whose seal is `reverted` is never a transaction, signature or
//     payload;
//   * a signature the retraction channel names is never one either, whatever
//     the row's seal says;
//   * both are NAMED in the counts rather than dropped, and `reorgOnly`
//     distinguishes "the channel said so after the fact";
//   * the reader reports whether it read the channel at all. A caller that
//     never asked must not be able to claim it honoured a retraction —
//     `channelRead` is false unless the caller says it read it;
//   * a seal that says nothing (absent, null, `confirmed`, `finalized`,
//     `error`, `missing`) still harvests: reading `reverted` where the row
//     says nothing would be the same lie in the other direction.
//
// Everything else is debt, not silence: a row the mailbox has not enriched,
// an envelope carrying no instructions, a transaction with no payload for the
// program — each gets its own counter so a shortfall can never pass as a
// clean run.
//
// Pure: no process is spawned, no file is read, no network is touched. The
// transport is `reeflog-client`'s (or the `reeflog` binary's); this module is
// the part that must not differ between the harness and the consumer, which
// is why `tools/harvest-reeflog.mjs` calls it instead of keeping a copy.

import { decodeBase58 } from './base58.mjs';

/**
 * Instruction data arrives as base58 from both sources (the RPC's `encoding:
 * json`, reeflog's envelope); the codec and the fixtures speak hex. Convert
 * once at the edge with this repository's own decoder — no third-party import.
 */
export function toHex(data) {
  if (typeof data !== 'string' || !data.length) return '';
  return Buffer.from(decodeBase58(data)).toString('hex');
}

/**
 * Payload records from a reeflog account envelope (`instructions` in
 * `src/accounts.rs`): program ids already resolved against the canonical
 * account list, base58 data verbatim, outer and inner instructions in
 * execution order, `outer` naming the parent of a CPI and `inner_index` its
 * position inside it.
 *
 * The records are IDENTICAL in shape and key order to what the network
 * harvester produces for the same transaction — callers compare payload sets
 * with `JSON.stringify`, so key order is part of the contract, not a detail.
 * The equivalence itself is pinned by `test/harvest-reeflog.test.mjs`.
 *
 * A malformed envelope yields FEWER payloads, never wrong ones: an instruction
 * whose `program_id` or `data` is not a string cannot be matched or decoded,
 * so it is skipped — and the caller's counts then show the shortfall instead
 * of a fabricated byte.
 *
 * @param {object|null} envelope the `accounts` field of a `tail` row
 * @param {string} target program id to collect
 * @returns {object[]} payload records { ix, depth, innerIndex?, dataBase58, dataHex }
 */
export function payloadsFromEnvelope(envelope, target) {
  const payloads = [];
  const instructions = envelope?.instructions;
  if (!Array.isArray(instructions)) return payloads;
  for (const instruction of instructions) {
    if (!instruction || instruction.program_id !== target) continue;
    const data = typeof instruction.data === 'string' ? instruction.data : '';
    if (instruction.inner === true) {
      payloads.push({
        ix: Number.isSafeInteger(instruction.outer) ? instruction.outer : 0,
        depth: 1,
        innerIndex: Number.isSafeInteger(instruction.inner_index) ? instruction.inner_index : 0,
        dataBase58: data,
        dataHex: toHex(data),
      });
    } else {
      payloads.push({
        ix: Number.isSafeInteger(instruction.outer) ? instruction.outer : 0,
        depth: 0,
        dataBase58: data,
        dataHex: toHex(data),
      });
    }
  }
  return payloads;
}

/**
 * Read `tail` rows + `reorg tail` records into payload records for one
 * program, honouring both retraction signals.
 *
 * Pure and synchronous: the caller obtains `rows` (a `reeflog tail` JSONL
 * parse) and `retractions` (a `reeflog reorg tail` JSONL parse) from
 * whichever transport it uses — `reeflog-client`, the binary, a fixture —
 * and this function decides what those rows mean.
 *
 * @param {object} input
 * @param {object[]} input.rows        parsed rows of `reeflog tail`
 * @param {object[]} [input.retractions] parsed records of `reeflog reorg tail`
 * @param {string}   input.program     program id to collect payloads for
 * @param {boolean}  [input.channelRead] true only when the caller really did
 *        read the retraction channel (with its own cursor) — reported back as
 *        `counts.channelRead` so a consumer can see whether the retraction
 *        contract was actually exercised
 * @returns {{ transactions: object[], counts: object }}
 */
export function mailboxTransactions({ rows, retractions = [], program, channelRead = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const channel = Array.isArray(retractions) ? retractions : [];

  const reorgSignatures = new Set();
  for (const record of channel) {
    if (record && typeof record.signature === 'string') reorgSignatures.add(record.signature);
  }

  const transactions = [];
  const revertedSignatures = [];
  const reorgOnlySignatures = [];
  let rowsReverted = 0;
  let rowsWithoutEnvelope = 0;
  let rowsWithoutInstructions = 0;
  let rowsWithoutTargetPayloads = 0;

  for (const row of list) {
    if (!row) continue;
    // Both signals decide FIRST: a row the chain unmade is not a payload
    // source, and it is not an envelope debt `hydrate --accounts` could ever
    // close either — the chain no longer knows the transaction.
    const revertedBySeal = row.seal === 'reverted';
    const revertedByChannel = typeof row.signature === 'string' && reorgSignatures.has(row.signature);
    if (revertedBySeal || revertedByChannel) {
      rowsReverted++;
      if (typeof row.signature === 'string') revertedSignatures.push(row.signature);
      if (revertedByChannel && !revertedBySeal) reorgOnlySignatures.push(row.signature);
      continue;
    }
    const envelope = row.accounts && typeof row.accounts === 'object' ? row.accounts : null;
    if (!envelope) { rowsWithoutEnvelope++; continue; }
    if (!Array.isArray(envelope.instructions)) { rowsWithoutInstructions++; continue; }
    const payloads = payloadsFromEnvelope(envelope, program);
    if (!payloads.length) rowsWithoutTargetPayloads++;
    transactions.push({
      signature: row.signature,
      slot: Number.isSafeInteger(row.slot) ? row.slot : null,
      position: null, // a journal row has no block position; the network harvester has one
      txErr: envelope.err !== undefined ? envelope.err : (row.err ?? null),
      missing: false,
      payloads,
    });
  }

  const payloadCount = transactions.reduce((sum, t) => sum + t.payloads.length, 0);
  const withTarget = transactions.filter((t) => t.payloads.length > 0);

  return {
    transactions,
    counts: {
      journalRows: list.length,
      requested: list.length,
      pinnedSignatures: transactions.length,
      fetched: transactions.length,
      missing: 0,
      transactionsWithTargetPayloads: withTarget.length,
      payloads: payloadCount,
      failedOnChain: transactions.filter((t) => t.txErr).length,
      transactionsWithoutTarget: rowsWithoutTargetPayloads,
      // Debt, named: rows the mailbox has not enriched, envelopes that cannot
      // yield payloads, and rows the chain withdrew.
      rowsWithoutEnvelope,
      rowsWithoutInstructions,
      rowsReverted,
      revertedSignatures,
      // The retraction channel's own account: how many RECORDS it delivered,
      // and which signatures it withdrew that the row's seal had not. The
      // record count is the channel's delivery; the signature set is what
      // the rows are matched against.
      reorgRetractions: channel.length,
      reorgOnlySignatures,
      // Whether the caller read the retraction channel at all. Never true
      // unless asked — silence must not read as "honoured".
      channelRead: channelRead === true,
    },
  };
}
