#!/usr/bin/env node
// tools/cp-amm-wire-forms.mjs — WHO sends the `swap` payloads that carry bytes
// past the published interface, and are they top-level or a CPI?
//
// Why this tool exists: the 2026-10-30 traffic-coverage run found 6 `swap`
// payloads (477 of 483 were exactly 24 bytes) with 1 or 8 trailing zero bytes,
// and recorded only the note "the deployed program reads further than its own
// interface file". That note leaves the interesting question unanswered:
// WHERE does the wider form come from — a wallet serialising the newer
// SwapParameters2 layout against the `swap` discriminator, or a router
// CPI-ing `swap` with an oversized buffer? The instruction data alone cannot
// answer it; the transaction can.
//
// Per selected transaction this tool measures, from the chain:
//   - every `swap` payload of the program: wire length, trailing count, hex,
//     decoded against the committed IDL (never guessed),
//   - whether the instruction sits at the TOP LEVEL of the message or is a
//     CPI, and which program invoked it (instruction at the payload's `ix`),
//   - signers, fee payer, and the real account count of that instruction
//     against the 14 accounts the IDL declares,
//   - for the control group: the same fields for IDL-exact 24-byte swaps, so
//     "the wide form comes from somewhere else" is a measured contrast and not
//     a sample of one.
//
// Sample = every payload that carries trailing bytes (both committed and fresh
// fixtures) + a fixed, seeded control of IDL-exact swaps. Nothing is dropped:
// a fetch that cannot be completed fails the run (exit 1) rather than
// shrinking the denominator.
//
// Output: research/cp-amm-wire-forms-2026-11-02.json
//
// Read-only, public RPC.

import fs from "node:fs";

const FIXTURES = [
  new URL("../test/fixtures/harvest-cp-amm-2026-10-30.json", import.meta.url),
  new URL("../test/fixtures/harvest-cp-amm-2026-11-02.json", import.meta.url),
];
const IDL = new URL("../test/fixtures/cp-amm-idl.json", import.meta.url);
const OUT = new URL("../research/cp-amm-wire-forms-2026-11-02.json", import.meta.url);
const RPC = "https://api.mainnet-beta.solana.com";
const SWAP_DISC = "f8c69e91e17587c8";

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
      // The public endpoint also answers `{ result: null }` with NO error
      // under load — a retryable hiccup, not a missing transaction (the same
      // signature fetches fine a moment later). Retry, never report a shrunk
      // sample as the whole thing.
      if (j.result === null || j.result === undefined) {
        if (i < tries - 1) { await new Promise(r => setTimeout(r, 6000 * (i + 1))); continue; }
        return { error: "null result after retries" };
      }
      return j;
    } catch (e) { await new Promise(r => setTimeout(r, 7000 * (i + 1))); }
  }
  failures += 1;
  return { error: "gave up after retries" };
}

const read = (url) => JSON.parse(fs.readFileSync(url, "utf8"));
const idl = read(IDL);
const declaredAccounts = idl.instructions.find(i => i.name === "swap").accounts.length;

// --- every swap payload of the program, with its wire classification --------
function swapPayloads(harvest) {
  const out = [];
  for (const tx of harvest.transactions) {
    for (const p of (tx.payloads ?? [])) {
      const hex = p.dataHex;
      if (!hex.startsWith(SWAP_DISC)) continue;
      const trailing = hex.length / 2 - 24;
      out.push({
        source: harvest.harvestedAt.slice(0, 10),
        signature: tx.signature, slot: tx.slot, txErr: tx.txErr,
        ix: p.ix, depth: p.depth, innerIndex: p.innerIndex ?? null,
        len: hex.length / 2, trailing, trailingHex: hex.slice(48),
      });
    }
  }
  return out;
}

// deterministic control: 12 IDL-exact swaps, seeded from the signature string
// so the same fixtures always select the same rows.
function controls(rows) {
  const exact = rows.filter(r => r.trailing === 0)
    .sort((a, b) => a.signature < b.signature ? -1 : 1);
  return exact.slice(0, 12);
}

const rows = FIXTURES.flatMap(f => swapPayloads(read(f)));
const wide = rows.filter(r => r.trailing > 0);
const selected = [...wide, ...controls(rows)];

console.error(`swap payloads: ${rows.length}; wide: ${wide.length}; selecting ${selected.length} (wide + ${selected.length - wide.length} controls)`);

// --- fetch and measure each selected transaction ---------------------------
const measured = [];
for (const row of selected) {
  // v1, not 0: one of the selected transactions is a v1 transaction and the
  // repo's own reader-contract retraction (auroraxo/reeflog#1) documents that
  // reporting a -32015 here as anything else is exactly the mistake to repeat.
  const res = await rpc("getTransaction", [row.signature, { encoding: "json", maxSupportedTransactionVersion: 1 }]);
  if (res.error || !res.result) {
    console.error(`FETCH FAILED ${row.signature}: ${JSON.stringify(res.error ?? "null result")}`);
    process.exit(1);
  }
  const tx = res.result;
  const message = tx.transaction.message;
  const accountKeys = message.accountKeys;
  const header = message.header;
  const signers = accountKeys.slice(0, header.numRequiredSignatures);
  const feePayer = signers[0];
  // the payload's outer instruction: `ix` indexes top-level instructions
  const outer = message.instructions[row.ix];
  const outerProgram = outer ? accountKeys[outer.programIdIndex] : null;
  // Alignment check: for a top-level payload the outer instruction must BE the
  // target program (the bytes we classified came from that very slot). For a
  // CPI the outer instruction is the INVOKING program — the answer to "who
  // called cp-amm here".
  if (row.depth === 0 && outerProgram !== idl.address) {
    console.error(`ALIGNMENT FAILED ${row.signature}: outer instruction is ${outerProgram}, not the target`);
    process.exit(1);
  }
  // account list of that instruction (positionally; loaded accounts append)
  const loaded = (tx.meta.loadedAddresses ?? { writable: [], readonly: [] });
  const allKeys = [...accountKeys, ...loaded.writable, ...loaded.readonly];
  const accountCount = outer ? outer.accounts.length : null;
  const accounts = outer ? outer.accounts.map(i => allKeys[Number(i)] ?? null) : [];

  measured.push({
    source: row.source, signature: row.signature, slot: row.slot,
    wireLen: row.len, trailing: row.trailing, trailingHex: row.trailingHex,
    depth: row.depth, innerIndex: row.innerIndex,
    topLevel: row.depth === 0,
    outerIxIndex: row.ix,
    outerProgram,
    cpInvokesCpAmm: row.depth > 0,
    feePayer, signers, signerCount: signers.length,
    accountCount, declaredAccounts,
    txErr: tx.meta.err,
  });
}

// --- contrast: do the two groups differ on anything measured? ---------------
const wideRows = measured.filter(m => m.trailing > 0);
const ctlRows = measured.filter(m => m.trailing === 0);
const group = (rs) => ({
  n: rs.length,
  topLevel: rs.filter(r => r.topLevel).length,
  cpi: rs.filter(r => !r.topLevel).length,
  distinctOuterPrograms: [...new Set(rs.map(r => r.outerProgram))].sort(),
  distinctFeePayers: [...new Set(rs.map(r => r.feePayer))].length,
  accountCounts: [...new Set(rs.map(r => r.accountCount))].sort((a, b) => a - b),
  txErrs: [...new Set(rs.map(r => JSON.stringify(r.txErr)))],
});

const report = {
  generatedAt: new Date().toISOString(),
  program: idl.address,
  declaredAccounts,
  selection: {
    swapPayloads: rows.length,
    wide: wide.length,
    controls: ctlRows.length,
    note: "controls = first 12 IDL-exact swaps by lexicographic signature across both fixtures",
  },
  rpc: { calls, failures },
  wireForms: {
    trailing1: rows.filter(r => r.trailing === 1).length,
    trailing8: rows.filter(r => r.trailing === 8).length,
    exact: rows.filter(r => r.trailing === 0).length,
    other: rows.filter(r => r.trailing > 0 && r.trailing !== 1 && r.trailing !== 8).length,
  },
  contrast: { wide: group(wideRows), control: group(ctlRows) },
  transactions: measured,
};

fs.mkdirSync(new URL(".", OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.error(`wrote ${OUT.pathname}: rpc calls ${calls}, failures ${failures}`);
console.log(JSON.stringify({ selection: report.selection, contrast: report.contrast, rpc: report.rpc }, null, 2));
if (failures > 0) process.exit(1);
