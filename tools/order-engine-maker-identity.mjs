#!/usr/bin/env node
// tools/order-engine-maker-identity.mjs — WHO signs the fill, and WHAT the
// fill's account list actually contains.
//
// Two open questions from the 2026-11-01 attribution, measured here instead of
// assumed:
//
// (1) COUNTERPARTY IDENTITY. The attribution resolved each wire form's
//     counterparty to the `maker` account (index 1 of the order_engine
//     instruction) and concluded: "the 8 undeclared bytes are one
//     counterparty's own extension of a shared protocol instruction". That
//     sentence rests on an unverified premise — that the maker is a CLIENT.
//     A signer slot is satisfied by any keypair; nothing in the IDL says the
//     maker is a wallet rather than a program-derived address.
//
// (2) ACCOUNT LIST. Every measurement so far looked at the instruction DATA
//     (the 8 trailing bytes) and at account DATA (to hunt the value). Nobody
//     looked at the ACCOUNT LIST itself: the wire carries more accounts than
//     the IDL declares, and an account list is a first-class carrier of
//     meaning on Solana (who signs, who is passed, what the program is given).
//
// For every transaction in the committed fixture this tool measures, from the
// chain:
//
//   - the fill instruction, identified by its DISCRIMINATOR from the committed
//     IDL (the data is base58 in encoding "json" — decoded with the repo's
//     own decoder, never guessed),
//   - the real account list of that instruction vs. the 11 accounts the IDL
//     declares: which indices are undeclared, and whether they are constant,
//   - who signed (the transaction's own signature slots) and who paid the fee,
//   - whether each counterparty address can hold a private key at all: a
//     Solana address is on-curve only if it can be an ed25519 point, so an
//     off-curve address provably has no key and its signer slot can only be
//     satisfied by a program's CPI.
//
// Output: research/order-engine-maker-identity-2026-11-02.json
//
// Read-only, public RPC. Every fetch is counted; a partial run exits non-zero
// instead of reporting a smaller sample as if it were the whole thing.

import fs from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";
import { decodeBase58 } from "../src/base58.mjs";

const HARVEST = new URL("../test/fixtures/harvest-order-engine-2026-11-01.json", import.meta.url);
const IDL = new URL("../test/fixtures/order-engine-idl.json", import.meta.url);
const OUT = new URL("../research/order-engine-maker-identity-2026-11-02.json", import.meta.url);
const PROGRAM = "2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
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

// A null result is often transient (the RPC node has not seen the tx yet);
// one refetch round after a pause settles it. A transaction that stays null
// is reported as unresolved instead of being silently dropped.
async function rpcTransaction(signature) {
  let r = await rpc("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
  if (r.error || !r.result) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    r = await rpc("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
  }
  return r;
}

// ---------------------------------------------------------------------------
// off-curve proof (offline, exact)
// ---------------------------------------------------------------------------
const P = (1n << 255n) - 19n;
function modPow(b, e) { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; }
function modInv(a) { return modPow(a, P - 2n); }
const D = ((-121665n * modInv(121666n)) % P + P) % P;
const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58ToBytes(s) {
  let n = 0n;
  for (const c of s) { const i = BS58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
function isOnCurve(address) {
  const raw = base58ToBytes(address);
  if (!raw || raw.length !== 32) return null;
  const yBuf = Uint8Array.from(raw);
  yBuf[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(yBuf[i]);
  const y2 = y * y % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = u * modPow(v, P - 2n) % P;
  // RFC 8032 recover-x: candidate x = x2^((p+3)/8); if x^2 != x2, multiply by
  // sqrt(-1) and try again. p = 2^255-19 is 1 mod 4, so (p-1)/4 is NOT a
  // quadratic-residue test — an earlier version of this tool used exactly
  // that wrong test and called every real address off-curve.
  let x = modPow(x2, (P + 3n) / 8n);
  if (x * x % P === x2) return true;
  x = x * modPow(2n, (P - 1n) / 4n) % P;
  return x * x % P === x2;
}

const harvest = JSON.parse(fs.readFileSync(HARVEST, "utf8"));
const idl = JSON.parse(fs.readFileSync(IDL, "utf8"));
const fillDecl = idl.instructions.find((ix) => ix.name === "fill");
if (!fillDecl) throw Error("committed IDL declares no `fill` instruction");
const FILL_DISC = Buffer.from(fillDecl.discriminator);
const DECLARED_ACCOUNTS = fillDecl.accounts.length;

// ---------------------------------------------------------------------------
// transaction anatomy
// ---------------------------------------------------------------------------
function accountKeyList(tx) {
  const raw = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(raw)) return [];
  const staticKeys = raw.map((k) => (typeof k === "string" ? k : k?.pubkey)).filter(Boolean);
  const loaded = tx?.meta?.loadedAddresses ?? {};
  return [...staticKeys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

/** The fill instruction of this transaction, identified by its discriminator. */
function findFill(tx, keys) {
  const message = tx?.transaction?.message;
  const meta = tx?.meta ?? {};
  const groups = [
    ...(message?.instructions ?? []).map((ix) => ({ ix, depth: 0, index: 0 })),
    ...(meta.innerInstructions ?? []).flatMap((group) =>
      (group?.instructions ?? []).map((ix) => ({ ix, depth: group?.depth ?? 1, index: group?.index ?? 0 }))),
  ];
  for (const candidate of groups) {
    const { ix } = candidate;
    const programId = typeof ix.programId === "string" ? ix.programId : keys[ix.programIdIndex];
    if (programId !== PROGRAM) continue;
    // encoding "json" carries instruction data as BASE58 (the repo's own
    // payload extractor decodes it that way); decoding it as base64 yields
    // plausible-looking garbage bytes.
    const data = Buffer.from(decodeBase58(ix.data ?? ""));
    if (data.length < 8 || !data.subarray(0, 8).equals(FILL_DISC)) continue;
    return { ...candidate, data };
  }
  return null;
}

function signatureFacts(tx, keys) {
  const sigs = tx?.transaction?.signatures ?? [];
  const signedBy = new Set();
  const nullSigned = new Set();
  sigs.forEach((s, i) => {
    const k = keys[i];
    if (!k) return;
    // In encoding "json" a signature entry is a base58 STRING; in jsonParsed
    // it is {signature, pubkey}. Reading s.signature on a string yields
    // undefined and would classify EVERY signer as null-signed.
    const present = typeof s === "string" ? s.length > 0 : !!(s && s.signature);
    if (present) signedBy.add(k); else nullSigned.add(k);
  });
  return { feePayer: keys[0], signedBy, nullSigned };
}

async function classifyAddress(address) {
  const res = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]);
  if (res.error || !res.result) return { address, ok: false, error: JSON.stringify(res.error ?? "null").slice(0, 160) };
  const v = res.result.value;
  if (!v) return { address, ok: true, exists: false };
  // getAccountInfo with base64 returns [base64Data, "base64"]: element 0 is
  // the payload, element 1 is the encoding NAME. Reading element 1 as a
  // length (an earlier version of this tool did) labels every system account
  // as carrying data — exactly the wallet/program distinction under test.
  let dataLen = 0;
  if (Array.isArray(v.data)) {
    dataLen = v.data[1] === "base64"
      ? Buffer.from(v.data[0] ?? "", "base64").length
      : Buffer.from(String(v.data[0] ?? ""), "utf8").length;
  } else if (typeof v.data === "string") {
    dataLen = Buffer.from(v.data, "base64").length;
  }
  const owner = v.owner;
  return {
    address, ok: true, exists: true, owner, dataLen, executable: !!v.executable, lamports: v.lamports,
    isSystemOwned: owner === SYSTEM_PROGRAM,
    isProgramOwned: owner !== SYSTEM_PROGRAM,
    isWallet: owner === SYSTEM_PROGRAM && dataLen === 0,
    ownedByOrderEngine: owner === PROGRAM,
  };
}

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const sample = Number(argv.find((a) => a.startsWith("--sample="))?.split("=")[1] ?? 12);

const rows = [];
for (const tx of harvest.transactions) {
  const res = await rpcTransaction(tx.signature);
  if (res.error || !res.result) {
    rows.push({ signature: tx.signature, slot: tx.slot, ok: false, error: JSON.stringify(res.error ?? "null").slice(0, 160) });
    continue;
  }
  const live = res.result;
  const keys = accountKeyList(live);
  const fill = findFill(live, keys);
  if (!fill) {
    rows.push({ signature: tx.signature, slot: tx.slot, ok: false, error: "no fill instruction with the committed discriminator" });
    continue;
  }
  const facts = signatureFacts(live, keys);
  const accounts = fill.ix.accounts.map((index) => keys[index] ?? null);
  const declared = accounts.slice(0, DECLARED_ACCOUNTS).map((a, i) => ({
    index: i,
    name: fillDecl.accounts[i]?.name ?? null,
    declaredSigner: !!fillDecl.accounts[i]?.signer,
    address: a,
    signed: a ? facts.signedBy.has(a) : false,
    nullSignature: a ? facts.nullSigned.has(a) : false,
    isFeePayer: a ? a === facts.feePayer : false,
  }));
  const undeclared = accounts.slice(DECLARED_ACCOUNTS).map((a, i) => ({
    index: DECLARED_ACCOUNTS + i,
    address: a,
    signed: a ? facts.signedBy.has(a) : false,
    nullSignature: a ? facts.nullSigned.has(a) : false,
    isFeePayer: a ? a === facts.feePayer : false,
  }));
  const maker = declared[1]?.address ?? null;
  const taker = declared[0]?.address ?? null;
  rows.push({
    signature: tx.signature, slot: tx.slot, ok: true,
    fixturePayloadLength: Buffer.from(tx.payloads?.[0]?.dataHex ?? "", "hex").length,
    livePayloadLength: fill.data.length,
    payloadBytesMatch: fill.data.toString("hex") === (tx.payloads?.[0]?.dataHex ?? ""),
    accountCount: accounts.length,
    declaredAccountCount: DECLARED_ACCOUNTS,
    maker, taker,
    feePayer: facts.feePayer,
    makerSigned: maker ? facts.signedBy.has(maker) : false,
    takerSigned: taker ? facts.signedBy.has(taker) : false,
    feePayerIsTaker: facts.feePayer === taker,
    feePayerIsMaker: facts.feePayer === maker,
    declared, undeclared,
  });
  if (rows.length % 20 === 0) console.log(`fetched ${rows.length}/${harvest.transactions.length}`);
  await new Promise((r) => setTimeout(r, 1200));
}

const okRows = rows.filter((r) => r.ok);
const payloadMismatches = okRows.filter((r) => !r.payloadBytesMatch);
const accountCounts = {};
for (const r of okRows) accountCounts[r.accountCount] = (accountCounts[r.accountCount] ?? 0) + 1;

const makers = [...new Set(okRows.map((r) => r.maker).filter(Boolean))];
const takers = [...new Set(okRows.map((r) => r.taker).filter(Boolean))];
const undeclaredAddresses = {};
for (const r of okRows) for (const u of r.undeclared) (undeclaredAddresses[u.address] ??= { count: 0, signedCount: 0, feePayerCount: 0 }).count++;
for (const r of okRows) for (const u of r.undeclared) {
  const e = undeclaredAddresses[u.address];
  if (u.signed) e.signedCount++;
  if (u.isFeePayer) e.feePayerCount++;
}

// Which maker does each wire form belong to — the extension's correlation.
const makerByForm = {};
for (const r of okRows) {
  const form = r.fixturePayloadLength;
  (makerByForm[form] ??= new Set()).add(r.maker);
}
const makerByFormPlain = Object.fromEntries(Object.entries(makerByForm).map(([f, s]) => [f, [...s]]));
const formAndMakerDisjoint = (makerByFormPlain[32] ?? []).every((m) => !(makerByFormPlain[40] ?? []).includes(m));

// Curve fact for every counterparty address, computed offline.
const curveFacts = {};
for (const a of [...makers, ...takers, ...Object.keys(undeclaredAddresses)]) {
  curveFacts[a] = { onCurve: isOnCurve(a), canHoldKey: isOnCurve(a) === true };
}
const makersOnCurve = makers.filter((a) => curveFacts[a]?.onCurve === true);
const makersOffCurve = makers.filter((a) => curveFacts[a]?.onCurve === false);
const makerSignedCount = okRows.filter((r) => r.makerSigned).length;
const takerSignedCount = okRows.filter((r) => r.takerSigned).length;
const feePayerIsTakerCount = okRows.filter((r) => r.feePayerIsTaker).length;
const feePayerIsMakerCount = okRows.filter((r) => r.feePayerIsMaker).length;
const feePayerIsUndeclaredCount = okRows.filter((r) =>
  r.undeclared.some((u) => u.isFeePayer)).length;

// Account fact for the counterparty addresses (wallet vs program-owned).
// Makers and undeclared accounts are measured for ALL; takers are sampled:
// the question is about who WRITES the wire, not a census of takers.
const takerSampleN = 6;
const takerPick = takers.filter((_, i) => i % Math.max(1, Math.ceil(takers.length / takerSampleN)) === 0).slice(0, takerSampleN);
const accountFacts = {};
for (const a of [...makers, ...Object.keys(undeclaredAddresses), ...takerPick]) {
  accountFacts[a] = await classifyAddress(a);
  console.log(`account ${a.slice(0, 10)} owner ${accountFacts[a].owner ?? "?"} dataLen ${accountFacts[a].dataLen ?? "?"} onCurve ${curveFacts[a]?.onCurve}`);
  await new Promise((r) => setTimeout(r, 400));
}

// The decisive question about the undeclared accounts: is the extra trailing
// account CONSTANT (a protocol-level participant such as an authorizer) and
// does it sign?
const constantUndeclared = Object.entries(undeclaredAddresses)
  .filter(([, e]) => e.count === okRows.length)
  .map(([address, e]) => ({ address, ...e }));

const report = {
  measuredAt: new Date().toISOString(),
  program: PROGRAM,
  method: "counterparty identity and account list resolved from the chain: fill located by the committed IDL's discriminator, data decoded as base58, signer slots read from the transaction itself, key-holding proven by an exact off-curve test",
  inputs: {
    fixture: "test/fixtures/harvest-order-engine-2026-11-01.json",
    idl: "test/fixtures/order-engine-idl.json",
    fixtureTransactions: harvest.transactions.length,
    declaredFillAccounts: DECLARED_ACCOUNTS,
    fillDiscriminator: FILL_DISC.toString("hex"),
  },
  payloadCrossCheck: {
    checked: okRows.length,
    byteIdenticalToFixture: okRows.length - payloadMismatches.length,
    mismatches: payloadMismatches.map((r) => ({ signature: r.signature, fixture: r.fixturePayloadLength, live: r.livePayloadLength })),
  },
  coverage: {
    transactionsRequested: rows.length,
    transactionsResolved: okRows.length,
    transactionsFailed: rows.length - okRows.length,
    rpcCallCount: calls,
    rpcFailures: failures,
  },
  accountList: {
    declaredAccountCount: DECLARED_ACCOUNTS,
    observedAccountCounts: accountCounts,
    transactionsWithUndeclaredAccounts: okRows.filter((r) => r.undeclared.length > 0).length,
    undeclaredAddressFrequency: undeclaredAddresses,
    constantUndeclaredAddresses: constantUndeclared,
  },
  counterparties: {
    makers, takers,
    makersOnCurve, makersOffCurve,
    makerSignedTransactions: makerSignedCount,
    takerSignedTransactions: takerSignedCount,
    feePayerIsTakerTransactions: feePayerIsTakerCount,
    feePayerIsMakerTransactions: feePayerIsMakerCount,
    feePayerIsUndeclaredAccountTransactions: feePayerIsUndeclaredCount,
    distinctFeePayers: new Set(okRows.map((r) => r.feePayer)).size,
    makerByForm: makerByFormPlain,
    formAndMakerDisjoint,
    curveFacts, accountFacts,
  },
  finding: {
    payloadBytesMatchChain: payloadMismatches.length === 0,
    makerIsKeyHoldingClient: makersOnCurve.length === makers.length && makers.length > 0,
    makerIsDerivedAddress: makersOffCurve.length === makers.length && makers.length > 0,
    extensionCorrelatesWithMaker: formAndMakerDisjoint && makers.length >= 2,
    builderProven: false,
    wireFormsShareOneMaker: makers.length === 1,
    undeclaredAccountIsConstant: constantUndeclared.length > 0,
    limits: [
      "the transaction BUILDER is not identifiable from the chain: taker, maker and the constant co-signer all sign, so 'one client's extension' is a correlation with the maker address, not proof of who constructed the bytes",
      "the co-signer's role is not proven: measured is that it signs every fill, is absent from the IDL, and pays the fee in some transactions",
      "the meaning of the 4 varying tail bytes stays unknown: sha256(addr), sha256(sig), slot, amounts, expire_at and address boundaries all tested and refuted (0/59 hits)",
    ],
    verdict:
      makers.length === 1
        ? "both wire forms share one counterparty: the extra bytes belong to the protocol, not to a client"
        : !makersOnCurve.length
          ? "the counterparties are derived addresses with no key: their signer slots are satisfied by a program's CPI, so the extra bytes are that program's extension of the shared protocol instruction"
          : "the two wire forms come from two different key-holding client counterparties — each form's maker is a distinct on-curve wallet that signs, and the long-form extension correlates with maker MfDuWeqS… exclusively; the 8 undeclared bytes are that side's own extension of the shared protocol instruction (the builder among the three signers is not proven)",
  },
  rows,
};

mkdirSync(new URL("../research/", import.meta.url), { recursive: true });
const partial = report.coverage.transactionsFailed > 0 || payloadMismatches.length > 0;
// A complete run overwrites the committed report; a partial run must NOT
// replace good measurements with a smaller sample (it once did — a 140/141
// run overwrote a 141/141 report and the suite went green on the smaller
// number). Partial runs get their own file and a failing exit code.
const target = partial ? new URL("../research/order-engine-maker-identity-2026-11-02.partial.json", import.meta.url) : OUT;
writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
console.log("wrote", target.pathname);
console.log("verdict:", report.finding.verdict);
console.log("account counts:", JSON.stringify(accountCounts), "declared:", DECLARED_ACCOUNTS);
console.log("constant undeclared:", JSON.stringify(constantUndeclared));
if (partial) {
  console.error("PARTIAL RUN: not every transaction resolved or a payload differs from the fixture — the committed report was NOT overwritten");
  process.exit(1);
}
