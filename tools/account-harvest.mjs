// Harvest real program-owned accounts from mainnet into a fixture file.
//
//   node tools/account-harvest.mjs <program-id> <count> <out.json> [--rpc <url>]
//
// Recipe: take recent signatures for the program (its own signature page, so
// the sample is the program's live traffic), fetch those transactions, collect
// every account key they reference, then `getMultipleAccounts` and keep the
// accounts whose OWNER is the program. Only mainnet bytes enter the output —
// no decoding, no IDL, no interpretation.
//
// Output shape (pinned as a test fixture):
//   { program, harvestedAt, rpc, method, count, accounts: [{ address, owner,
//     lamports, dataBase64, encoding }] }

import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const program = args[0];
const want = Number(args[1]);
const out = args[2];
const rpcUrl = option('--rpc', 'https://api.mainnet-beta.solana.com');
if (!program || !Number.isInteger(want) || want < 1 || !out) {
  console.error('usage: node tools/account-harvest.mjs <program-id> <count> <out.json> [--rpc <url>]');
  process.exit(2);
}
if (!/^https:\/\//.test(rpcUrl)) throw Error('HTTPS RPC URL required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let rpcId = 0;
async function rpc(method, params, tries = 6) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const body = await response.json();
    if (!body.error) return body.result;
    // Public RPCs throttle getMultipleAccounts hard; back off and retry.
    if (body.error.code === 429 || body.error.code === -32005) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    throw Error(`${method}: ${JSON.stringify(body.error)}`);
  }
  throw Error(`${method}: rate limited after retries`);
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      output[index] = await fn(items[index], index);
    }
  }));
  return output;
}

const signatures = await rpc('getSignaturesForAddress', [program, { limit: 150 }]);
const transactions = await mapLimit(signatures.slice(0, 40), 2, async (entry) => {
  try {
    return await rpc('getTransaction', [entry.signature, { maxSupportedTransactionVersion: 1, encoding: 'json' }]);
  } catch {
    return null;
  }
});
const keys = [...new Set(transactions.filter(Boolean)
  .flatMap((tx) => tx.transaction.message.accountKeys.map((key) => key.pubkey ?? key)))];

const owned = new Map();
for (let offset = 0; offset < keys.length && owned.size < want; offset += 100) {
  const batch = keys.slice(offset, offset + 100);
  const response = await rpc('getMultipleAccounts', [batch]);
  response.value.forEach((account, index) => {
    if (account && account.owner === program && !owned.has(batch[index])) owned.set(batch[index], account);
  });
}

const accounts = [];
for (const [address, account] of owned) {
  if (accounts.length >= want) break;
  accounts.push({
    address,
    owner: account.owner,
    lamports: account.lamports,
    dataBase64: account.data[0],
    encoding: account.data[1],
  });
}

const output = {
  program,
  harvestedAt: new Date().toISOString(),
  rpc: rpcUrl,
  method: 'getSignaturesForAddress -> getTransaction -> getMultipleAccounts (owner-filtered)',
  count: accounts.length,
  accounts,
};
await writeFile(out, JSON.stringify(output, null, 1) + '\n');
console.log(JSON.stringify({ program, out, count: accounts.length }));
