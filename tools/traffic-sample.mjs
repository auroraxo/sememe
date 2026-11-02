// Unbiased traffic sample: contiguous recent finalized mainnet blocks, ALL of
// their transactions, and the coverage question asked the other way round.
//
//   node tools/traffic-sample.mjs --blocks 4 --out test/fixtures/traffic-sample-2026-11-02.json
//
// Why this exists: every sememe qualification so far was chosen per program
// (signature-driven harvests of programs that were already in the store), so
// the sample and the store share a selection bias. The honest coverage number
// needs traffic that did not know about the store: take the newest finalized
// blocks, inventory every instruction, and count per program — including the
// programs the store does NOT carry. That direction cannot overstate
// coverage; it can only expose gaps.
//
// Two measurements, both taken at capture time:
//
//   (1) TRAFFIC.  For every watched program (repo catalog + the two native
//       programs) the payload bytes are stored, so the decode baseline is
//       reproducible offline. Programs outside the watched list are COUNTED,
//       not stored — their bytes would dwarf the fixture and no IDL exists
//       for them anyway (stated limit).
//
//   (2) ACQUISABILITY.  For every watched program, the two addresses an IDL
//       can live at are derived (canonical Program Metadata PDA, legacy
//       anchor:idl PDA) and fetched, then decoded with the SAME decoder the
//       product uses. A program whose traffic is in the sample but whose IDL
//       cannot be acquired is an ACQUISITION gap, not a decoder gap — and
//       those are different problems with different fixes.
//
// The distinction matters: "sememe cannot decode it" and "sememe cannot get
// the interface at all" are not the same claim, and a coverage number that
// mixes them is the coverage illusion this card is about.
//
// Rate-limit shape: 1 getSlot + N getBlock + 1 getMultipleAccounts (IDL
// accounts, 2 per program). Blocks are fetched with bounded concurrency and
// 429/5xx backoff; a skipped slot legitimately returns null and is counted,
// not retried forever.

import { writeFile } from 'node:fs/promises';
import { accountKeyList, programIdOf, extractPayloads } from './lib/payloads.mjs';
import { addresses, decodeAccount } from '../src/acquire.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const blocksWanted = Number(option('--blocks', '4'));
const rpcUrl = option('--rpc', 'https://api.mainnet-beta.solana.com');
const outPath = option('--out', null);
const probeUnknown = option('--probe-unknown', '0') === '1';
if (!outPath) { console.error('usage: node tools/traffic-sample.mjs --blocks N --out <file.json> [--probe-unknown 1]'); process.exit(2); }
if (!/^https:\/\//.test(rpcUrl)) throw Error('HTTPS RPC URL required');

// The watched list = the repo's 20-program catalog + the two native programs.
// Names are display-only; identity is the program id.
const CATALOG = [
  ['Whirlpool', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'],
  ['Kamino Lend', 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'],
  ['OpenBook v2', 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb'],
  ['Marinade liquid staking', 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD'],
  ['Raydium AMM v4', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
  ['Raydium CLMM', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'],
  ['Raydium CPMM', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'],
  ['Pump.fun bonding curve', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
  ['PumpSwap', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'],
  ['Jupiter v6', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
  ['Jupiter Lend', 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9'],
  ['Jupiter Liquidity', 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC'],
  ['Meteora DLMM', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'],
  ['Meteora DAMM v1', 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB'],
  ['Meteora DAMM v2', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'],
  ['Meteora DBC', 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'],
  ['Meteora Vault', '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi'],
  ['Drift v2', 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH'],
  ['SPL Token', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
  ['Token-2022', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'],
];
const NATIVE = [
  ['System', '11111111111111111111111111111111'],
  ['ComputeBudget', 'ComputeBudget111111111111111111111111111111'],
];
const WATCHED = new Map([...CATALOG, ...NATIVE].map(([name, id]) => [id, name]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let rpcId = 0;

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
      throw Error(`${method}: network error: ${String(error.message).slice(0, 120)}`);
    }
    if (response.status === 429 || response.status >= 500) {
      const retry = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 10000) : 1500 * (attempt + 1));
      continue;
    }
    const body = await response.json().catch(() => null);
    if (!body) { if (attempt < 7) { await sleep(400 * (attempt + 1)); continue; } throw Error(`${method}: unreadable body`); }
    if (body.error) throw Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  throw Error(`${method}: RPC kept rate-limiting`);
}

async function fetchBlock(slot) {
  const block = await rpc('getBlock', [slot, {
    transactionDetails: 'full',
    encoding: 'json',
    maxSupportedTransactionVersion: 1,
    rewards: false,
    commitment: 'finalized',
  }]);
  return block?.transactions ?? null; // null = skipped slot
}

const slot = await rpc('getSlot', [{ commitment: 'finalized' }]);
// Step a few slots back so every sampled block is comfortably finalized.
const slots = [];
for (let i = 0; i < blocksWanted; i++) slots.push(slot - 2 - i);

const transactions = [];
const skippedSlots = [];
const unknownPayloads = new Map(); // program id -> instruction count
const unknownTx = new Map();       // program id -> tx count
let txSeenTotal = 0;

for (const target of slots) {
  let txs;
  try { txs = await fetchBlock(target); }
  catch (error) { throw Error(`getBlock ${target}: ${error.message}`); }
  if (txs === null) { skippedSlots.push(target); continue; }
  txSeenTotal += txs.length;
  for (const tx of txs) {
    const accounts = accountKeyList(tx);
    const failed = tx?.meta?.err !== null && tx?.meta?.err !== undefined;
    const rows = [];
    for (const programId of WATCHED.keys()) {
      for (const payload of extractPayloads(tx, programId)) {
        rows.push({ program: programId, dataHex: payload.dataHex });
      }
    }
    const message = tx?.transaction?.message;
    const meta = tx?.meta ?? {};
    const all = [
      ...(message?.instructions ?? []),
      ...((meta.innerInstructions ?? []).flatMap((group) => group?.instructions ?? [])),
    ];
    const seenUnknown = new Set();
    for (const instruction of all) {
      const programId = programIdOf(instruction, accounts);
      if (!programId || WATCHED.has(programId)) continue;
      unknownPayloads.set(programId, (unknownPayloads.get(programId) ?? 0) + 1);
      if (!seenUnknown.has(programId)) {
        seenUnknown.add(programId);
        unknownTx.set(programId, (unknownTx.get(programId) ?? 0) + 1);
      }
    }
    if (rows.length) {
      transactions.push({
        signature: typeof tx?.transaction?.signatures?.[0] === 'string' ? tx.transaction.signatures[0] : null,
        slot: target,
        failed,
        payloads: rows,
      });
    }
  }
  process.stderr.write(`block ${target}: ${txs.length} txs\n`);
  await sleep(300);
}

// ACQUISABILITY CHECK AT CAPTURE TIME: for every watched program, derive the
// two addresses an IDL can live at, fetch them, and decode with the product's
// own decoder. This asks "could sememe have had this interface?" — the
// question a coverage number actually depends on.
const idlOwner = [];
const idlKeys = [];
for (const programId of WATCHED.keys()) {
  const { metadata, anchor } = await addresses(programId);
  idlOwner.push({ programId, source: 'metadata', address: metadata });
  idlOwner.push({ programId, source: 'anchor', address: anchor });
  idlKeys.push(metadata, anchor);
}

// Optional --probe-unknown 1: run the SAME acquisability check for the top
// non-watched programs. The result is the acquisition queue, not a coverage
// promise: only a check whether the ONE source sememe can pull from exists
// on-chain for a program outside the curated list.
if (probeUnknown) {
  const topUnknown = [...unknownPayloads.keys()]
    .sort((a, b) => unknownPayloads.get(b) - unknownPayloads.get(a)).slice(0, 8);
  for (const programId of topUnknown) {
    const { metadata, anchor } = await addresses(programId);
    idlOwner.push({ programId, source: 'metadata', address: metadata });
    idlOwner.push({ programId, source: 'anchor', address: anchor });
    idlKeys.push(metadata, anchor);
  }
}

const accountsResult = await rpc('getMultipleAccounts', [idlKeys, {
  encoding: 'base64', commitment: 'finalized',
}]);
const values = accountsResult?.value;
if (!Array.isArray(values) || values.length !== idlKeys.length) {
  throw Error('acquisability check: malformed getMultipleAccounts response');
}

const acquirable = {};
// `idlOwner` is flat and built in the same order as `idlKeys`, so the account
// at position N belongs to slot N — indexing per program (index*2) would make
// every program read its neighbours' accounts, which is exactly how the first
// run produced a uniform "invalid metadata header, binding" for 21 of 22.
idlOwner.forEach((entry, index) => {
  const record = acquirable[entry.programId] ??
    (acquirable[entry.programId] = { id: entry.programId, name: WATCHED.get(entry.programId) ?? null, sources: [], idl: null });
  const value = values[index];
  if (value === null) { record.sources.push({ source: entry.source, state: 'absent' }); return; }
  try {
    const idl = decodeAccount(value, entry.source, entry.programId);
    record.sources.push({
      source: entry.source,
      state: 'usable',
      instructions: idl.instructions.length,
      events: Array.isArray(idl.events) ? idl.events.length : 0,
    });
    if (!record.idl) record.idl = { source: entry.source, instructions: idl.instructions.length };
  } catch (error) {
    record.sources.push({ source: entry.source, state: 'present-unusable', reason: String(error?.message ?? error).slice(0, 120) });
  }
});
for (const record of Object.values(acquirable)) record.acquirable = Boolean(record.idl);

// Per-program traffic counts from the stored rows (the honest denominator).
const catalog = new Map([...WATCHED.keys()].map((id) => [id, {
  name: WATCHED.get(id), id, txCount: 0, payloadCount: 0,
}]));
const txSeen = new Map(); // programId -> Set(signature) for tx counting
const nullSigTouched = new Map();
for (const tx of transactions) {
  for (const row of tx.payloads) {
    const entry = catalog.get(row.program);
    entry.payloadCount += 1;
    if (tx.signature) {
      let seen = txSeen.get(row.program);
      if (!seen) { seen = new Set(); txSeen.set(row.program, seen); }
      seen.add(tx.signature);
    } else {
      nullSigTouched.set(row.program, (nullSigTouched.get(row.program) ?? 0) + 1);
    }
  }
}
for (const [id, entry] of catalog) entry.txCount = (txSeen.get(id)?.size ?? 0) + (nullSigTouched.get(id) ?? 0);

transactions.sort((a, b) => (a.slot - b.slot) || String(a.signature).localeCompare(String(b.signature)));

const report = {
  meta: {
    capturedAt: new Date().toISOString(),
    rpc: rpcUrl,
    method: 'getBlock finalized full encoding:json maxSupportedTransactionVersion:1 rewards:false; contiguous newest finalized slots minus 2',
    requestedSlots: slots,
    skippedSlots,
    blocksWithTraffic: slots.length - skippedSlots.length,
    transactionsInBlocks: txSeenTotal,
    watchedPrograms: WATCHED.size,
    note: 'transactions below carry at least one watched-program payload; non-watched programs are counted in unknownPrograms, their bytes are NOT stored (limit)',
  },
  acquirable,
  catalog: [...catalog.values()].sort((a, b) => b.payloadCount - a.payloadCount),
  unknownPrograms: [...unknownPayloads.keys()].map((id) => ({
    id, payloadCount: unknownPayloads.get(id), txCount: unknownTx.get(id) ?? 0,
  })).sort((a, b) => b.payloadCount - a.payloadCount),
  transactions,
};

await writeFile(outPath, JSON.stringify(report, null, 1));
const totalPayloads = transactions.reduce((sum, tx) => sum + tx.payloads.length, 0);
const acquirableCount = Object.values(acquirable).filter((entry) => entry.acquirable).length;
process.stderr.write(`wrote ${outPath}: ${transactions.length} txs, ${totalPayloads} watched payloads, `
  + `${acquirableCount}/${WATCHED.size} acquirable, ${report.unknownPrograms.length} other programs\n`);
