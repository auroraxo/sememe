// Reduce a raw harvest fixture to the payload-bearing transactions.
//
// A raw harvest contains every transaction of every scanned block, including
// the ~99% that never touch the program. For DAMM v1 that was 152,097
// transactions / 58 MB for 602 payload-bearing ones. The zero-payload
// transactions carry no program bytes, so keeping them in the repository buys
// nothing but size. The counts block keeps the full harvest's numbers, and
// `slotRange` keeps the full harvest's span, so the reduction cannot hide the
// denominator.
//
//   node tools/prune-harvest.mjs --in <raw.json> --out <pruned.json>

import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const inPath = option('--in', null);
const outPath = option('--out', null);
const note = option('--note', null);
if (!inPath || !outPath) {
  console.error('usage: node tools/prune-harvest.mjs --in <raw.json> --out <pruned.json> [--note <text>]');
  process.exit(2);
}

const raw = JSON.parse(await readFile(inPath, 'utf8'));
const kept = (raw.transactions ?? []).filter((tx) => (tx.payloads ?? []).length > 0);
const rawPayloads = (raw.transactions ?? []).reduce((sum, tx) => sum + (tx.payloads ?? []).length, 0);
const keptPayloads = kept.reduce((sum, tx) => sum + tx.payloads.length, 0);
if (keptPayloads !== rawPayloads) {
  throw Error(`payload count changed during pruning: ${rawPayloads} -> ${keptPayloads}`);
}

const pruned = {
  program: raw.program,
  harvestedAt: raw.harvestedAt,
  source: raw.source,
  method: raw.method,
  counts: raw.counts,
  slotRange: raw.slotRange,
  blocksUsed: raw.blocksUsed,
  slotsRejected: raw.slotsRejected,
  tipAtHarvest: raw.tipAtHarvest,
  note: note ?? 'Real mainnet payloads, reduced to the payload-bearing transactions; counts preserve the full harvest.',
  signatures: kept.map((tx) => ({ signature: tx.signature, slot: tx.slot })),
  transactions: kept,
  payloadSlotRange: {
    oldest: Math.min(...kept.map((tx) => tx.slot)),
    newest: Math.max(...kept.map((tx) => tx.slot)),
  },
};

await writeFile(outPath, `${JSON.stringify(pruned, null, 1)}\n`);
console.log(JSON.stringify({
  rawTransactions: raw.transactions?.length ?? 0,
  keptTransactions: kept.length,
  payloads: keptPayloads,
  rawBytes: (await readFile(inPath)).length,
  prunedBytes: (await readFile(outPath)).length,
}));
