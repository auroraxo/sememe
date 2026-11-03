#!/usr/bin/env node
// Measure ACCOUNT-LIST conformance of real mainnet traffic against the
// interfaces sememe stores.
//
// The question: for programs whose interface sememe has verified and pinned,
// does the account list the chain actually carries match what that interface
// declares? Instruction BYTES are the part of an interface everyone checks;
// the account list is the part nobody checks, and it is where a real
// first-party program diverged (jup-ag order_engine: 11 declared accounts,
// 12-13 observed, and the extra one signs every fill — reported as
// jup-ag/rfq-webhook-toolkit#96).
//
// Method (and why each step is the way it is):
//   - SIGNATURE PAGE, not a blind block walk: getSignaturesForAddress gives
//     the program's OWN recent transactions, so the sample is the program's
//     traffic and not whatever happened to be in a block.
//   - getTransaction per signature, because the account list only exists in
//     the full transaction. The public endpoint throttles this hard, so the
//     fetch is paced and RETRIED; a fetch that failed is counted as a
//     failure, and a run with failures exits non-zero instead of reporting a
//     smaller sample as if it were the whole thing.
//   - EVERY instruction of every fetched transaction is checked, top-level
//     and CPI. A program invoked through a CPI is as real as one invoked
//     directly.
//   - A program without a stored interface is reported as
//     `no-stored-interface`, never skipped silently: that is the acquisition
//     gap, and it must stay visible in the denominator.
//
// Output: research/account-list-conformance-<date>.json — the SUMMARY and the
// disagreeing rows. The full transactions are NOT committed (they are large
// and public), but every row carries the signature and slot, so any finding
// can be re-fetched and checked by hand.
//
// Usage:
//   node tools/account-list-conformance.mjs --programs <id,id> --count 60 \
//     --store <dir> --out research/account-list-conformance-2026-11-03.json
//
// Read-only, public RPC.

import { writeFile } from 'node:fs/promises';
import { checkTransaction } from '../src/conformance.mjs';
import { summarizeConformance } from '../src/account-list.mjs';
import { findStoredIdls } from '../src/store-read.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const programs = (option('--programs', '') || '').split(',').map((value) => value.trim()).filter(Boolean);
const wanted = Number(option('--count', '50'));
const rpcUrl = option('--rpc', 'https://api.mainnet-beta.solana.com');
const store = option('--store', null);
const outPath = option('--out', null);
if (!programs.length) throw Error('--programs needs at least one program id');
if (!store) throw Error('--store needs a sememe store directory');
if (!outPath) throw Error('--out needs a report path');
if (!/^https:\/\//.test(rpcUrl)) throw Error('HTTPS RPC URL required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let rpcId = 0;
let rpcCalls = 0;
let rpcFailures = 0;

async function rpc(method, params, tries = 6) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      rpcCalls += 1;
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      if (response.status === 429 || response.status >= 500) {
        const retry = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 15000) : 2000 * (attempt + 1));
        continue;
      }
      const body = await response.json().catch(() => null);
      if (!body) { await sleep(600 * (attempt + 1)); continue; }
      if (body.error) {
        if ([429, -32005, -32004].includes(body.error.code)) { await sleep(2000 * (attempt + 1)); continue; }
        rpcFailures += 1;
        return { error: body.error.message };
      }
      return { result: body.result };
    } catch (error) {
      await sleep(1200 * (attempt + 1));
    }
  }
  rpcFailures += 1;
  return { error: 'gave up after retries' };
}

/** The program's own recent signatures, oldest last. */
async function signaturePage(program, limit) {
  const result = await rpc('getSignaturesForAddress', [program, { limit }]);
  if (result.error) return { error: result.error };
  const entries = Array.isArray(result.result) ? result.result : [];
  return { entries: entries.filter((entry) => entry && !entry.err) };
}

async function fetchTransaction(signature) {
  const result = await rpc('getTransaction', [signature, { maxSupportedTransactionVersion: 1, encoding: 'json' }]);
  if (result.error) return { error: result.error };
  if (!result.result) return { missing: true };
  return { transaction: result.result };
}

const perProgram = [];
const allRows = [];

for (const program of programs) {
  let idlState = 'unknown';
  try {
    const sources = await findStoredIdls(store, program);
    idlState = sources.primary ? 'on-chain' : (sources.secondary ? 'adopted' : 'none');
  } catch { idlState = 'none'; }

  const page = await signaturePage(program, Math.min(1000, Math.max(wanted, 20)));
  if (page.error) {
    perProgram.push({ program, interface: idlState, error: `signature page failed: ${page.error}` });
    continue;
  }
  const entries = page.entries.slice(0, wanted);
  const rows = [];
  let fetched = 0;
  let failed = 0;

  for (const entry of entries) {
    const fetchedTx = await fetchTransaction(entry.signature);
    if (fetchedTx.error || fetchedTx.missing) { failed += 1; continue; }
    fetched += 1;
    let report;
    try {
      report = await checkTransaction(fetchedTx.transaction, store, { only: [program] });
    } catch (error) {
      failed += 1;
      rows.push({
        signature: entry.signature,
        slot: entry.slot,
        verdict: 'refused',
        reason: String(error?.message ?? error).slice(0, 200),
        violations: [],
        notes: [],
        extras: [],
        unknownSigner: [],
        positions: { declared: null, observed: null },
      });
      continue;
    }
    for (const row of report.rows) {
      rows.push({
        signature: entry.signature,
        slot: entry.slot,
        program: row.program,
        instruction: row.instruction ?? row.instructionNames ?? null,
        depth: row.depth,
        verdict: row.verdict,
        executed: row.executed,
        positions: row.positions,
        violations: row.violations,
        extras: row.extras,
        notes: row.notes,
        unknownSigner: row.unknownSigner,
      });
    }
    // Pace the public endpoint: a signature page plus per-transaction reads
    // is the throttled shape, and the sleep is what keeps the run from
    // being cut off half way.
    await sleep(120);
  }

  const summary = summarizeConformance(rows);

  const disagreeing = rows.filter((row) => Array.isArray(row.violations) && row.violations.length);
  perProgram.push({
    program,
    interface: idlState,
    requested: entries.length,
    fetched,
    failed,
    summary,
    violationKinds: disagreeing.reduce((acc, row) => {
      for (const violation of row.violations) acc[violation.kind] = (acc[violation.kind] ?? 0) + 1;
      return acc;
    }, {}),
    disagreeing: disagreeing.length,
  });
  // EVERY row is committed, not just the violations: the committed summary is
  // then re-derivable from the committed rows (the repo's "no hand-edited
  // numbers" rule), and a reader can check the clean rows too.
  for (const row of rows) allRows.push(row);
  console.error(`${program}: fetched ${fetched}/${entries.length} tx, instructions ${summary.instructions}, `
    + `verdicts ${JSON.stringify(summary.byVerdict)}`);
}

const report = {
  measuredAt: new Date().toISOString(),
  rpc: rpcUrl,
  rpcCalls,
  rpcFailures,
  method: 'getSignaturesForAddress (program own traffic) -> getTransaction per signature -> '
    + 'every instruction checked against the stored, receipt-verified interface; '
    + 'perProgram.summary is deriveSummarize(allRows of that program)',
  limits: [
    'a public RPC sample of recent traffic, not the whole history of a program',
    'an account list is checked against the interface ONE transaction at a time; the program may legitimately accept several shapes',
    'the signer flags come from the message header counts; a shape this tool cannot read is refused, never reported as conforming',
    'signing MORE than the interface declares is not a violation (the fee payer commonly sits at a non-signer position); signing LESS is',
    'no statement about whether the program accepted the transaction — meta.err is carried alongside',
  ],
  perProgram,
  rows: allRows,
  disagreeing: allRows.filter((row) => Array.isArray(row.violations) && row.violations.length),
};

await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.error(`report: ${outPath}`);
if (rpcFailures > 0) {
  console.error(`rpc failures: ${rpcFailures} — the sample is incomplete`);
  process.exit(1);
}
