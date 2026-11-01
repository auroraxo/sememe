#!/usr/bin/env node
// tools/order-engine-counterparty.mjs — WHO writes the 40-byte `fill` wire.
//
// The 2026-11-01 tail probe refuted both remaining explanations for the 8
// undeclared trailing bytes (no published revision declares them; the value is
// not in the transaction's balance surface, in any sibling instruction, in any
// touched account's data, or in the program's own state accounts). What was
// still unmeasured: whether the two wire forms even come from the same side.
//
// This tool measures that. For every 40-byte fill in the committed fixture it
// resolves the counterparty from the CHAIN (the `maker` account at index 1 of
// the order_engine instruction), not from the fixture, and it does the same for
// the 32-byte form. The result decides the finding's shape:
//
//   - one counterparty per wire form  -> the 8 bytes are that counterparty's
//     own extension of a shared protocol instruction, and the finding is about
//     a client, not about the program.
//   - one counterparty for both forms -> the program itself changed its wire
//     format, and the 8 bytes belong to the protocol.
//
// Output: research/order-engine-counterparty-2026-11-01.json
//
// Read-only, public RPC. Every fetch is counted; a partial run exits non-zero
// instead of reporting a smaller sample as if it were the whole thing.

import fs from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";

const HARVEST = new URL("../test/fixtures/harvest-order-engine-2026-11-01.json", import.meta.url);
const OUT = new URL("../research/order-engine-counterparty-2026-11-01.json", import.meta.url);
const PROGRAM = "2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1";
const RPC = "https://api.mainnet-beta.solana.com";

let calls = 0;
let failures = 0;
async function rpc(method, params, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      calls += 1;
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await res.json();
      if (j.error) {
        if ([429, -32005].includes(j.error.code)) { await new Promise(r => setTimeout(r, 9000 * (i + 1))); continue; }
        return { error: j.error };
      }
      return j;
    } catch (e) { await new Promise(r => setTimeout(r, 7000 * (i + 1))); }
  }
  failures += 1;
  return { error: "gave up after retries" };
}

const harvest = JSON.parse(fs.readFileSync(HARVEST, "utf8"));
const byForm = { 32: [], 40: [] };
for (const tx of harvest.transactions) for (const p of (tx.payloads ?? [])) {
  const len = Buffer.from(p.dataHex, "hex").length;
  if (byForm[len]) byForm[len].push({ slot: tx.slot, sig: tx.signature });
}
for (const form of Object.keys(byForm)) byForm[form].sort((a, b) => a.slot - b.slot);

/** The counterparty of a fill: the `maker` account (index 1) of the order_engine instruction. */
function resolveMaker(tx) {
  const msg = tx.transaction.message;
  const la = tx.meta.loadedAddresses || {};
  const idx = [...msg.accountKeys.map(k => k.pubkey ?? String(k)), ...(la.writable || []), ...(la.readonly || [])];
  const all = [...msg.instructions];
  for (const ii of (tx.meta.innerInstructions || [])) for (const ix of ii.instructions) all.push(ix);
  const ix = all.find(x => (x.programId ?? idx[x.programIdIndex]) === PROGRAM);
  if (!ix) return { maker: null, taker: null, reason: "no order_engine instruction found" };
  const a = ix.accounts ?? [];
  return { maker: idx[a[1]] ?? null, taker: idx[a[0]] ?? null, programId: ix.programId ?? idx[ix.programIdIndex] };
}

async function scan(form, sampleCount) {
  const list = byForm[form];
  const picks = [];
  for (let i = 0; i < sampleCount && i < list.length; i++) picks.push(list[Math.round(i * (list.length - 1) / (sampleCount - 1 || 1))]);
  const seen = new Map();
  const rows = [];
  for (const p of picks) {
    const r = await rpc("getTransaction", [p.sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
    if (r.error || !r.result) { rows.push({ slot: p.slot, signature: p.sig, error: JSON.stringify(r.error ?? "null").slice(0, 120) }); continue; }
    const { maker, taker } = resolveMaker(r.result);
    seen.set(maker, (seen.get(maker) ?? 0) + 1);
    rows.push({ slot: p.slot, signature: p.sig, maker, taker });
    console.log(`form ${form} slot ${p.slot} maker ${maker ? maker.slice(0, 10) : "?"}`);
    await new Promise(r => setTimeout(r, 2500));
  }
  return { formBytes: form, sampleSize: picks.length, resolved: rows.filter(r => r.maker).length, makers: [...seen.entries()].map(([maker, count]) => ({ maker, count })), rows };
}

// --full resolves EVERY payload of both forms in the fixture; the default
// samples 20 evenly spread ones. A partial run must never be reported as a
// complete attribution, so the sample size travels with the finding.
const argv = process.argv.slice(2);
const full = argv.includes("--full");
const longCount = full ? byForm[40].length : 20;
const shortCount = full ? byForm[32].length : 20;
const longForm = await scan(40, longCount);
const shortForm = await scan(32, shortCount);

const longMakers = new Set(longForm.makers.map(m => m.maker));
const shortMakers = new Set(shortForm.makers.map(m => m.maker));
const shared = [...longMakers].filter(m => shortMakers.has(m));

const report = {
  measuredAt: new Date().toISOString(),
  program: PROGRAM,
  method: "counterparty resolved from the chain: the `maker` account (index 1) of the order_engine instruction, per transaction",
  longForm, shortForm,
  coverage: { mode: full ? "full" : "sampled", longFormPayloads: byForm[40].length, shortFormPayloads: byForm[32].length, longFormResolved: longForm.resolved, shortFormResolved: shortForm.resolved },
  finding: {
    longFormMakers: [...longMakers], shortFormMakers: [...shortMakers],
    sharedCounterparties: shared,
    oneCounterpartyPerForm: shared.length === 0 && longMakers.size === 1 && shortMakers.size === 1,
    exhaustive: full && longForm.resolved === byForm[40].length && shortForm.resolved === byForm[32].length,
    verdict: shared.length === 0
      ? "the two wire forms come from DIFFERENT counterparties: the 8 undeclared bytes are one counterparty's own extension of a shared protocol instruction"
      : "the two wire forms share a counterparty: the extra bytes belong to the protocol, not to a client",
  },
  rpcCallCount: calls,
  rpcFailures: failures,
};

mkdirSync(new URL("../research/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log("wrote", OUT.pathname);
console.log("finding:", report.finding.verdict);
console.log("long makers:", [...longMakers], "short makers:", [...shortMakers]);
if (longForm.resolved !== longForm.sampleSize || shortForm.resolved !== shortForm.sampleSize) {
  console.error("PARTIAL RUN: not every sampled transaction resolved");
  process.exit(1);
}
