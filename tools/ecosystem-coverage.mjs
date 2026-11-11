#!/usr/bin/env node
// Ecosystem-wide coverage measurement for sememe — the denominator the
// curated watchlist cannot give.
//
//   node tools/ecosystem-coverage.mjs capture --blocks 8 \
//        --out test/fixtures/ecosystem-sample-2026-11-11.json \
//        --store test/fixtures/ecosystem-store-2026-11-11
//   node tools/ecosystem-coverage.mjs report \
//        --sample test/fixtures/ecosystem-sample-2026-11-11.json \
//        --store test/fixtures/ecosystem-store-2026-11-11 \
//        --out research/ecosystem-coverage-2026-11-11.json
//
// Why this file exists
//
// The committed coverage claim (research/traffic-coverage-2026-11-04.json)
// reads "coveredPct: 100" over 89,546 watched payloads. That number is real
// for its window, but its DENOMINATOR is the curated 22-program watchlist.
// The same artifact reports, separately and honestly:
//
//   trafficOutsideTheWatchedList: 320 distinct programs,
//                                 36,027 instructions, 22,622 transactions
//
// counted, bytes NOT stored, explicitly "NOT in the coverage denominator".
//
// So the published coverage number says nothing about the traffic a consumer
// actually meets: one program (SPL Associated Token Account) carried 6,337
// instructions in that window alone, and no measurement exists for it.
//
// This tool closes that gap with ONE question asked over ALL traffic:
//
//   for the instructions a consumer meets, could sememe have NAMED them?
//
// and it keeps the three outcomes apart, because they have different fixes:
//   decoded       an interface was acquirable AND the bytes decoded
//   refused       an interface was acquirable AND the bytes were refused
//                 (source lag — the interface describes another wire form)
//   no-interface  NO interface is acquirable at either address sememe can
//                 pull from (an ACQUISITION gap, not a decoder gap)
//
// Method
//
//   capture  takes contiguous newest finalized blocks, inventories EVERY
//            instruction (top-level AND CPI) against the FULL account list
//            (static keys + lookup tables), stores the payload bytes of the
//            measured programs, and runs the acquisition check for them:
//            derive the two addresses an IDL can live at, fetch them, decode
//            with the product's own decoder, and install what verifies via
//            the product's own write path (installIdl). The measured set is
//            the curated watchlist PLUS the highest-volume programs outside
//            it, bounded by count and a byte budget. The store is never
//            consulted during selection.
//
//   report   measures the captured bytes through the product's own entry
//            points (decodeUnionPayload / native / token / raydium) against
//            the captured store. It never touches the network, so the number
//            is reproducible offline and a change in it means the CODE or the
//            FIXTURE changed, not the chain. The report splits the headline
//            into watchlist vs. outside-watchlist views, because the
//            committed 100% claim was made on the first and never on the
//            second.
//
// Two properties this tool refuses to give up:
//
//   (1) No store-selection bias: blocks are taken WITHOUT asking the store
//       anything, and the extra programs are ranked by traffic volume.
//   (2) Programs whose bytes were not stored stay in the report as COUNTS
//       ("not-measured"), never silently dropped.
//
// The tool exits non-zero (exit 3, NO VERDICT) when it cannot produce a
// verdict at all, so a broken measurement can never look like a good one.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKeyList, programIdOf, toHex } from './lib/payloads.mjs';
import { addresses, decodeAccount } from '../src/acquire.mjs';
import { installIdl } from '../src/pull.mjs';
import { decodeUnionPayload } from '../src/decode.mjs';
import { decodeNativeInstruction, isNativeProgram } from '../src/native.mjs';
import { decodeTokenInstruction, isTokenProgram } from '../src/token.mjs';
import { decodeRaydiumInstruction, isRaydiumProgram } from '../src/raydium.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args[0];

const opt = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let rpcId = 0;

async function rpc(method, params, url) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
    } catch (error) {
      if (attempt < 7) { await sleep(500 * (attempt + 1)); continue; }
      throw Error(`${method}: network error: ${String(error.message).slice(0, 120)}`);
    }
    if (response.status === 429 || response.status >= 500) {
      const retry = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 10000) : 1500 * (attempt + 1));
      continue;
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      if (attempt < 7) { await sleep(400 * (attempt + 1)); continue; }
      throw Error(`${method}: unreadable body`);
    }
    if (body.error) throw Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  throw Error(`${method}: RPC kept rate-limiting`);
}

// The curated watchlist: the repo's own 22-program catalog. A comparison
// group, NOT the denominator.
const CATALOG = [
  ['Whirlpool', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'],
  ['Kamino Lend', 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'],
  ['OpenBook v2', 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb'],
  ['Marinade liquid staking', 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD'],
  ['Raydium AMM v4', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
  ['Raydium CLMM', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'],
  ['Raydium CPMM', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'],
  ['Pump.fun bonding curve', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
  ['PumpSwap', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'],
  ['Jupiter v6', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
  ['Jupiter Lend', 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9'],
  ['Jupiter Liquidity', 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC'],
  ['Meteora DLMM', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'],
  ['Meteora DAMM v1', 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB'],
  ['Meteora DAMM v2', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'],
  ['Meteora DBC', 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'],
  ['Meteora Vault', '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi'],
  ['Drift v2', 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH'],
  ['SPL Token', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
  ['Token-2022', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'],
];
const NATIVE = [
  ['System', '11111111111111111111111111111111'],
  ['ComputeBudget', 'ComputeBudget111111111111111111111111111111'],
];
const WATCHED = new Map([...CATALOG, ...NATIVE].map(([name, id]) => [id, name]));

async function capture() {
  const blocksWanted = Number(opt('--blocks', '8'));
  const rpcUrl = opt('--rpc', 'https://api.mainnet-beta.solana.com');
  const outPath = opt('--out', null);
  const storeDir = opt('--store', null);
  const maxExtraPrograms = Number(opt('--max-extra-programs', '24'));
  const byteBudget = Number(opt('--byte-budget', String(48 * 1024 * 1024)));
  if (!outPath || !storeDir) {
    throw Error('capture needs --out <sample.json> and --store <store-dir>');
  }
  if (!/^https:\/\//.test(rpcUrl)) throw Error('HTTPS RPC URL required');

  const currentSlot = await rpc('getSlot', [{ commitment: 'finalized' }], rpcUrl);
  const slots = [];
  for (let i = 0; i < blocksWanted; i++) slots.push(currentSlot - 2 - i);

  // Pass 1: inventory every instruction of every transaction, per program.
  const inventory = new Map(); // program -> { payloads, bytes, txs:Set }
  const rowsByTxIndex = new Map(); // txIndex -> [{ program, dataHex }]
  const txMeta = new Map(); // txIndex -> { signature, slot, failed }
  let txSeenTotal = 0;
  let blockIndex = 0;

  for (const target of slots) {
    const block = await rpc('getBlock', [target, {
      transactionDetails: 'full', encoding: 'json',
      maxSupportedTransactionVersion: 1, rewards: false, commitment: 'finalized',
    }], rpcUrl);
    const txs = block?.transactions ?? null;
    if (txs === null) { blockIndex += 1; continue; }
    txSeenTotal += txs.length;
    for (const [txInBlock, tx] of txs.entries()) {
      const txIndex = blockIndex * 1_000_000 + txInBlock;
      const accounts = accountKeyList(tx);
      const message = tx?.transaction?.message;
      const meta = tx?.meta ?? {};
      const all = [
        ...(message?.instructions ?? []),
        ...((meta.innerInstructions ?? []).flatMap((group) => group?.instructions ?? [])),
      ];
      const signature = typeof tx?.transaction?.signatures?.[0] === 'string'
        ? tx.transaction.signatures[0] : null;
      const failed = tx?.meta?.err !== null && tx?.meta?.err !== undefined;
      const rows = [];
      for (const instruction of all) {
        const programId = programIdOf(instruction, accounts);
        if (!programId) continue;
        const dataHex = toHex(instruction?.data);
        let entry = inventory.get(programId);
        if (!entry) {
          entry = { payloads: 0, bytes: 0, txs: new Set() };
          inventory.set(programId, entry);
        }
        entry.payloads += 1;
        entry.bytes += dataHex.length / 2;
        if (signature) entry.txs.add(signature);
        rows.push({ program: programId, dataHex });
      }
      if (rows.length) {
        rowsByTxIndex.set(txIndex, rows);
        txMeta.set(txIndex, { signature, slot: target, failed });
      }
    }
    blockIndex += 1;
    process.stderr.write(`block ${target}: ${txs.length} txs\n`);
    await sleep(300);
  }

  // Selection: watchlist PLUS the highest-volume programs outside it, until
  // count/byte bounds are hit. Volume-ranked, NOT store-ranked.
  const outside = [...inventory.entries()]
    .filter(([id]) => !WATCHED.has(id))
    .sort((a, b) => b[1].payloads - a[1].payloads);
  const selected = new Set(WATCHED.keys());
  const selectedExtra = [];
  let bytesKept = 0;
  for (const [id, entry] of outside) {
    if (selectedExtra.length >= maxExtraPrograms) break;
    if (bytesKept + entry.bytes > byteBudget) break;
    selected.add(id);
    selectedExtra.push(id);
    bytesKept += entry.bytes;
  }

  // Acquisition check for the measured programs: the two addresses an IDL
  // can live at, fetched and decoded with the product's own decoder.
  const idlOwner = [];
  const idlKeys = [];
  for (const programId of selected) {
    const { metadata, anchor } = await addresses(programId);
    idlOwner.push({ programId, source: 'metadata', address: metadata });
    idlOwner.push({ programId, source: 'anchor', address: anchor });
    idlKeys.push(metadata, anchor);
  }
  const accountsResult = await rpc('getMultipleAccounts', [idlKeys, {
    encoding: 'base64', commitment: 'finalized',
  }], rpcUrl);
  const values = accountsResult?.value;
  if (!Array.isArray(values) || values.length !== idlKeys.length) {
    throw Error('acquisition check: malformed getMultipleAccounts response');
  }

  const acquirable = {};
  const decodedByIdl = new Map(); // program -> { idl, source, address }
  for (let index = 0; index < idlOwner.length; index++) {
    const entry = idlOwner[index];
    const record = acquirable[entry.programId] ??
      (acquirable[entry.programId] = {
        id: entry.programId,
        name: WATCHED.get(entry.programId) ?? null,
        sources: [], idl: null,
      });
    const value = values[index];
    if (value === null) { record.sources.push({ source: entry.source, state: 'absent' }); continue; }
    try {
      const idl = decodeAccount(value, entry.source, entry.programId);
      record.sources.push({
        source: entry.source, state: 'usable',
        instructions: idl.instructions.length,
        events: Array.isArray(idl.events) ? idl.events.length : 0,
      });
      if (!record.idl) {
        record.idl = { source: entry.source, instructions: idl.instructions.length };
        decodedByIdl.set(entry.programId, { idl, source: entry.source, address: entry.address });
      }
    } catch (error) {
      record.sources.push({
        source: entry.source, state: 'present-unusable',
        reason: String(error?.message ?? error).slice(0, 120),
      });
    }
  }
  for (const record of Object.values(acquirable)) record.acquirable = Boolean(record.idl);

  // Install what verifies, through the product's own write path.
  const installSlot = Number.isSafeInteger(accountsResult?.context?.slot)
    ? accountsResult.context.slot : currentSlot;
  const installed = [];
  const installErrors = [];
  for (const [programId, decoded] of decodedByIdl) {
    try {
      const receipt = await installIdl(decoded.idl, {
        program: programId, source: decoded.source,
        address: decoded.address, slot: installSlot,
      }, storeDir);
      installed.push({ program: programId, source: decoded.source, fingerprint: receipt.fingerprint });
    } catch (error) {
      installErrors.push({ program: programId, reason: String(error?.message ?? error).slice(0, 120) });
    }
  }
  if (installErrors.length) {
    throw Error(`install failed for ${installErrors.length} interface(s): `
      + JSON.stringify(installErrors.slice(0, 3)));
  }

  // Assemble the captured transactions of the MEASURED programs only.
  const captured = [];
  for (const [txIndex, rows] of rowsByTxIndex) {
    const measured = rows.filter((row) => selected.has(row.program));
    if (!measured.length) continue;
    const { signature, slot, failed } = txMeta.get(txIndex);
    captured.push({ signature, slot, failed, payloads: measured });
  }

  // Programs that were counted but NOT measured, with their counts.
  const notMeasured = [...inventory.entries()]
    .filter(([id]) => !selected.has(id))
    .map(([id, entry]) => ({ id, payloadCount: entry.payloads, txCount: entry.txs.size }))
    .sort((a, b) => b.payloadCount - a.payloadCount);

  const report = {
    meta: {
      capturedAt: new Date().toISOString(),
      rpc: rpcUrl,
      method: 'getBlock finalized full encoding:json maxSupportedTransactionVersion:1 rewards:false; contiguous newest finalized slots minus 2',
      requestedSlots: slots,
      blocksWithTraffic: blockIndex,
      transactionsInBlocks: txSeenTotal,
      transactionsWithMeasuredTraffic: captured.length,
      distinctProgramsSeen: inventory.size,
      watchedPrograms: WATCHED.size,
      measuredPrograms: selected.size,
      extraProgramsMeasured: selectedExtra.length,
      byteBudget,
      selection: 'curated watchlist + top-volume traffic programs outside it; ranked by observed instruction count, bounded by count and byte budget; the store was never consulted during selection',
    },
    acquirable,
    installed,
    catalog: [...inventory.entries()].map(([id, entry]) => ({
      id, name: WATCHED.get(id) ?? null,
      payloadCount: entry.payloads, txCount: entry.txs.size,
      watched: WATCHED.has(id), measured: selected.has(id),
      acquirable: acquirable[id]?.acquirable ?? null,
    })).sort((a, b) => b.payloadCount - a.payloadCount),
    notMeasured,
    transactions: captured,
  };
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await writeFile(outPath, JSON.stringify(report));
  const capturedPayloads = captured.reduce((sum, tx) => sum + tx.payloads.length, 0);
  process.stderr.write(`wrote ${outPath}: ${captured.length} txs, ${capturedPayloads} measured payloads, `
    + `${selected.size}/${inventory.size} programs measured, ${installed.length} interfaces installed\n`);
}

async function classify(storeDir, program, hex, absentPolicy, dehost = (v) => v) {
  if (isNativeProgram(program)) {
    try {
      const decoded = decodeNativeInstruction(program, Buffer.from(hex, 'hex'), { trailing: 'report' });
      return { outcome: 'decoded', via: 'native-upstream', name: decoded.name,
        byteExact: decoded.roundTripByteExact === true, trailing: decoded.trailing?.count ?? 0 };
    } catch (error) {
      return { outcome: 'refused', via: 'native-upstream', reason: String(error?.message ?? error).slice(0, 110) };
    }
  }
  if (isTokenProgram(program)) {
    try {
      const decoded = decodeTokenInstruction(program, Buffer.from(hex, 'hex'), { trailing: 'report' });
      return { outcome: 'decoded', via: 'token-upstream', name: decoded.name,
        byteExact: decoded.roundTripByteExact === true, trailing: decoded.trailing?.count ?? 0 };
    } catch (error) {
      return { outcome: 'refused', via: 'token-upstream', reason: String(error?.message ?? error).slice(0, 110) };
    }
  }
  if (isRaydiumProgram(program)) {
    try {
      const decoded = decodeRaydiumInstruction(program, Buffer.from(hex, 'hex'), { trailing: 'report' });
      return { outcome: 'decoded', via: 'raydium-upstream', name: decoded.name,
        byteExact: decoded.roundTripByteExact === true, trailing: decoded.trailing?.count ?? 0 };
    } catch (error) {
      return { outcome: 'refused', via: 'raydium-upstream', reason: String(error?.message ?? error).slice(0, 110) };
    }
  }
  try {
    const result = await decodeUnionPayload(storeDir, program, hex, {
      trailing: 'report', absent: absentPolicy,
    });
    return {
      outcome: 'decoded',
      via: result.verdict?.winner ? 'union' : 'idl',
      name: result.name,
      byteExact: result.roundTripByteExact === true,
      describedExact: result.describedRoundTripByteExact === true,
      trailing: result.trailing?.count ?? 0,
      absentFields: result.absent?.length ?? 0,
      chainVerified: result.shortForm?.verified === true,
    };
  } catch (error) {
    const reason = dehost(String(error?.message ?? error)).slice(0, 110);
    if (reason.startsWith('no stored IDL for program')) {
      return { outcome: 'no-interface', via: 'none', reason };
    }
    return { outcome: 'refused', via: 'idl', reason };
  }
}

async function report() {
  const samplePath = opt('--sample', null);
  const storeDir = opt('--store', null);
  const outPath = opt('--out', null);
  const absentFlag = args.find((value) => value.startsWith('--absent='));
  const absentPolicy = absentFlag ? absentFlag.slice('--absent='.length) : 'verified';
  if (!samplePath || !storeDir) throw Error('report needs --sample <file.json> and --store <dir>');
  if (!['report', 'error', 'verified'].includes(absentPolicy)) {
    throw Error(`--absent must be report, error or verified, got ${JSON.stringify(absentPolicy)}`);
  }
  const sample = JSON.parse(await readFile(samplePath, 'utf8'));
  // Host paths must never reach the committed artifact: the store's own
  // refusal message embeds the store directory it checked. The artifact
  // carries only the repo-relative path (src/store-read.mjs is unchanged).
  const storeDirAbs = path.resolve(storeDir);
  const samplePathAbs = path.resolve(samplePath);
  const relativise = (target) => (target.startsWith(ROOT + path.sep)
    ? path.relative(ROOT, target) : target);
  // A store OUTSIDE the repo keeps a stable marker instead of a host path;
  // one inside the repo keeps its repo-relative path. Refusal messages are
  // de-hosted the same way, so neither variant can leak a machine path into
  // a committed artifact.
  const storeDirRel = storeDirAbs.startsWith(ROOT + path.sep)
    ? path.relative(ROOT, storeDirAbs) : '<store>';
  const dehost = (value) => {
    if (typeof value !== 'string') return value;
    let text = value.split(storeDirAbs).join(storeDirRel);
    if (text.includes('/home/') || text.includes('/tmp/')) {
      text = text.replace(/\/home\/[^\s"/]+\/[^\s"]*/g, '<store>').replace(/\/tmp\/[^\s"]*/g, '<store>');
    }
    return text;
  };

  const perProgram = new Map();
  const refusalReasons = new Map();
  const outcomeVsChain = {
    decoded_txSuccess: 0, decoded_txFailed: 0,
    refused_txSuccess: 0, refused_txFailed: 0,
    noInterface_txSuccess: 0, noInterface_txFailed: 0,
  };
  let total = 0;
  for (const tx of sample.transactions) {
    for (const row of tx.payloads) {
      const verdict = await classify(storeDirAbs, row.program, row.dataHex, absentPolicy, dehost);
      total += 1;
      let entry = perProgram.get(row.program);
      if (!entry) {
        const catalogEntry = sample.catalog.find((c) => c.id === row.program);
        entry = {
          program: row.program,
          name: catalogEntry?.name ?? null,
          watched: WATCHED.has(row.program),
          acquirable: sample.acquirable?.[row.program]?.acquirable ?? null,
          decoded: 0, refused: 0, noInterface: 0, byteExact: 0, describedExact: 0,
          trailing: 0, shortForm: 0, chainVerified: 0,
        };
        perProgram.set(row.program, entry);
      }
      if (verdict.outcome === 'decoded') {
        entry.decoded += 1;
        if (verdict.byteExact === true) entry.byteExact += 1;
        if (verdict.describedExact === true) entry.describedExact += 1;
        if (verdict.trailing > 0) entry.trailing += 1;
        if ((verdict.absentFields ?? 0) > 0) entry.shortForm += 1;
        if (verdict.chainVerified === true) entry.chainVerified += 1;
        outcomeVsChain[tx.failed ? 'decoded_txFailed' : 'decoded_txSuccess'] += 1;
      } else if (verdict.outcome === 'refused') {
        entry.refused += 1;
        const key = dehost(`${verdict.via}: ${verdict.reason}`);
        refusalReasons.set(key, (refusalReasons.get(key) ?? 0) + 1);
        outcomeVsChain[tx.failed ? 'refused_txFailed' : 'refused_txSuccess'] += 1;
      } else {
        entry.noInterface += 1;
        outcomeVsChain[tx.failed ? 'noInterface_txFailed' : 'noInterface_txSuccess'] += 1;
        const key = dehost(`no-interface: ${verdict.reason}`);
        refusalReasons.set(key, (refusalReasons.get(key) ?? 0) + 1);
      }
    }
  }

  const rows = [...perProgram.values()].map((entry) => ({
    ...entry,
    payloads: entry.decoded + entry.refused + entry.noInterface,
    coveredPct: Number((100 * entry.decoded / (entry.decoded + entry.refused + entry.noInterface)).toFixed(1)),
  })).sort((a, b) => b.payloads - a.payloads);

  const sum = (key) => rows.reduce((acc, row) => acc + row[key], 0);
  const count = (predicate) => rows.filter(predicate)
    .reduce((acc, row) => acc + row.payloads, 0);
  const decoded = sum('decoded');
  const refused = sum('refused');
  const noInterface = sum('noInterface');
  const byteExact = sum('byteExact');

  // The falsification views: the committed claim lives on the watchlist
  // denominator; the ecosystem claim must live on the outside-watchlist one.
  const view = (predicate) => {
    const payloads = count(predicate);
    const viewDecoded = rows.filter(predicate).reduce((acc, row) => acc + row.decoded, 0);
    const viewRefused = rows.filter(predicate).reduce((acc, row) => acc + row.refused, 0);
    const viewNoInterface = rows.filter(predicate).reduce((acc, row) => acc + row.noInterface, 0);
    return {
      payloads, decoded: viewDecoded, refused: viewRefused, noInterface: viewNoInterface,
      coveredPct: payloads ? Number((100 * viewDecoded / payloads).toFixed(1)) : null,
    };
  };
  const watchedView = view((row) => row.watched === true);
  const outsideView = view((row) => row.watched !== true);

  // Traffic that was counted but NOT measured (bytes not stored). Reported
  // separately so the denominator can never quietly shrink.
  const notMeasuredPayloads = (sample.notMeasured ?? []).reduce((acc, row) => acc + row.payloadCount, 0);
  const notMeasuredTx = (sample.notMeasured ?? []).reduce((acc, row) => acc + row.txCount, 0);
  const seenTotal = total + notMeasuredPayloads;

  const result = {
    generatedAt: new Date().toISOString(),
    sample: {
      file: relativise(samplePathAbs),
      store: storeDirRel,
      samplePathNote: 'paths are recorded relative to the repo when they live inside it, so the artifact is the same from any checkout location',
      capturedAt: sample.meta.capturedAt,
      slots: sample.meta.requestedSlots,
      blocksWithTraffic: sample.meta.blocksWithTraffic,
      transactionsInBlocks: sample.meta.transactionsInBlocks,
      distinctProgramsSeen: sample.meta.distinctProgramsSeen,
      measuredPrograms: sample.meta.measuredPrograms,
      method: sample.meta.method,
      selection: sample.meta.selection,
      measurementPath: 'the product entry points (decodeUnionPayload / native decoder / token decoder / raydium decoder) against the captured store; interfaces installed through the product write path (installIdl)',
    },
    headline: {
      allPayloadsSeen: seenTotal,
      measuredPayloads: total,
      notMeasuredPayloads,
      decoded, refused, noInterface,
      coveredPctOfMeasured: Number((100 * decoded / total).toFixed(1)),
      coveredPctOfAllSeen: Number((100 * decoded / seenTotal).toFixed(1)),
      byteExact,
      byteExactPctOfDecoded: Number((100 * byteExact / decoded).toFixed(1)),
      shortForm: sum('shortForm'),
      chainVerified: sum('chainVerified'),
      absentPolicy,
      watchlist: watchedView,
      outsideWatchlist: outsideView,
      note: 'coverage = payloads an available interface could NAME. "refused" (interface present, bytes refused) and "no-interface" (no interface acquirable at all) are counted separately because they need different fixes. watchlist vs outsideWatchlist split exists because the committed 100% claim was measured on the first and never on the second.',
    },
    trafficNotMeasured: {
      distinctPrograms: (sample.notMeasured ?? []).length,
      instructions: notMeasuredPayloads,
      transactions: notMeasuredTx,
      note: 'counted in the traffic inventory, bytes NOT stored (count/byte bounds). NOT in the measured denominator — reported separately so the denominator stays honest.',
    },
    // The un-measured tail, named: a count is honest only when the reader can
    // see WHICH programs it is made of.
    notMeasured: sample.notMeasured ?? [],
    captureMeta: sample.meta ?? null,
    refusalReasons: [...refusalReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    outcomeVsChain,
    programs: rows,
    acquisitionQueue: rows
      .filter((row) => row.noInterface > 0)
      .map((row) => ({
        program: row.program,
        name: row.name,
        payloads: row.noInterface,
        acquirable: row.acquirable,
        reason: row.acquirable === false
          ? 'no on-chain IDL at either address; needs a first-party published copy or a vendored upstream source'
          : 'interface acquirable but not installed in this store',
      }))
      .sort((a, b) => b.payloads - a.payloads),
  };

  const json = `${JSON.stringify(result, null, 1)}\n`;
  if (outPath) {
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await writeFile(outPath, json);
  } else {
    process.stdout.write(json);
  }
  process.stderr.write(`coverage of MEASURED traffic: ${decoded}/${total} decoded `
    + `(${result.headline.coveredPctOfMeasured}%); watchlist ${watchedView.coveredPct}%, `
    + `outside ${outsideView.coveredPct}%; of ALL seen: ${result.headline.coveredPctOfAllSeen}%\n`);
}

try {
  if (command === 'capture') await capture();
  else if (command === 'report') await report();
  else {
    process.stderr.write('usage: node tools/ecosystem-coverage.mjs capture|report ...\n');
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`NO VERDICT: ${String(error?.message ?? error)}\n`);
  process.exit(3);
}
