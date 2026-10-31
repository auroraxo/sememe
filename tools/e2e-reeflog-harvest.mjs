// Live proof that a reeflog mailbox can stand in for the network when
// sememe harvests instruction bytes — and that the bytes are the SAME bytes.
//
// The claim under test (tools/harvest-reeflog.mjs): the instruction bytes in
// reeflog's account envelope are byte-identical to the bytes the chain
// served, so a harvest can read them from the local journal instead of
// paying RPC calls.
//
// Three sources are compared, none of them derived from another:
//
//   mailbox  = reeflog's account envelope (instructions[]), read from the
//              local journal by the new tool
//   chain    = getTransaction straight from mainnet, decoded by the OLD
//              network path (extractPayloads)
//   equality = JSON.stringify of both payload lists, per signature
//
// A chain fetch that the public endpoint refuses is reported as
// `unavailable` — evidence about the endpoint, not about the bytes — and
// never folded into "equal" or "different".
//
// The zero-RPC claim of the tool is checked from the tool's own output: the
// guard counts every attempted fetch, and the run fails if that count is not
// zero.
//
// Usage: node tools/e2e-reeflog-harvest.mjs [--seconds 45] [--sample 12] [--reuse-db]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPayloads } from './lib/payloads.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REEFLOG_BIN = process.env.REEFLOG_BIN || path.resolve(
  process.env.HOME || '/home/aurora', 'github_repos/reeflog/target/release/reeflog');
const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const DIR = process.env.SEMEME_REEFLOG_E2E_DIR || '/tmp/sememe-reeflog-e2e';
const REPORT = path.join(ROOT, 'research', 'reeflog-harvest-e2e-report.json');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};
const SECONDS = Number(argOf('--seconds', '45'));
const SAMPLE = Number(argOf('--sample', '12'));
const MIN_EQUAL = Number(argOf('--min-equal', '5'));
const REUSE = argv.includes('--reuse-db');

if (!fs.existsSync(REEFLOG_BIN)) {
  console.error(`reeflog binary not found at ${REEFLOG_BIN}`);
  process.exit(2);
}
if (!REUSE) fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'research'), { recursive: true });

const DB = path.join(DIR, 'reeflog.db');
const HARVEST = path.join(DIR, 'harvest.json');

function cli(args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.on('error', (error) => resolve({ code: -1, out, err: String(error.message) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let response;
    try {
      response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
    } catch (error) {
      await sleep(400 * (attempt + 1));
      continue;
    }
    if (response.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const body = await response.json().catch(() => null);
    if (!body) { await sleep(400 * (attempt + 1)); continue; }
    if (body.error) {
      // Permanent client errors: evidence about the request, not about the
      // endpoint — report them, never retry them into "rate limited".
      if (body.error.code === -32602 || body.error.code === -32004 || body.error.code === -32015) {
        return { unavailable: `rpc error ${body.error.code}: ${body.error.message}` };
      }
      await sleep(600 * (attempt + 1));
      continue;
    }
    return { result: body.result };
  }
  return { unavailable: 'endpoint kept failing after retries' };
}

// --- the mailbox ------------------------------------------------------------
if (!REUSE) {
  const init = await cli([REEFLOG_BIN, 'init', '--db', DB, '--program', PROGRAM]);
  if (init.code !== 0) { console.error('INIT FAILED', init.err); process.exit(2); }

  console.log(`running the reeflog daemon for ${SECONDS}s against mainnet…`);
  const daemon = cli([REEFLOG_BIN, 'start', '--db', DB, '--seconds', String(SECONDS),
    '--program', PROGRAM, '--seal-every', '5', '--reorg-every', '10']);
  const status = await cli([REEFLOG_BIN, 'status', '--db', DB]);
  await daemon;
} else {
  console.log(`reusing the existing journal at ${DB}`);
}

console.log('hydrating account envelopes (the instruction bytes live there)…');
const hydrate = await cli([REEFLOG_BIN, 'hydrate', '--db', DB, '--limit', '5000', '--accounts'], { timeoutMs: 600000 });
console.log(hydrate.out.trim().split('\n').slice(-2).join('\n'));

const finalStatus = await cli([REEFLOG_BIN, 'status', '--db', DB]);
const counters = JSON.parse(finalStatus.out || '{}');

// --- the harvest over the mailbox ------------------------------------------
console.log('harvesting from the mailbox (zero RPC, enforced by the guard)…');
const harvest = await cli([process.execPath,
  path.join(ROOT, 'tools', 'harvest-reeflog.mjs'),
  '--db', DB, '--out', HARVEST, '--reeflog-bin', REEFLOG_BIN,
], { timeoutMs: 120000 });
if (harvest.code !== 0) {
  console.error('HARVEST FAILED', harvest.err);
  process.exit(1);
}
const harvestReport = JSON.parse(harvest.out);
const document = JSON.parse(fs.readFileSync(HARVEST, 'utf8'));

// --- the chain, fetched independently ---------------------------------------
const withPayloads = document.transactions.filter((t) => t.payloads.length);
const withoutPayloads = document.transactions.filter((t) => !t.payloads.length);
const sample = withPayloads.slice(0, SAMPLE);
// The other direction matters just as much: a journal row the mailbox says
// carries NO instruction of the target program must be corroborated by the
// chain, not merely unexamined — otherwise "0 payloads" could be the
// extractor dropping real bytes and nothing would ever notice.
const noTargetSample = withoutPayloads.slice(0, SAMPLE);

let equal = 0;
let different = 0;
let unavailable = 0;
let noTargetOnChain = 0;
let noTargetAgree = 0;
let noTargetContradict = 0;
const differences = [];
const samples = [];

for (const transaction of sample) {
  const response = await rpc('getTransaction', [transaction.signature, {
    encoding: 'json',
    // Version 1, like the repo's own harvesters (harvest.mjs,
    // account-harvest.mjs): Whirlpool CPI traffic is v1, and requesting
    // maxSupportedTransactionVersion 0 turns every such fetch into
    // rpc error -32015 — measured 2026-10-31, first harness run sampled 2/12.
    maxSupportedTransactionVersion: 1,
    commitment: 'finalized',
  }]);
  if (response.unavailable) {
    unavailable++;
    samples.push({ signature: transaction.signature, verdict: 'unavailable', reason: response.unavailable });
    await sleep(700);
    continue;
  }
  const tx = response.result;
  if (!tx) {
    unavailable++;
    samples.push({ signature: transaction.signature, verdict: 'unavailable', reason: 'null result' });
    await sleep(700);
    continue;
  }
  const chainPayloads = extractPayloads(tx, PROGRAM);
  if (!chainPayloads.length) {
    // The chain says this transaction never invoked the program: the mailbox
    // claims payloads for it. That is a REAL contradiction, not an
    // unavailable endpoint, so it counts as `different`.
    noTargetOnChain++;
    different++;
    differences.push({
      signature: transaction.signature,
      mailboxPayloads: transaction.payloads.length,
      chainPayloads: 0,
      reason: 'chain transaction carries no instruction of the target program',
    });
    samples.push({ signature: transaction.signature, verdict: 'different', mailbox: transaction.payloads.length, chain: 0 });
    await sleep(700);
    continue;
  }
  const same = JSON.stringify(chainPayloads) === JSON.stringify(transaction.payloads);
  if (same) {
    equal++;
    samples.push({
      signature: transaction.signature,
      verdict: 'equal',
      payloads: transaction.payloads.length,
      bytes: transaction.payloads.reduce((n, p) => n + p.dataHex.length, 0),
    });
  } else {
    different++;
    differences.push({
      signature: transaction.signature,
      mailbox: transaction.payloads,
      chain: chainPayloads,
    });
    samples.push({ signature: transaction.signature, verdict: 'different' });
  }
  await sleep(700);
}

// --- the other direction: transactions the mailbox says have no target ix ---
let noTargetUnavailable = 0;
for (const transaction of noTargetSample) {
  const response = await rpc('getTransaction', [transaction.signature, {
    encoding: 'json',
    maxSupportedTransactionVersion: 1,
    commitment: 'finalized',
  }]);
  const tx = response.result;
  if (response.unavailable || !tx) {
    noTargetUnavailable++;
    await sleep(700);
    continue;
  }
  const chainPayloads = extractPayloads(tx, PROGRAM);
  if (chainPayloads.length === 0) {
    noTargetAgree++;
  } else {
    noTargetContradict++;
    differences.push({
      signature: transaction.signature,
      reason: 'mailbox recorded 0 target payloads, the chain shows them',
      mailbox: 0,
      chain: chainPayloads,
    });
  }
  await sleep(700);
}

// --- checks -----------------------------------------------------------------
const checks = [
  {
    name: 'mailbox_harvest_yielded_payloads',
    pass: harvestReport.counts.payloads > 0,
    detail: `${harvestReport.counts.payloads} payloads from ${harvestReport.counts.fetched} transactions`,
  },
  {
    name: 'tool_made_zero_rpc_calls',
    pass: harvestReport.networkAttempts === 0,
    detail: `network attempts: ${harvestReport.networkAttempts}`,
  },
  {
    name: 'mailbox_bytes_equal_chain_bytes',
    pass: sample.length > 0 && different === 0 && equal >= MIN_EQUAL,
    detail: `${equal} equal (floor ${MIN_EQUAL}), ${different} different, ${unavailable} unavailable (of ${sample.length} sampled)`,
  },
  {
    name: 'mailbox_agrees_when_it_records_no_payload',
    pass: noTargetSample.length > 0 && noTargetContradict === 0 && noTargetAgree >= Math.min(MIN_EQUAL, noTargetSample.length),
    detail: `${noTargetAgree} corroborated as no-target (floor ${Math.min(MIN_EQUAL, noTargetSample.length)}), ${noTargetContradict} contradicted, ${noTargetUnavailable} unavailable (of ${noTargetSample.length} sampled)`,
  },
  {
    name: 'no_contradiction_with_the_chain',
    pass: noTargetOnChain === 0,
    detail: `${noTargetOnChain} transaction(s) claimed payloads the chain does not show`,
  },
  {
    name: 'debt_is_reported_not_hidden',
    pass: document.counts.rowsWithoutEnvelope >= 0
      && document.counts.rowsWithoutInstructions >= 0
      && document.counts.rowsWithoutEnvelope + document.counts.rowsWithoutInstructions <= document.counts.journalRows,
    detail: `rows ${document.counts.journalRows}, without envelope ${document.counts.rowsWithoutEnvelope}, without instructions ${document.counts.rowsWithoutInstructions}`,
  },
  {
    name: 'document_shape_matches_the_network_harvester',
    pass: Array.isArray(document.transactions)
      && Array.isArray(document.signatures)
      && typeof document.counts === 'object'
      && typeof document.slotRange === 'object',
    detail: `source: ${document.source}`,
  },
];

const verdict = checks.every((c) => c.pass);
const report = {
  generatedAt: new Date().toISOString(),
  program: PROGRAM,
  rpc: RPC,
  daemonSeconds: SECONDS,
  sampled: sample.length,
  minEqual: MIN_EQUAL,
  noTargetSampled: noTargetSample.length,
  noTargetAgree,
  noTargetContradict,
  noTargetUnavailable,
  equal, different, unavailable,
  journalCounters: counters,
  harvestCounts: document.counts,
  harvestMethod: document.method,
  networkAttempts: harvestReport.networkAttempts,
  differences,
  samples,
  checks,
  verdict: verdict ? 'ALL PASS' : 'FAILURE',
};
fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

console.log('\nchecks:');
for (const check of checks) {
  console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
}
console.log(`\nreport: ${REPORT}`);
console.log(verdict ? 'REEFLOG-HARVEST E2E: ALL PASS' : 'REEFLOG-HARVEST E2E: FAILURE');
process.exit(verdict ? 0 : 1);
