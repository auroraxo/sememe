#!/usr/bin/env node
// tools/measure-live-layout-scan.mjs — the card's standing next step 3,
// now with an endpoint that answers: a LIVE layout scan for the instruction
// pairs that carry the integer-before-vec shape but had NO payload witness
// in the committed 6-block window (13.11. PULS AG, artifact
// research/count-from-header-shape-scan-2026-11-13.json, verdict
// no-third-program-witnessed-in-window).
//
// WHAT THIS TOOL ANSWERS, LIVE:
//   R1  for a program+RPC, which discriminators appear in the recent
//       transactions of that program, with chain-accepted counts;
//   R2  for every instruction the committed IDL names, whether the wire
//       matches the count-from-header hypothesis (the declared integer
//       carries the element count, no Borsh u32 prefix) OR the Borsh
//       hypothesis (u32 prefix) OR neither — measured per payload, not
//       argued, for EVERY integer declared before the vector (setCurve puts
//       xMode between numPoints and points, so adjacency is not the rule);
//   R3  whether the three unwitnessed HADRo instructions (updateSpreadConfig
//       0x0e, submitCurveUpdates 0x12, removeSpreadTriggers 0x1d) and CAMM's
//       update_operation_account (7f467728bce33d07) appear in the scanned
//       window AT ALL — the honest limit is stated when they do not.
//
// MEASURED 2026-11-14 (artifacts research/live-layout-scan-hadro-2026-11-14.json
// and research/live-layout-scan-camm-2026-11-14.json, endpoint
// solana-rpc.publicnode.com — the endpoint that ANSWERS getTransaction where
// api.mainnet-beta answered 429 to every call on 13.11.):
//   HADRo: 2000 tx / 3300 payloads / 0 missed, slots 469179697..469180764.
//     setCurve 28/28 and setRiskCurve 443/443 chain-accepted payloads carry
//     the count-from-header layout — the table's rule re-confirmed on LIVE
//     traffic, not just in the committed window. updateSpreadConfig (0e),
//     submitCurveUpdates (12), removeSpreadTriggers (1d): 0 payloads.
//   CAMM: 1000 tx / 753 payloads / 0 missed, slots 469181276..469181456.
//     Live traffic is swap_v2 + swap only; update_operation_account
//     (7f467728bce33d07): 0 payloads. Discriminators resolve at the
//     program's OWN stored length (CAMM 8-byte sighashes, HADRo 1 byte).
//
// WHY A LIMIT, NOT A NEGATIVE: these are admin instructions; a window with
// zero of them is a window, not an absence. The tool records the exact
// window (slots, signatures, fetched/missed transactions) so the claim
// never outruns the evidence.
//
// Reproducibility: the artifact pins the scanned signature list AND a sample
// of the payload bytes, so `--from-signatures` re-fetches exactly those
// transactions, `--verify` refuses a partial re-derivation (a run that
// fetched 12 of 40 signatures must not look like a reproduction), and the
// pin can re-run the analyzer over the committed bytes. The analyzer itself
// lives in tools/lib/live-layout.mjs, so the pin imports the SAME code the
// CLI runs. Measured 2026-11-14: re-deriving the HADRo artifact from its
// 2000 pinned signatures reproduced the exact per-discriminator counts
// (VERIFY OK). See tools/harvest.mjs.
//
// Usage:
//   node tools/measure-live-layout-scan.mjs --program <id> --count 2000 \
//     --out research/<name>-<date>.json
//   node tools/measure-live-layout-scan.mjs --from-signatures <artifact> \
//     --out <rederived.json> --verify <artifact>
//
// Exit codes: 0 measured; 2 usage/IO; 3 NO VERDICT (scan could not answer).

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase58 } from '../src/base58.mjs';
import { analyze, buildDiscriminatorMap, loadTypes, resolveInstruction } from './lib/live-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};

const program = option('--program', 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8');
const rpcUrl = option('--rpc', process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com');
const count = Number(option('--count', '2000'));
const outPath = option('--out', null);
const fromSignatures = option('--from-signatures', null);
const verifyPath = option('--verify', null);
// How many payload bytes are committed next to the artifact. The pin
// re-runs the analyzer over these bytes, so the measurement's central claim
// ("the wire carries the count in the header") is re-checkable from the
// repository alone, without an RPC.
const sampleSize = Number(option('--sample', '400'));

if (!outPath) {
  console.error('usage: node tools/measure-live-layout-scan.mjs --program <id> --out <file> [--count N] | --from-signatures <file>');
  process.exit(2);
}
if (!/^https:\/\//.test(rpcUrl)) throw Error('HTTPS RPC URL required');

// The committed IDL for this program, from the committed store. The store is
// the measurement's own evidence — an IDL fetched live during the scan would
// make the artifact un-reproducible offline.
function loadCommittedIdl(address) {
  const store = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');
  const receipts = path.join(store, 'receipts');
  if (!existsSync(receipts)) throw Error(`store missing: ${receipts}`);
  for (const name of readdirSync(receipts)) {
    if (!name.startsWith(`${address}-`)) continue;
    const receipt = JSON.parse(readFileSync(path.join(receipts, name), 'utf8'));
    const objectPath = path.join(store, 'objects', `${receipt.fingerprint.replace('sha256:', '')}.json`);
    if (!existsSync(objectPath)) continue;
    const idl = JSON.parse(readFileSync(objectPath, 'utf8'));
    if (idl.address === address) return idl;
  }
  throw Error(`committed IDL not found for ${address}`);
}

const IDL = loadCommittedIdl(program);
const TYPES = loadTypes(IDL);
const DISCRIMINATOR_MAP = buildDiscriminatorMap(IDL);

// --- RPC -------------------------------------------------------------------

let rpcId = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      throw Error(`${method}: transport failure after retries: ${error.message}`);
    }
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (json && json.error) {
      // Rate limits and block-not-yet-available are retried; everything else
      // is a refusal the caller must see.
      const code = json.error.code;
      if ((code === 429 || code === -32005 || code === -32004) && attempt < 7) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw Error(`${method}: ${JSON.stringify(json.error).slice(0, 200)}`);
    }
    if (json && 'result' in json) return json.result;
    if (attempt < 7) { await sleep(500 * (attempt + 1)); continue; }
    throw Error(`${method}: no result after retries`);
  }
  throw Error(`${method}: retries exhausted`);
}

function payloadRecords(transaction, target) {
  const records = [];
  const message = transaction?.transaction?.message;
  const meta = transaction?.meta ?? {};
  const staticKeys = (message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const accounts = [
    ...staticKeys,
    ...(Array.isArray(meta.loadedAddresses?.writable) ? meta.loadedAddresses.writable : []),
    ...(Array.isArray(meta.loadedAddresses?.readonly) ? meta.loadedAddresses.readonly : []),
  ];
  const resolve = (ix) => {
    if (typeof ix.programId === 'string') return ix.programId;
    const index = ix.programIdIndex;
    return Number.isSafeInteger(index) && index >= 0 && index < accounts.length ? accounts[index] : null;
  };
  for (const ix of message?.instructions ?? []) {
    if (resolve(ix) !== target) continue;
    records.push({ depth: 0, dataHex: Buffer.from(decodeBase58(ix.data ?? '')).toString('hex') });
  }
  for (const group of meta.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) {
      if (resolve(ix) !== target) continue;
      records.push({ depth: group.depth ?? 1, dataHex: Buffer.from(decodeBase58(ix.data ?? '')).toString('hex') });
    }
  }
  return records;
}

async function scanLive() {
  const signatures = [];
  let before = null;
  let fetched = 0;
  let missed = 0;
  const payloads = [];
  let pages = 0;
  while (fetched < count) {
    const params = [program, { limit: 1000 }];
    if (before) params[1].before = before;
    const page = await rpc('getSignaturesForAddress', params);
    if (!page || !page.length) break;
    pages += 1;
    for (const s of page) {
      signatures.push(s.signature);
      before = s.signature;
    }
    const limit = Math.min(100, page.length);
    for (let start = 0; start < page.length; start += limit) {
      const batch = page.slice(start, start + limit);
      const txs = await Promise.all(batch.map((s) => rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])));
      for (const [i, tx] of txs.entries()) {
        fetched += 1;
        if (!tx) { missed += 1; continue; }
        for (const record of payloadRecords(tx, program)) {
          payloads.push({
            ...record,
            signature: batch[i].signature,
            slot: batch[i].slot,
            err: batch[i].err ?? null,
            txErr: tx.meta?.err ? JSON.stringify(tx.meta.err) : null,
          });
        }
      }
    }
  }
  return { signatures, fetched, missed, payloads, pages };
}

async function scanFromSignatures(artifactPath) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const payloads = [];
  let fetched = 0;
  let missed = 0;
  const batch = artifact.pinnedSignatures ?? artifact.signatures;
  if (!Array.isArray(batch) || !batch.length) throw Error('artifact carries no pinned signature list');
  for (let start = 0; start < batch.length; start += 100) {
    const chunk = batch.slice(start, start + 100);
    const txs = await Promise.all(chunk.map((s) => rpc('getTransaction', [s, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])));
    for (const [i, tx] of txs.entries()) {
      fetched += 1;
      if (!tx) { missed += 1; continue; }
      for (const record of payloadRecords(tx, program)) {
        payloads.push({
          ...record,
          signature: chunk[i],
          slot: null,
          err: null,
          txErr: tx.meta?.err ? JSON.stringify(tx.meta.err) : null,
        });
      }
    }
  }
  return { signatures: batch, fetched, missed, payloads, pages: null };
}

const TARGETS = {
  '0e': 'updateSpreadConfig',
  '12': 'submitCurveUpdates',
  '1d': 'removeSpreadTriggers',
  '7f467728bce33d07': 'update_operation_account',
};

const { signatures, fetched, missed, payloads, pages } = fromSignatures
  ? await scanFromSignatures(fromSignatures)
  : await scanLive();

const { byDiscriminator, perInstruction } = analyze(payloads, IDL, TYPES);

const discriminatorList = [...byDiscriminator.values()]
  .map((e) => ({ ...e, byteLengths: [...e.byteLengths].sort((a, b) => a - b) }))
  .sort((a, b) => b.count - a.count);

const slots = payloads.map((p) => p.slot).filter((s) => Number.isSafeInteger(s));
const window = slots.length
  ? { fromSlot: Math.min(...slots), toSlot: Math.max(...slots) }
  : { fromSlot: null, toSlot: null };

const targetStatus = Object.entries(TARGETS).map(([disc, name]) => ({
  discriminator: disc,
  instruction: name,
  witnessed: byDiscriminator.has(disc),
  payloads: byDiscriminator.get(disc)?.count ?? 0,
}));

const witnessedTargets = targetStatus.filter((t) => t.witnessed).length;
const verdict = witnessedTargets > 0
  ? 'live-witness-found'
  : 'no-live-witness-in-window';

// The committed payload sample. A plain stride over the payload list misses
// rare discriminators (one occurrence every N payloads falls out of a 400-
// item stride), so the sample is STRATIFIED: every payload the scan saw for
// each discriminator is capped to a per-discriminator budget, then a stride
// fills the remainder. The invariant the pin re-checks is "the sample covers
// EVERY discriminator the full scan found", which a stride cannot guarantee.
const toSample = (record) => ({
  signature: record.signature,
  slot: record.slot ?? null,
  err: record.err ?? null,
  txErr: record.txErr ?? null,
  dataHex: record.dataHex,
});
const payloadSample = [];
if (payloads.length) {
  const byDisc = new Map();
  const order = [];
  for (const record of payloads) {
    const { discriminator: disc } = resolveInstruction(record.dataHex, DISCRIMINATOR_MAP);
    if (!byDisc.has(disc)) order.push(disc);
    const list = byDisc.get(disc) ?? [];
    list.push(record);
    byDisc.set(disc, list);
  }
  // PASS 1: every discriminator contributes its first payload — coverage of
  // the full-scan discriminator set is guaranteed, not probable.
  for (const disc of order) {
    if (payloadSample.length >= sampleSize) break;
    payloadSample.push(toSample(byDisc.get(disc)[0]));
  }
  // PASS 2: a stride over each list fills the remaining budget.
  const budget = Math.max(1, Math.floor(sampleSize / order.length));
  for (const disc of order) {
    const list = byDisc.get(disc);
    const stride = Math.max(1, Math.floor(list.length / budget));
    for (let i = 0; i < list.length && payloadSample.length < sampleSize; i += stride) {
      payloadSample.push(toSample(list[i]));
    }
  }
}

const artifact = {
  tool: 'tools/measure-live-layout-scan.mjs',
  analyzer: 'tools/lib/live-layout.mjs',
  measuredAt: new Date().toISOString(),
  program,
  rpc: rpcUrl.replace(/\/$/, ''),
  idlFingerprint: IDL.fingerprint ?? null,
  window,
  scanned: { signatures: signatures.length, pages, fetched, missed, payloads: payloads.length },
  // The pinned signature list, so anyone can re-fetch exactly these
  // transactions and re-derive the payload bytes (--from-signatures).
  pinnedSignatures: signatures,
  // The committed payload bytes, so the analysis is re-checkable from the
  // repository alone.
  payloadSample,
  discriminatorList,
  perInstruction: [...perInstruction.values()].sort((a, b) => a.instruction.localeCompare(b.instruction)),
  targets: {
    expected: Object.entries(TARGETS).map(([discriminator, instruction]) => ({ discriminator, instruction })),
    witnessed: targetStatus,
  },
  verdict,
  limits: [
    'A zero-payload window is a window, not an absence on chain: these are admin instructions and may simply not have been called in the scanned range.',
    'The scan reads recent finalized transactions only; older history is not covered.',
    'The committed IDL (store 2026-11-11) names the instructions; an instruction the IDL does not name is reported only by discriminator.',
    'The payload sample is a deterministic stride over the scan, not every payload: the per-discriminator COUNTS come from the full scan, the sample carries the bytes.',
  ],
};

writeFileSync(outPath, JSON.stringify(artifact, null, 1) + '\n');

console.log(JSON.stringify({
  program,
  scanned: artifact.scanned,
  window,
  payloadSample: payloadSample.length,
  discriminators: discriminatorList.map((d) => `${d.discriminator}=${d.count}`),
  perInstruction: artifact.perInstruction.map((p) => `${p.instruction}=${p.payloads} (${Object.entries(p.hypotheses).map(([k, v]) => `${k}:${v}`).join(',')})`),
  targetsWitnessed: witnessedTargets,
  verdict,
}, null, 1));

if (verifyPath) {
  const expected = JSON.parse(readFileSync(verifyPath, 'utf8'));
  const complete = artifact.scanned.signatures === expected.scanned.signatures
    && artifact.scanned.missed === expected.scanned.missed
    && artifact.scanned.payloads === expected.scanned.payloads;
  const sameDiscriminators = JSON.stringify(artifact.discriminatorList.map((d) => [d.discriminator, d.count]))
    === JSON.stringify(expected.discriminatorList.map((d) => [d.discriminator, d.count]));
  if (!complete || !sameDiscriminators) {
    console.error(`VERIFY FAILED: re-derivation ${complete ? 'counts match but discriminators differ' : 'incomplete'} (fetched ${artifact.scanned.fetched}/${expected.scanned.fetched}, missed ${artifact.scanned.missed}/${expected.scanned.missed}, payloads ${artifact.scanned.payloads}/${expected.scanned.payloads})`);
    process.exit(3);
  }
  console.log('VERIFY OK: re-derivation matches the committed artifact');
}
