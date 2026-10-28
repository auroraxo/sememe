// Reproducible harvest of real mainnet transactions for one program.
//
// The point of this tool is that the fixture it produces can be re-derived by
// anyone: it stores the pinned signature list next to the extracted payloads,
// and `--from-signatures` re-fetches exactly those transactions and re-derives
// the payload bytes. A harvest that cannot be re-checked is just a file.
//
// Why blocks and not per-transaction calls: the public mainnet RPC
// hard-throttles `getTransaction` (measured: 9 of 120 batched requests
// succeeded, the rest answered 429), while `getBlock` returns hundreds of
// transactions in one call. Harvesting by block is therefore both faster and
// the only shape that reaches 1,000 transactions on a public endpoint.
//
// What it collects, per transaction:
//   - signature, slot, whether the transaction itself failed (meta.err)
//   - every instruction of the target program, including inner (CPI)
//     instructions, with the raw instruction data bytes
// A transaction that never invokes the target program is recorded with zero
// payloads rather than dropped, so the denominator stays honest.
//
// Usage:
//   node tools/harvest.mjs --program <program-id> --count 1000 --out <file.json>
//   node tools/harvest.mjs --from-signatures <file.json> --out <rederived.json>
//
// Public RPC only. Failed transactions are kept and marked: their instruction
// bytes are still the bytes that were submitted.

import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPayloads } from './lib/payloads.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const program = option('--program', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const count = Number(option('--count', '1000'));
const rpcUrl = option('--rpc', 'https://api.mainnet-beta.solana.com');
const outPath = option('--out', null);
const fromSignatures = option('--from-signatures', null);
const blocks = Number(option('--blocks', '0'));
const beforeSlot = option('--before-slot', null);

if (!outPath) { console.error('usage: node tools/harvest.mjs --out <file.json> [--program <id>] [--count N]'); process.exit(2); }
if (!/^https:\/\//.test(rpcUrl)) throw Error('HTTPS RPC URL required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let rpcId = 0;
class RpcExhausted extends Error {}

async function rpc(method, params) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let response;
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
    } catch (error) {
      if (attempt < 7) { await sleep(500 * (attempt + 1)); continue; }
      throw new RpcExhausted(`${method}: network error: ${String(error.message).slice(0, 120)}`);
    }
    if (response.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const body = await response.json().catch(() => null);
    if (!body) { if (attempt < 7) { await sleep(400 * (attempt + 1)); continue; } throw new RpcExhausted(`${method}: unreadable body`); }
    if (body.error) {
      // -32005 is "node is behind"; retrying is the standard answer.
      if (body.error.code === -32005 && attempt < 7) { await sleep(600 * (attempt + 1)); continue; }
      throw Error(`${method}: ${body.error.message}`);
    }
    return body.result;
  }
  throw new RpcExhausted(`${method}: RPC kept rate-limiting or falling behind`);
}

async function mapWithConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

/** One finalized block, with every transaction in it. */
async function fetchBlock(slot) {
  const block = await rpc('getBlock', [slot, {
    transactionDetails: 'full',
    encoding: 'json',
    maxSupportedTransactionVersion: 1,
    rewards: false,
    commitment: 'finalized',
  }]);
  if (!block) return null;
  return block.transactions ?? [];
}

/**
 * Choose blocks from the program's own signature page instead of walking the
 * tip blindly. The signature page already says which slots carry this
 * program's traffic, so the block reads are spent on blocks that can contain
 * payloads — walking the tip wastes most calls on blocks with none.
 */
/**
 * Choose blocks from the program's own signature page instead of walking the
 * tip blindly. The signature page already says which slots carry this
 * program's traffic, so the block reads are spent on blocks that can contain
 * payloads — walking the tip wastes most calls on blocks with none.
 *
 * Multiple pages are followed (older via `before`) when one page cannot
 * supply enough slots: one page of 1000 signatures yielded only 831 usable
 * entries across 243 slots, which capped the first run at 684 payload-bearing
 * transactions.
 */
async function collectSignaturePages(wanted) {
  const pinned = [];
  const seen = new Set();
  let before;
  for (let page = 0; page < 6 && pinned.length < wanted; page++) {
    const result = await rpc('getSignaturesForAddress', [program, {
      limit: 1000,
      ...(before ? { before } : {}),
    }]);
    if (!Array.isArray(result) || !result.length) break;
    for (const entry of result) {
      if (entry?.err) continue;              // failed transactions carry no usable inner state
      if (seen.has(entry.signature)) continue;
      seen.add(entry.signature);
      pinned.push({ signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime ?? null });
    }
    const oldest = result[result.length - 1]?.signature;
    if (!oldest || oldest === before) break;
    before = oldest;
    if (result.length < 1000) break;
    await sleep(400);
  }
  return pinned;
}

async function harvestByBlocks(wanted) {
  const pinned = await collectSignaturePages(Math.max(2000, wanted * 3));

  const orderedSlots = [];
  const seenSlots = new Set();
  for (const entry of pinned) {
    const slot = beforeSlot ? Math.min(entry.slot, Number(beforeSlot) - 1) : entry.slot;
    if (!slot || seenSlots.has(slot)) continue;
    seenSlots.add(slot);
    orderedSlots.push(slot);
  }

  const transactions = [];
  const usedSlots = [];
  const errored = new Map();
  const maxSlots = 900;
  let index = 0;
  let scanned = 0;
  const wantPayloads = wanted;

  while (transactions.filter((entry) => entry.payloads.length).length < wantPayloads
      && index < orderedSlots.length && usedSlots.length < maxSlots) {
    const round = orderedSlots.slice(index, index + 4);
    index += 4;
    const results = await mapWithConcurrency(round, 2, async (target) => {
      try {
        const txs = await fetchBlock(target);
        // A skipped slot legitimately returns null; that is not a failure.
        return { slot: target, txs: txs ?? [] };
      } catch (error) {
        const message = String(error.message);
        if (error instanceof RpcExhausted || /rate|too many|behind|skip/i.test(message)) {
          return { slot: target, txs: [], error: message.slice(0, 140) };
        }
        throw error;
      }
    });
    let errors = 0;
    for (const entry of results) {
      if (entry.error) { errors++; errored.set(entry.slot, entry.error); continue; }
      usedSlots.push(entry.slot);
      for (const [position, transaction] of entry.txs.entries()) {
        const payloads = extractPayloads(transaction, program);
        transactions.push({
          signature: transaction.transaction?.signatures?.[0] ?? null,
          slot: entry.slot,
          position,
          txErr: transaction.meta?.err ?? null,
          missing: false,
          payloads,
        });
      }
    }
    // Public mainnet RPC rejects sustained parallel block reads: back off
    // harder when a round came back empty or partially rejected.
    await sleep(errors ? 1200 : 150);
  }

  return { transactions, usedSlots, tip: orderedSlots[0] ?? null, pinned, errored };
}

/** Re-derive the harvest from a pinned signature list. */
async function harvestBySignatures(signatures) {
  const transactions = await mapWithConcurrency(signatures, 2, async (entry) => {
    let transaction;
    try {
      transaction = await rpc('getTransaction', [entry.signature, {
        maxSupportedTransactionVersion: 1, encoding: 'json',
      }]);
    } catch (error) {
      if (error instanceof RpcExhausted) {
        return { ...entry, missing: true, rpcError: String(error.message).slice(0, 140), txErr: null, payloads: [] };
      }
      throw error;
    }
    if (!transaction) return { ...entry, missing: true, txErr: null, payloads: [] };
    return {
      ...entry,
      missing: false,
      txErr: transaction.meta?.err ?? null,
      payloads: extractPayloads(transaction, program),
    };
  });
  return { transactions, usedSlots: [], tip: null };
}

let transactions, usedSlots, tip, pinnedSignatures, blockErrors;
if (fromSignatures) {
  const pinnedFile = JSON.parse(await readFile(fromSignatures, 'utf8'));
  if (pinnedFile.program !== program) throw Error(`pinned file is for program ${pinnedFile.program}, not ${program}`);
  ({ transactions } = await harvestBySignatures(pinnedFile.signatures ?? []));
} else {
  const harvest = await harvestByBlocks(count);
  ({ transactions, usedSlots, tip } = harvest);
  pinnedSignatures = harvest.pinned;
  blockErrors = harvest.errored;
}

const present = transactions.filter((entry) => !entry.missing);
const withPayloads = present.filter((entry) => entry.payloads.length);
const payloadCount = present.reduce((sum, entry) => sum + entry.payloads.length, 0);
const slots = present.map((entry) => entry.slot).filter((slot) => Number.isSafeInteger(slot));
const signatures = pinnedSignatures
  ?? transactions.filter((entry) => entry.signature).map((entry) => ({ signature: entry.signature, slot: entry.slot }));

const document = {
  source: `mainnet-beta harvest (own run, public RPC) — ${new Date().toISOString()}`,
  program,
  rpc: rpcUrl,
  harvestedAt: new Date().toISOString(),
  method: fromSignatures ? 'getTransaction per pinned signature' : 'getBlock over slots listed by getSignaturesForAddress',
  blocksUsed: usedSlots,
  slotsRejected: blockErrors ? Object.fromEntries(blockErrors) : {},
  tipAtHarvest: tip,
  // The pinned signature list makes the harvest re-derivable:
  //   node tools/harvest.mjs --from-signatures <this file> --out rederived.json
  signatures,
  counts: {
    requested: fromSignatures ? signatures.length : count,
    pinnedSignatures: signatures.length,
    fetched: present.length,
    missing: transactions.length - present.length,
    transactionsWithTargetPayloads: withPayloads.length,
    payloads: payloadCount,
    failedOnChain: present.filter((entry) => entry.txErr).length,
    transactionsWithoutTarget: present.filter((entry) => !entry.payloads.length).length,
  },
  slotRange: slots.length ? { oldest: Math.min(...slots), newest: Math.max(...slots) } : null,
  transactions,
};

await writeFile(outPath, `${JSON.stringify(document, null, 1)}\n`);

console.log(JSON.stringify({
  out: path.resolve(outPath),
  program,
  method: document.method,
  counts: document.counts,
  slotRange: document.slotRange,
  blocksUsed: usedSlots.length,
}, null, 2));
