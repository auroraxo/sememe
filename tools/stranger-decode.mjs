#!/usr/bin/env node
// stranger-decode.mjs — the copy-paste 1,000-transaction decode a stranger can run.
//
//   node tools/stranger-decode.mjs --store /tmp/sememe-store \
//     --harvest test/fixtures/harvest-whirlpool-2026-10-28.json --limit 1000
//
// The card's user-zero threshold is "a foreign repository decodes 1,000
// transactions through sememe without disagreement". Until a third party
// actually runs that, the integration must at least be ONE COMMAND a stranger
// can copy, paste and run: this tool is that command. It feeds every payload
// of the given transactions through the PRODUCT's own entry points — the same
// decodePayload/decodeUnionPayload/native/token/raydium surfaces a consumer
// imports — and checks, per payload:
//
//   1. the product names the instruction (or refuses, with a named reason),
//   2. re-encoding the decoded value reproduces the bytes — the WHOLE payload
//      (round-trip byte-exact) or at least the described prefix when the wire
//      carries trailing bytes the interface does not describe,
//   3. a decode that can neither reproduce the whole payload nor its described
//      prefix is a DISAGREEMENT: sememe named bytes it cannot reproduce.
//
// "Diff-free" is therefore not an adjective here: it is the exit code. Any
// decode error or disagreement fails the run (exit 1) with named examples.
//
// Inputs (exactly one):
//   --harvest <file>  a tools/harvest.mjs document (single program, payloads
//                     carry the document's program id).
//   --sample <file>   a tools/traffic-sample.mjs document (multi-program,
//                     each payload row carries its own program).
//   --rpc-response <file> a raw RPC response: getBlock/getTransaction in
//                     the default `encoding:"base64"` shape (wire bytes,
//                     signature-verified before decoding) or the
//                     `encoding:"json"` shape foreign repos' own test
//                     fixtures hold (chain-parsed instructions carry no
//                     bytes there; they are counted, not decoded)
// Both are read offline; the run performs ZERO network calls and that is
// enforced: this file installs the zero-RPC guard before anything else is
// imported, so a decode path that reached for the network would fail loudly
// instead of silently "succeeding".
//
// The store is the one `sememe pull` (and `sememe adopt`) writes. For
// programs with no IDL account (native, token, Raydium AMM v4) the pinned
// upstream tables answer — the same way they answer inside the package.
//
// --absent controls short-form payloads (a wire shorter than the interface
// declares) exactly as the product does:
//   error    (default) refuse them — the strict product;
//   verified decode them ONLY where a chain witness covers the exact form;
//   report   decode and name the absent fields without evidence.
// A run on pump.fun/PumpSwap traffic with the default will refuse the
// witnessed short forms — that is the product being strict, not a defect;
// pass --absent verified to apply the evidence-gated form.
//
// Exit codes: 0 pass (zero decode errors, zero disagreements); 1 fail;
// 2 usage/IO errors (bad arguments, unreadable file, missing store).

import './lib/network-guard.mjs';
import { readFile } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import path from 'node:path';
import { decodePayload, decodeUnionPayload } from '../src/decode.mjs';
import { decodeNativeInstruction, isNativeProgram } from '../src/native.mjs';
import { decodeTokenInstruction, isTokenProgram, encodeTokenInstruction } from '../src/token.mjs';
import { decodeRaydiumInstruction, isRaydiumProgram, encodeRaydiumInstruction } from '../src/raydium.mjs';
import { encodeNativeInstruction } from '../src/native.mjs';
import { extractPayloads, accountKeyList } from './lib/payloads.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const store = option('--store', null);
const harvestPath = option('--harvest', null);
const samplePath = option('--sample', null);
const rpcResponsePath = option('--rpc-response', null);
const outPath = option('--out', null);
const limit = Number(option('--limit', '1000'));
const absentPolicy = option('--absent', 'error');

const usageExit = (message) => {
  console.error(`stranger-decode: ${message}`);
  console.error('usage: node tools/stranger-decode.mjs --store <dir> (--harvest <file> | --sample <file>) [--limit N] [--absent error|verified|report] [--out report.json]');
  process.exit(2);
};

if (!store) usageExit('--store is required (the store `sememe pull` writes)');
const chosenSources = [harvestPath, samplePath, rpcResponsePath].filter(Boolean);
if (chosenSources.length !== 1) usageExit('give exactly one of --harvest, --sample or --rpc-response');
if (!Number.isFinite(limit) || limit < 0) usageExit('--limit must be a number >= 0 (0 = no limit)');
if (!['error', 'report', 'verified'].includes(absentPolicy)) usageExit(`--absent must be error, verified or report, got ${JSON.stringify(absentPolicy)}`);
try {
  accessSync(path.join(store, 'receipts'));
} catch {
  usageExit(`no sememe store at ${store}: run "sememe pull <program-id> --store ${store}" first`);
}

const kind = rpcResponsePath ? 'rpc-response' : harvestPath ? 'harvest' : 'sample';
let inputFile;
let document;
let wireMeta = { entriesTotal: 0, unreadable: 0, reasons: {}, encoding: null, chainParsed: 0 };
if (kind === 'rpc-response') {
  // A foreign repo's raw RPC document: getBlock / getTransaction responses in
  // their DEFAULT `encoding: "base64"` shape (the transaction as wire bytes)
  // — and in the `encoding: "json"` shape the chain's own parser produced,
  // which is what foreign repositories' OWN test fixtures hold (measured on
  // step-finance-oss/step-ingestooor and CryptGodSon/Solana-Explorer,
  // 2026-11-04). This is the shape archives, indexers and dashboards hold;
  // requiring the repo to re-harvest into sememe's own shapes was the
  // integration gap.
  inputFile = rpcResponsePath;
  try {
    document = JSON.parse(await readFile(inputFile, 'utf8'));
  } catch (error) {
    usageExit(`cannot read ${inputFile}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  const { transactionsFromRpcDocument, normalizeRpcWireTransaction, normalizeRpcJsonTransaction } = await import('./lib/wire-tx.mjs');
  let entries;
  try {
    ({ transactions: entries } = transactionsFromRpcDocument(document));
  } catch (error) {
    usageExit(`${inputFile}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  // The encoding is decided by the DOCUMENT, not by a flag: a transaction
  // whose bytes are a base64 string is a wire entry; a transaction whose
  // instructions are objects is the chain's json encoding. Guessing wrong
  // here would decode a payload from the wrong field, so the decision is
  // made per entry and a mixed document is refused rather than half-read.
  const isWireEntry = (entry) => Array.isArray(entry?.transaction) && typeof entry.transaction[0] === 'string';
  const isJsonEntry = (entry) => Array.isArray(entry?.transaction?.message?.instructions);
  wireMeta.entriesTotal = entries.length;
  const readable = [];
  const entryEncodings = [];
  for (const [index, entry] of entries.entries()) {
    const wire = isWireEntry(entry);
    const json = isJsonEntry(entry);
    if (!wire && !json) {
      wireMeta.unreadable += 1;
      wireMeta.reasons['rpc-encoding-unknown'] = (wireMeta.reasons['rpc-encoding-unknown'] ?? 0) + 1;
      continue;
    }
    if (wire && json) {
      wireMeta.unreadable += 1;
      wireMeta.reasons['rpc-encoding-ambiguous'] = (wireMeta.reasons['rpc-encoding-ambiguous'] ?? 0) + 1;
      continue;
    }
    try {
      const normalized = wire ? normalizeRpcWireTransaction(entry) : normalizeRpcJsonTransaction(entry);
      entryEncodings.push(wire ? 'base64' : 'json');
      if (!wire) {
        // Instructions the chain already parsed carry NO bytes in the
        // document. They are counted by name, never decoded: an empty
        // payload is a missing field, not a transfer of nothing.
        wireMeta.chainParsed += normalized.chainParsed ?? 0;
      }
      readable.push(normalized);
    } catch (error) {
      // Named and counted, never silently dropped: a transaction whose wire
      // bytes cannot be parsed is counted as UNREADABLE (it fails the run)
      // and names WHY.
      const reason = error?.reason ?? 'wire-unknown';
      wireMeta.reasons[reason] = (wireMeta.reasons[reason] ?? 0) + 1;
    }
  }
  wireMeta.unreadable = entries.length - readable.length;
  wireMeta.encoding = readable.some((entry) => entry?.transaction?.message?.instructions?.length
    && entry.transaction.message.instructions[0]?.programId !== undefined) ? 'json' : 'base64';
  // The per-transaction payload rows, extracted by the SAME extractor the
  // harvest/sample documents were built with — the wire parser only replaces
  // the chain's pre-parsing, not the decode contract.
  const rowsOf = (normalized) => {
    const doc = { transaction: normalized.transaction, meta: normalized.meta };
    const keys = accountKeyList(doc);
    const programs = new Set();
    for (const ix of normalized.transaction.message.instructions) {
      const program = ix.programId ?? keys[ix.programIdIndex];
      if (program) programs.add(program);
    }
    for (const group of normalized.meta.innerInstructions ?? []) {
      for (const ix of group?.instructions ?? []) {
        const program = ix.programId ?? keys[ix.programIdIndex];
        if (program) programs.add(program);
      }
    }
    const rows = [];
    for (const program of programs) {
      for (const extracted of extractPayloads(doc, program)) {
        rows.push({
          program,
          ix: extracted.ix,
          depth: extracted.depth,
          innerIndex: extracted.innerIndex,
          dataBase58: extracted.dataBase58,
          dataHex: extracted.dataHex,
        });
      }
    }
    return rows;
  };
  document = {
    transactions: readable.map((normalized, position) => ({
      signature: normalized.signature,
      txErr: normalized.meta?.err ?? null,
      encoding: entryEncodings[position],
      payloads: rowsOf(normalized),
    })),
  };
} else {
  inputFile = harvestPath ?? samplePath;
  try {
    document = JSON.parse(await readFile(inputFile, 'utf8'));
  } catch (error) {
    usageExit(`cannot read ${inputFile}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
}
if (!Array.isArray(document.transactions)
    || (!document.transactions.length && kind !== 'rpc-response')) {
  usageExit(`${inputFile} carries no readable transactions`);
}

// Payload rows, normalized across the two document shapes:
//   harvest: transactions[].payloads[] + document.program
//   sample:  transactions[].payloads[] with per-row .program
const documentProgram = kind === 'harvest' ? document.program : null;
if (kind === 'harvest' && typeof documentProgram !== 'string') {
  usageExit(`${inputFile} is a harvest without a program field`);
}

const summary = {
  transactionsChecked: 0,
  transactionsWithPayloads: 0,
  transactionsWithoutPayloads: 0,
  transactionsUnreadable: 0,
  unreadableReasons: {},
  payloadsChecked: 0,
  decoded: 0,
  decodeErrors: 0,
  noInterface: 0,
  disagreements: 0,
  byteExactFull: 0,
  byteExactDescribed: 0,
  trailingPayloads: 0,
  shortFormReported: 0,
  missingBytes: 0,
  failedOnChain: 0,
  byteExactRate: null,
  refusalReasons: {},
  byProgram: {},
  decodeErrorExamples: [],
  disagreementExamples: [],
  noInterfacePrograms: {},
};

const bumpProgram = (program) => {
  const key = program ?? '(none)';
  summary.byProgram[key] ??= { payloads: 0, decoded: 0, decodeErrors: 0, disagreements: 0, noInterface: 0 };
  return summary.byProgram[key];
};

// Wire-ingest provenance, recorded on the report (only for --rpc-response):
// how many transactions the RPC document carried, how many could not be
// parsed, and why. A damaged transaction is counted, never dropped.
if (wireMeta.entriesTotal > 0) {
  summary.transactionsUnreadable = wireMeta.unreadable;
  summary.unreadableReasons = wireMeta.reasons;
  summary.rpcEncoding = wireMeta.encoding;
  summary.chainParsedInstructions = wireMeta.chainParsed;
}

const maxExamples = 5;

/** Decode one payload through the product's own entries and verify the bytes. */
async function decodeOne(program, hex) {
  const bytes = Buffer.from(hex, 'hex');
  if (isNativeProgram(program)) {
    try {
      const decoded = decodeNativeInstruction(program, bytes, { trailing: 'report' });
      // The upstream decoders report only the full-payload round trip; check
      // the described prefix with their own encoder so trailing bytes (the
      // legacy GetAccountDataSize padding) are evidence, not failures.
      const describedExact = decoded.roundTripByteExact === true
        || encodeNativeInstruction(program, decoded.name, decoded.args).equals(bytes.subarray(0, decoded.consumed));
      return { outcome: 'decoded', name: decoded.name, fullExact: decoded.roundTripByteExact === true, describedExact, trailing: decoded.trailing?.count ?? 0 };
    } catch (error) {
      return { outcome: 'refused', via: 'native-upstream', reason: String(error?.message ?? error).slice(0, 160) };
    }
  }
  if (isTokenProgram(program)) {
    try {
      const decoded = decodeTokenInstruction(program, bytes, { trailing: 'report' });
      const describedExact = decoded.roundTripByteExact === true
        || encodeTokenInstruction(program, decoded.name, decoded.args).equals(bytes.subarray(0, decoded.consumed));
      return { outcome: 'decoded', name: decoded.name, fullExact: decoded.roundTripByteExact === true, describedExact, trailing: decoded.trailing?.count ?? 0 };
    } catch (error) {
      return { outcome: 'refused', via: 'token-upstream', reason: String(error?.message ?? error).slice(0, 160) };
    }
  }
  if (isRaydiumProgram(program)) {
    try {
      const decoded = decodeRaydiumInstruction(program, bytes, { trailing: 'report' });
      const describedExact = decoded.roundTripByteExact === true
        || encodeRaydiumInstruction(program, decoded.name, decoded.args).equals(bytes.subarray(0, decoded.consumed));
      return { outcome: 'decoded', name: decoded.name, fullExact: decoded.roundTripByteExact === true, describedExact, trailing: decoded.trailing?.count ?? 0 };
    } catch (error) {
      return { outcome: 'refused', via: 'raydium-upstream', reason: String(error?.message ?? error).slice(0, 160) };
    }
  }
  try {
    const result = await decodeUnionPayload(store, program, hex, { trailing: 'report', absent: absentPolicy });
    return {
      outcome: 'decoded',
      name: result.name,
      fullExact: result.roundTripByteExact === true,
      describedExact: result.describedRoundTripByteExact === true,
      trailing: result.trailing?.count ?? 0,
      absent: result.absent ?? [],
      fingerprint: result.idl?.fingerprint ?? null,
    };
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 160);
    if (reason.startsWith('no stored IDL for program')) return { outcome: 'no-interface', reason };
    return { outcome: 'refused', via: 'idl', reason };
  }
}

for (const transaction of document.transactions) {
  if (limit > 0 && summary.transactionsChecked >= limit) break;
  summary.transactionsChecked += 1;
  const rows = Array.isArray(transaction.payloads) ? transaction.payloads : [];
  if (!rows.length) { summary.transactionsWithoutPayloads += 1; continue; }
  summary.transactionsWithPayloads += 1;
  if (kind === 'sample' ? transaction.failed === true : transaction.txErr != null) summary.failedOnChain += 1;

  for (const row of rows) {
    // A json-encoded document carries NO bytes for instructions its chain
    // parser already `parsed` (the parsed form replaces them). Feeding the
    // decoder an empty payload would turn a missing document field into a
    // fake refusal, so those rows are counted and skipped — named in the
    // report, never silently mixed into the decode denominator.
    if (!row.dataHex && transaction.encoding === 'json') {
      summary.missingBytes += 1;
      continue;
    }
    const program = kind === 'harvest' ? documentProgram : row.program;
    const entry = bumpProgram(program);
    summary.payloadsChecked += 1;
    entry.payloads += 1;
    const verdict = await decodeOne(program, row.dataHex);
    if (verdict.outcome === 'no-interface') {
      summary.noInterface += 1;
      entry.noInterface += 1;
      summary.noInterfacePrograms[program] = (summary.noInterfacePrograms[program] ?? 0) + 1;
      continue;
    }
    if (verdict.outcome === 'refused') {
      summary.decodeErrors += 1;
      entry.decodeErrors += 1;
      const key = `${program}: ${verdict.reason}`;
      summary.refusalReasons[key] = (summary.refusalReasons[key] ?? 0) + 1;
      if (summary.decodeErrorExamples.length < maxExamples) {
        summary.decodeErrorExamples.push({
          transaction: transaction.signature ?? null,
          program,
          dataHex: String(row.dataHex).slice(0, 80),
          reason: verdict.reason,
        });
      }
      continue;
    }
    // Decoded. Now the byte evidence — the "diff-frei" part.
    const byteOk = verdict.fullExact || verdict.describedExact;
    if (!byteOk) {
      summary.disagreements += 1;
      entry.disagreements += 1;
      if (summary.disagreementExamples.length < maxExamples) {
        summary.disagreementExamples.push({
          transaction: transaction.signature ?? null,
          program,
          name: verdict.name,
          dataHex: String(row.dataHex).slice(0, 80),
          fullExact: verdict.fullExact,
          describedExact: verdict.describedExact,
        });
      }
      continue;
    }
    summary.decoded += 1;
    entry.decoded += 1;
    if (verdict.fullExact) summary.byteExactFull += 1;
    else summary.byteExactDescribed += 1;
    if (verdict.trailing > 0) summary.trailingPayloads += 1;
    if (Array.isArray(verdict.absent) && verdict.absent.length) summary.shortFormReported += 1;
  }
}

summary.byteExactRate = summary.decoded > 0
  ? Number((100 * (summary.byteExactFull + summary.byteExactDescribed) / summary.decoded).toFixed(1))
  : null;

const failed = summary.decodeErrors > 0 || summary.disagreements > 0
  || summary.transactionsUnreadable > 0
  || (summary.payloadsChecked > 0 && summary.noInterface === summary.payloadsChecked)
  || summary.payloadsChecked === 0;
const report = {
  tool: 'stranger-decode',
  generatedAt: new Date().toISOString(),
  status: failed ? 'fail' : 'pass',
  input: {
    file: inputFile,
    kind,
    program: documentProgram,
    transactionsInDocument: document.transactions.length,
  },
  store,
  absentPolicy,
  requestedTransactions: limit,
  summary,
  // Proven that zero network calls were attempted: the guard records (and
  // rejects) every fetch; a passing run must show an empty list.
  networkAttempts: (await import('./lib/network-guard.mjs')).guard.attempts.length,
};

if (outPath) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, `${JSON.stringify(report, null, 1)}\n`);
}
  console.log(JSON.stringify({
  status: report.status,
  transactionsChecked: summary.transactionsChecked,
  payloadsChecked: summary.payloadsChecked,
  decoded: summary.decoded,
  decodeErrors: summary.decodeErrors,
  disagreements: summary.disagreements,
  noInterface: summary.noInterface,
  byteExactRate: summary.byteExactRate,
  programs: Object.keys(summary.byProgram).length,
  rpcEncoding: summary.rpcEncoding ?? null,
  chainParsedInstructions: summary.chainParsedInstructions ?? 0,
  missingBytes: summary.missingBytes,
  networkAttempts: report.networkAttempts,
}));
if (failed) {
  console.error(JSON.stringify({
    decodeErrorExamples: summary.decodeErrorExamples,
    disagreementExamples: summary.disagreementExamples,
    refusalReasons: summary.refusalReasons,
  }, null, 1));
  process.exitCode = 1;
}
