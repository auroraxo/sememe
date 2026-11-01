// tools/order-engine-tail-probe.mjs — the state-side probe for the 8 undeclared
// tail bytes of the Jupiter order_engine `fill` wire.
//
// tail-hypotheses.mjs refuted every interpretation INSIDE the instruction bytes
// and the transaction surface. This probe asks the two questions left open on
// 01.11. and answers them with chain responses:
//   A. "never-published revision": a fresh pull of BOTH published IDL surfaces
//      (the canonical anchor:idl account, the program-owned metadata account)
//      — a 4th declared arg would end the finding, so the fingerprints decide.
//   B. "value from state outside the instruction bytes": for each sampled
//      40-byte fill, does the varying u32 appear in the transaction's balance
//      surface, in the sibling instruction bytes, in every touched account's
//      data, or in the program's own state accounts? Each answer is counted,
//      not asserted.
//
// Writes research/order-engine-tail-probe-2026-11-01.json.
// Public RPC only, read-only; every fetch is counted and reported.

import fs from "node:fs";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/canonical.mjs";

const HOME = process.env.HOME;
const HARVEST = new URL("../test/fixtures/harvest-order-engine-2026-11-01.json", import.meta.url);
const OUT = new URL("../research/order-engine-tail-probe-2026-11-01.json", import.meta.url);
const PROGRAM = "2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1";
const RPC = "https://api.mainnet-beta.solana.com";
const KNOWN_FINGERPRINT = "f13a31e663c13c0fe47aa4c5a147951eaf0cb5c4e3bb825da4b8ead4e8988c91";

const calls = [];
let failures = 0;
async function rpc(method, params, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      calls.push({ method, at: Date.now() });
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await res.json();
      if (j.error) {
        if ([429, -32005].includes(j.error.code)) { await new Promise(r => setTimeout(r, 8000 * (i + 1))); continue; }
        return { error: j.error };
      }
      return j;
    } catch (e) { await new Promise(r => setTimeout(r, 6000 * (i + 1))); }
  }
  failures += 1;
  return { error: "gave up after retries" };
}

const report = { measuredAt: new Date().toISOString(), program: PROGRAM, rpc: RPC, rpcCallCount: 0, rpcFailures: 0 };

// ---------- part A: both published IDL surfaces ----------
import { addresses, decodeAccount, rpcAccounts } from "../src/acquire.mjs";
const { metadata, anchor } = await addresses(PROGRAM);
const acc = await rpcAccounts(RPC, [metadata, anchor], fetch, 3);
if (acc.error) throw Error(`IDL probe RPC failed: ${acc.error}`);
report.idlSurfaces = [];
let idlMatched = false;
for (const [source, address, account] of [["metadata", metadata, acc.accounts[0]], ["anchor", anchor, acc.accounts[1]]]) {
  const entry = { source, address, present: !!account };
  if (account) {
    try {
      const idl = decodeAccount(account, source, PROGRAM);
      const fingerprint = createHash("sha256").update(canonicalJson(idl) + "\n").digest("hex");
      entry.fingerprint = `sha256:${fingerprint}`;
      entry.matchesReceiptFingerprint = fingerprint === KNOWN_FINGERPRINT;
      entry.declaredFillArgs = (idl.instructions.find(i => i.name === "fill")?.args ?? []).map(a => `${a.name}:${a.type}`);
      if (entry.matchesReceiptFingerprint) idlMatched = true;
    } catch (e) { entry.error = String(e.message).slice(0, 140); }
  }
  report.idlSurfaces.push(entry);
}
report.refutedNeverPublishedRevision = idlMatched;

// ---------- part B: state-side search ----------
const harvest = JSON.parse(fs.readFileSync(HARVEST, "utf8"));
const longs = [];
for (const tx of harvest.transactions) for (const p of (tx.payloads ?? [])) {
  const b = Buffer.from(p.dataHex, "hex");
  if (b.length === 40) longs.push({ slot: tx.slot, sig: tx.signature, bytes: b });
}
longs.sort((a, b) => a.slot - b.slot);
const spread = [];
for (let i = 0; i < 6; i++) spread.push(longs[Math.round(i * (longs.length - 1) / 5)]);

const tags = new Set(longs.map(l => l.bytes.readUInt32LE(36)));
if (tags.size !== 1) throw Error("expected exactly one constant tag");
const tag = [...tags][0];
const counterU64 = longs.map(l => (BigInt(tag) << 32n) | BigInt(l.bytes.readUInt32LE(32)));
const xHex = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const wHex = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const b64 = (s) => Buffer.from(s, "base64");
const hit = (buf, pat) => buf.indexOf(pat) >= 0;

const samples = [];
for (const s of spread) {
  const v = s.bytes.readUInt32LE(32);
  const r = await rpc("getTransaction", [s.sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
  if (r.error || !r.result) throw Error(`tx fetch failed for ${s.sig.slice(0, 10)}: ${JSON.stringify(r.error ?? "null").slice(0, 120)}`);
  const tx = r.result;
  const meta = tx.meta;
  const keys = [...tx.transaction.message.accountKeys.map(k => k.pubkey ?? String(k)), ...((meta.loadedAddresses || {}).writable || []), ...((meta.loadedAddresses || {}).readonly || [])];
  const ixAll = tx.transaction.message.instructions.map(ix => b64(ix.data));
  for (const ii of (meta.innerInstructions || [])) for (const ix of ii.instructions) if (ix.data) ixAll.push(b64(ix.data));

  const balanceHits = [];
  for (const [i, amount] of meta.preBalances.entries()) {
    if (hit(xHex(BigInt(amount)), wHex(v)) || BigInt(BigInt(amount) & 0xffffffffn) === BigInt(v)) balanceHits.push(`preBalances[${i}]`);
  }
  for (const [i, amount] of meta.postBalances.entries()) {
    if (hit(xHex(BigInt(amount)), wHex(v)) || BigInt(BigInt(amount) & 0xffffffffn) === BigInt(v)) balanceHits.push(`postBalances[${i}]`);
  }
  for (const side of ["preTokenBalances", "postTokenBalances"]) {
    for (const tb of (meta[side] ?? [])) {
      const amount = BigInt(tb.uiTokenAmount.amount);
      if (hit(xHex(amount), wHex(v)) || (amount & 0xffffffffn) === BigInt(v)) balanceHits.push(`${side}[${tb.accountIndex}]`);
    }
  }
  const ixHits = ixAll.map((ib, k) => (hit(ib, wHex(v)) ? k : null)).filter(k => k !== null);

  const keyList = keys.map(k => k);
  const acctResp = await rpc("getMultipleAccounts", [keyList, { encoding: "base64" }]);
  if (acctResp.error) throw Error(`account fetch failed: ${JSON.stringify(acctResp.error).slice(0, 120)}`);
  const accountHits = [];
  (acctResp.result.value || []).forEach((a, i) => {
    if (!a) return;
    if (hit(b64(a.data[0]), wHex(v))) accountHits.push(keys[i]);
  });

  samples.push({
    slot: s.slot, signature: s.sig, varyingU32: v, counterU64: counterU64[longs.indexOf(s)].toString(),
    transactionBalanceSurfaceHits: balanceHits, siblingInstructionHits: ixHits,
    touchedAccountDataHits: accountHits, accountsChecked: keyList.length,
  });
  console.log("sampled", s.slot, "v", v, "balance", balanceHits.length, "ix", ixHits.length, "accountData", accountHits.length);
  await new Promise(r => setTimeout(r, 2500));
}

// program-owned state accounts
const paResp = await rpc("getProgramAccounts", [PROGRAM, { encoding: "base64" }]);
if (paResp.error && ![-32005, 429].includes(paResp.error.code ?? 0)) {
  report.programStateAccountsError = JSON.stringify(paResp.error).slice(0, 160);
  report.programStateAccountsSearched = false;
} else {
  const accts = paResp.result ?? [];
  const hits = [];
  for (const a of accts) {
    const data = b64(a.account.data[0]);
    for (const x of counterU64) if (hit(data, xHex(x))) hits.push({ pubkey: a.pubkey, dataLen: data.length, u64: x.toString() });
  }
  report.programStateAccounts = { count: accts.length, counterHits: hits };
  report.programStateAccountsSearched = true;
}

report.samples = samples;
report.totals = {
  samples: samples.length,
  balanceSurfaceHits: samples.reduce((n, s) => n + s.transactionBalanceSurfaceHits.length, 0),
  siblingInstructionHits: samples.reduce((n, s) => n + s.siblingInstructionHits.length, 0),
  touchedAccountDataHits: samples.reduce((n, s) => n + s.touchedAccountDataHits.length, 0),
};
report.refutedValueOutsideInstructionBytes = report.totals.balanceSurfaceHits === 0 && report.totals.siblingInstructionHits === 0 && report.totals.touchedAccountDataHits === 0 && !(report.programStateAccounts?.counterHits?.length);
report.rpcCallCount = calls.length;
report.rpcFailures = failures;
fs.mkdirSync(new URL("../research/", import.meta.url), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log("wrote", OUT.pathname, "calls", calls.length, "failures", failures);
console.log("refutedNeverPublishedRevision:", report.refutedNeverPublishedRevision);
console.log("refutedValueOutsideInstructionBytes:", report.refutedValueOutsideInstructionBytes);
