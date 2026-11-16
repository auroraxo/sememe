// Harvest payloads from a reeflog mailbox instead of the network — user zero
// for reeflog's instruction envelope, and a second source for sememe's
// fixtures.
//
// Why this exists
// ---------------
// `tools/harvest.mjs` pays `getSignaturesForAddress`, `getBlock`, and
// `getTransaction` to obtain the instruction bytes of one program — measured
// on the Whirlpool harvest: hundreds of RPC calls and rate-limit backoff for
// payloads that the chain served inside responses somebody else (a local
// reeflog journal) already fetched. reeflog's account envelope carries those
// bytes verbatim (`instructions` in `src/accounts.rs`), stored in the same
// response that carried the logs.
//
// This tool reads the local journal and writes a document in the SAME shape
// as `harvest.mjs`, so everything downstream — `--from-signatures`,
// `--verify`, `compareReDerived`, the fixtures — works without knowing which
// source produced the bytes.
//
// Zero-RPC is not a comment, it is enforced: `fetch` is replaced with a
// function that throws. If any code path in this tool (or a future change to
// it) reaches for the network, the run fails loudly instead of quietly
// costing an RPC the claim said was zero. `node --eval` style checks in
// `tools/e2e-reeflog-harvest.mjs` assert the guard exists.
//
// Honesty rules (same as the network harvester):
//   - a row the journal has not enriched (no account envelope yet) is COUNTED
//     as debt, never dropped from the document's accounting;
//   - BOTH retraction signals are read: the row's CURRENT seal on `tail`, and
//     the retraction itself on `reorg tail` (its own channel, its own cursor).
//     The seal alone is a snapshot taken when the row is read — a retraction
//     recorded after that read is invisible to it, which is exactly why
//     reeflog delivers retractions on a separate channel in the first place.
//   - an envelope that carries no `instructions` (an older binary hydrated
//     it) is debt too — it cannot yield payloads;
//   - a transaction whose payloads cannot be extracted for the target
//     program stays in `transactions` with `payloads: []` (denominator kept).
// The document's `source` and `method` say exactly where the bytes came from.

// The zero-RPC guard is imported FIRST, on purpose: an ES module's imports
// are evaluated before its own body, so a guard installed in this file's
// body would arrive too late. Importing it first makes the guard effective
// before any other module body runs.
import { guard } from './lib/network-guard.mjs';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { payloadsFromEnvelope } from './lib/payloads.mjs';
import { slotRange } from './lib/slot-range.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const dbPath = option('--db', null);
const program = option('--program', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const outPath = option('--out', null);
const reeflogBin = option('--reeflog-bin', process.env.REEFLOG_BIN || '../reeflog/target/release/reeflog');
const tailLimit = Number(option('--tail-limit', '100000'));

if (!dbPath) { console.error('usage: node tools/harvest-reeflog.mjs --db <reeflog.db> --out <file.json> [--program <id>]'); process.exit(2); }
if (!outPath) { console.error('usage: node tools/harvest-reeflog.mjs --db <reeflog.db> --out <file.json> [--program <id>]'); process.exit(2); }
if (!fs.existsSync(dbPath)) { console.error(`journal not found: ${dbPath}`); process.exit(2); }
if (!fs.existsSync(reeflogBin)) {
  console.error(`reeflog binary not found: ${reeflogBin} (pass --reeflog-bin or set REEFLOG_BIN)`);
  process.exit(2);
}

// One-shot read: FRESH cursors in a throwaway directory, so a repeated
// harvest sees the whole journal (including rows enriched after the last run)
// and this tool can never advance a consumer's real cursor. The two channels
// get SEPARATE files on purpose: reeflog refuses a cursor written by the other
// channel (an event seq and a reorg id are different number lines), and a
// reader that handed one file to both would get a refusal, not a harvest.
const cursorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reeflog-harvest-'));
const cursorPath = path.join(cursorDir, 'events-cursor.txt');
const reorgCursorPath = path.join(cursorDir, 'reorgs-cursor.txt');

function runReeflog(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(reeflogBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // 'close', not 'exit': stdout may still be unread at 'exit'.
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

const tailRun = await runReeflog(['tail', '--db', dbPath, '--cursor', cursorPath, '--limit', String(tailLimit)]);
if (tailRun.code !== 0) {
  console.error(`reeflog tail exited ${tailRun.code}: ${tailRun.err.trim().slice(-400)}`);
  process.exit(1);
}
const { out, err: tailStderr } = tailRun;
const rows = out.split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

// The retraction channel, read AFTER the rows so that every retraction
// recorded up to this point is in scope: a retraction that lands between the
// row read and this read would be missed by the seal on the row but is still
// delivered here. A channel we cannot read must fail the run — writing a
// document that claims the retraction was honoured while the channel was
// never asked is the same defect in a second shape.
const reorgRun = await runReeflog(['reorg', 'tail', '--db', dbPath, '--cursor', reorgCursorPath, '--limit', String(tailLimit)]);
if (reorgRun.code !== 0) {
  console.error(`the retraction channel could not be read: reeflog reorg tail exited ${reorgRun.code}: ${reorgRun.err.trim().slice(-400)}`);
  console.error('refusing to write a harvest document that claims a retraction was honoured without reading the channel that carries it');
  process.exit(1);
}
const reorgRetractions = reorgRun.out.split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter((r) => r && typeof r.reorg_id === 'number' && typeof r.signature === 'string');
const reorgSignatures = new Set(reorgRetractions.map((r) => r.signature));

const transactions = [];
let rowsWithoutEnvelope = 0;
let rowsWithoutInstructions = 0;
let rowsWithoutTargetPayloads = 0;
// Retracted rows: named, never harvested. reeflog prints each row's CURRENT
// seal on `tail` AND carries the retraction itself on `reorg tail`; dropping
// either signal is what reeflog issue #1 called the retracted claim. The
// counter is a debt like the others — the row is reported, not swallowed.
// `rowsReverted` counts rows of THIS journal; `reorgOnlySignatures` names
// retractions the channel delivered that the row read did not show as
// reverted (a retraction that arrived after the row was read).
let rowsReverted = 0;
const revertedSignatures = [];
const reorgOnlySignatures = [];

for (const row of rows) {
  // Both signals decide first: a row the chain unmade is not a payload
  // source, and it is not an envelope debt `hydrate --accounts` could ever
  // close either (the chain no longer knows the transaction). It gets its own
  // bucket, ahead of both.
  const revertedBySeal = row.seal === 'reverted';
  const revertedByChannel = typeof row.signature === 'string' && reorgSignatures.has(row.signature);
  if (revertedBySeal || revertedByChannel) {
    rowsReverted++;
    if (row.signature) revertedSignatures.push(row.signature);
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
    position: null, // the journal does not know a block position; not needed to compare payloads
    txErr: envelope.err !== undefined ? envelope.err : (row.err ?? null),
    missing: false,
    payloads,
  });
}

// A harvest that yielded nothing must not be written as a success.
const payloadCount = transactions.reduce((sum, t) => sum + t.payloads.length, 0);
if (!transactions.length) {
  // Nothing to harvest for two different reasons, and only one of them is
  // answered by "start the daemon": a journal of only retracted rows has run
  // correctly and told us the events are gone.
  if (rowsReverted > 0) {
    console.error(`no live rows to harvest — all ${rowsReverted} candidate row(s) were RETRACTED by the chain (see counts.revertedSignatures); nothing was written`);
    process.exit(1);
  }
  console.error('no enriched rows in the journal — run `reeflog start` and `reeflog hydrate --accounts` first');
  process.exit(1);
}

const slots = transactions.map((t) => t.slot).filter((s) => Number.isSafeInteger(s));
const document = {
  source: `reeflog mailbox harvest (own local journal, zero RPC) — ${new Date().toISOString()}`,
  program,
  rpc: 'none (local reeflog journal)',
  harvestedAt: new Date().toISOString(),
  method: 'reeflog tail --cursor <fresh> over the local journal (envelope instructions, byte-verbatim) + reeflog reorg tail --cursor <fresh> (retraction channel)',
  blocksUsed: [],
  slotsRejected: {},
  tipAtHarvest: slots.length ? Math.max(...slots) : null,
  signatures: transactions
    .filter((t) => t.signature)
    .map((t) => ({ signature: t.signature, slot: t.slot })),
  counts: {
    requested: rows.length,
    journalRows: rows.length,
    pinnedSignatures: transactions.length,
    fetched: transactions.length,
    missing: 0,
    transactionsWithTargetPayloads: transactions.filter((t) => t.payloads.length).length,
    payloads: payloadCount,
    failedOnChain: transactions.filter((t) => t.txErr).length,
    transactionsWithoutTarget: rowsWithoutTargetPayloads,
    // Debt the network harvester does not have: rows the journal has not
    // enriched (or enriched with an older binary). Reported, never hidden —
    // `hydrate --accounts` with the current binary is what closes it.
    rowsWithoutEnvelope,
    rowsWithoutInstructions,
    // Retracted by the chain: never a payload source, never an open debt —
    // named so the reader can see what the mailbox withdrew.
    rowsReverted,
    revertedSignatures,
    // The retraction channel's own account: how many records it delivered and
    // which signatures it withdrew that the row's seal had not (yet) shown.
    reorgRetractions: reorgRetractions.length,
    reorgOnlySignatures,
  },
  slotRange: slotRange(slots),
  transactions,
};

if (guard.attempts.length) {
  console.error(`FAILED: the harvest attempted ${guard.attempts.length} network call(s): ${guard.attempts.slice(0, 3).join(', ')}`);
  process.exit(1);
}

fs.writeFileSync(outPath, `${JSON.stringify(document, null, 1)}\n`);

console.log(JSON.stringify({
  out: path.resolve(outPath),
  program,
  method: document.method,
  network: 'none — global fetch throws (zero-RPC guard)',
  networkAttempts: guard.attempts.length,
  counts: document.counts,
  slotRange: document.slotRange,
  tailStderr: tailStderr.trim().split('\n').pop() ?? '',
}, null, 2));
