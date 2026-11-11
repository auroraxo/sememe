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
import { readFile, readdir } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import path from 'node:path';
import { decodePayload, decodeUnionPayload } from '../src/decode.mjs';
import { decodeNativeInstruction, isNativeProgram } from '../src/native.mjs';
import { decodeTokenInstruction, isTokenProgram, encodeTokenInstruction } from '../src/token.mjs';
import { decodeRaydiumInstruction, isRaydiumProgram, encodeRaydiumInstruction } from '../src/raydium.mjs';
import { decodeAtaInstruction, isAtaProgram } from '../src/ata.mjs';
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
const fixturesDir = option('--fixtures-dir', null);
const outPath = option('--out', null);
const limit = Number(option('--limit', '1000'));
const absentPolicy = option('--absent', 'error');

const usageExit = (message) => {
  console.error(`stranger-decode: ${message}`);
  console.error('usage: node tools/stranger-decode.mjs --store <dir> (--harvest <file> | --sample <file> | --rpc-response <file> | --fixtures-dir <dir>) [--limit N] [--absent error|verified|report] [--out report.json]');
  process.exit(2);
};

if (!store) usageExit('--store is required (the store `sememe pull` writes)');
const chosenSources = [harvestPath, samplePath, rpcResponsePath, fixturesDir].filter(Boolean);
if (chosenSources.length !== 1) usageExit('give exactly one of --harvest, --sample, --rpc-response or --fixtures-dir');
if (!Number.isFinite(limit) || limit < 0) usageExit('--limit must be a number >= 0 (0 = no limit)');
if (!['error', 'report', 'verified'].includes(absentPolicy)) usageExit(`--absent must be error, verified or report, got ${JSON.stringify(absentPolicy)}`);
try {
  accessSync(path.join(store, 'receipts'));
} catch {
  usageExit(`no sememe store at ${store}: run "sememe pull <program-id> --store ${store}" first`);
}

class UsageRefusal extends Error {}

const kind = fixturesDir ? 'fixtures-dir' : rpcResponsePath ? 'rpc-response' : harvestPath ? 'harvest' : 'sample';
let inputTransactionCount = 0;
let inputProgram = null;

/**
 * Build ONE transaction document from a file, with the same decisions the
 * single-file paths make. Returns { document, wireMeta } or throws a refusal
 * (named) when the file is not a transaction document at all.
 *
 * The --fixtures-dir sweep calls this PER FILE: a sweep is the same
 * instrument run over many files, never a second implementation that could
 * drift from the one a stranger uses.
 */
async function buildDocumentFromFile(file) {
  const wireMeta = { entriesTotal: 0, unreadable: 0, reasons: {}, encoding: null, chainParsed: 0 };
  let document;
  try {
    document = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new UsageRefusal(`cannot read ${file}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  const { transactionsFromRpcDocument, normalizeRpcWireTransaction, normalizeRpcJsonTransaction, normalizeFlatTransaction } = await import('./lib/wire-tx.mjs');
  let entries;
  try {
    ({ transactions: entries } = transactionsFromRpcDocument(document));
  } catch (error) {
    throw new UsageRefusal(`${file}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  // The encoding is decided by the DOCUMENT, not by a flag: a transaction
  // whose bytes are a base64 string is a wire entry; a transaction whose
  // instructions are objects is the chain's json encoding. Guessing wrong
  // here would decode a payload from the wrong field, so the decision is
  // made per entry and a mixed document is refused rather than half-read.
  const isWireEntry = (entry) => Array.isArray(entry?.transaction) && typeof entry.transaction[0] === 'string';
  const isJsonEntry = (entry) => Array.isArray(entry?.transaction?.message?.instructions);
  // A third dialect, measured on step-finance-oss/step-ingestooor (MIT) on
  // 2026-11-04: the transaction is FLATTENED — `instructions` and `accounts`
  // sit at the file level, `transaction.message` keeps only the blockhash (or
  // is absent entirely). 37 of that repo's 156 fixtures hold this shape.
  const isFlatEntry = (entry) => Array.isArray(entry?.instructions);
  wireMeta.entriesTotal = entries.length;
  const readable = [];
  const entryEncodings = [];
  for (const [index, entry] of entries.entries()) {
    const wire = isWireEntry(entry);
    const json = isJsonEntry(entry);
    const flat = !wire && !json && isFlatEntry(entry);
    if (!wire && !json && !flat) {
      wireMeta.reasons['rpc-encoding-unknown'] = (wireMeta.reasons['rpc-encoding-unknown'] ?? 0) + 1;
      continue;
    }
    if ((wire && json) || (flat && (wire || json))) {
      wireMeta.reasons['rpc-encoding-ambiguous'] = (wireMeta.reasons['rpc-encoding-ambiguous'] ?? 0) + 1;
      continue;
    }
    try {
      const normalized = wire ? normalizeRpcWireTransaction(entry) : json ? normalizeRpcJsonTransaction(entry) : normalizeFlatTransaction(entry);
      entryEncodings.push(wire ? 'base64' : json ? 'json' : 'flat');
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
  wireMeta.encoding = entryEncodings.length
    ? (entryEncodings[0] === 'flat' ? 'flat' : readable.some((entry) => entry?.transaction?.message?.instructions?.length
      && entry.transaction.message.instructions[0]?.programId !== undefined) ? 'json' : 'base64')
    : null;
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
  const out = {
    transactions: readable.map((normalized, position) => ({
      signature: normalized.signature,
      txErr: normalized.meta?.err ?? null,
      encoding: entryEncodings[position],
      payloads: rowsOf(normalized),
    })),
  };
  return { document: out, wireMeta };
}

const summary = {
  transactionsChecked: 0,
  transactionsWithPayloads: 0,
  transactionsWithoutPayloads: 0,
  transactionsUnreadable: 0,
  unreadableReasons: {},
  fixturesTotal: kind === 'fixtures-dir' ? 0 : undefined,
  fixturesUnreadable: kind === 'fixtures-dir' ? 0 : undefined,
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

// Wire-ingest provenance, recorded on the report (only for the RPC paths):
// how many transactions the RPC document carried, how many could not be
// parsed, and why. A damaged transaction is counted, never dropped.
// Wire-ingest provenance, recorded on the report (only for the RPC paths):
// how many transactions the RPC document carried, how many could not be
// parsed, and why. A damaged transaction is counted, never dropped.
function recordWireMeta(wireMeta) {
  if (wireMeta.entriesTotal > 0) {
    summary.transactionsUnreadable += wireMeta.unreadable;
    for (const [reason, count] of Object.entries(wireMeta.reasons)) {
      summary.unreadableReasons[reason] = (summary.unreadableReasons[reason] ?? 0) + count;
    }
    // Single-file reports name THE encoding; sweeps count how many files held
    // which encoding — a single value would be whichever file ran last.
    if (wireMeta.encoding && kind !== 'fixtures-dir') summary.rpcEncoding = wireMeta.encoding;
    if (wireMeta.encoding) {
      summary.encodingsSeen ??= {};
      summary.encodingsSeen[wireMeta.encoding] = (summary.encodingsSeen[wireMeta.encoding] ?? 0) + 1;
    }
    summary.chainParsedInstructions = (summary.chainParsedInstructions ?? 0) + wireMeta.chainParsed;
  }
}

const maxExamples = 5;

/** Decode every payload of one already-built transaction document. */
async function runDocument(transactions) {
  for (const transaction of transactions) {
    if (limit > 0 && summary.transactionsChecked >= limit) break;
    summary.transactionsChecked += 1;
    const rows = Array.isArray(transaction.payloads) ? transaction.payloads : [];
    if (!rows.length) { summary.transactionsWithoutPayloads += 1; continue; }
    summary.transactionsWithPayloads += 1;
    if (kind === 'sample' ? transaction.failed === true : transaction.txErr != null) summary.failedOnChain += 1;

    for (const row of rows) {
      // A json/flat-encoded document carries NO bytes for instructions its
      // chain parser already `parsed` (the parsed form replaces them). Feeding
      // the decoder an empty payload would turn a missing document field into
      // a fake refusal, so those rows are counted and skipped — named in the
      // report, never silently mixed into the decode denominator.
      if (!row.dataHex && transaction.encoding !== 'base64') {
        summary.missingBytes += 1;
        continue;
      }
      const program = row.program;
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
}


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
  if (isAtaProgram(program)) {
    try {
      const decoded = decodeAtaInstruction(program, bytes, { trailing: 'report' });
      return { outcome: 'decoded', name: decoded.name, fullExact: decoded.roundTripByteExact === true, describedExact: decoded.roundTripByteExact === true, trailing: decoded.trailing?.count ?? 0 };
    } catch (error) {
      return { outcome: 'refused', via: 'ata-upstream', reason: String(error?.message ?? error).slice(0, 160) };
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

// ---- Main flow -------------------------------------------------------------
//
// Single-file modes keep the exact copy-paste contract; --fixtures-dir sweeps
// every *.json of a directory tree through the SAME per-file path and reports
// one verdict row per file. A file that is not a transaction document is not
// a crash in a sweep: it is counted (fixturesUnreadable, named reason) and
// the sweep's totals stay attributable per file.

const perFileRows = [];

if (kind === 'fixtures-dir') {
  let names;
  try {
    names = (await readdir(fixturesDir, { recursive: true })).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    usageExit(`cannot read fixtures dir ${fixturesDir}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  if (!names.length) usageExit(`${fixturesDir} holds no .json fixture files`);
  for (const name of names) {
    const file = path.join(fixturesDir, name);
    let built;
    try {
      built = await buildDocumentFromFile(file);
    } catch (error) {
      if (error instanceof UsageRefusal) {
        summary.fixturesTotal += 1;
        summary.fixturesUnreadable += 1;
        const reason = /not-an-rpc-response/.test(error.message) ? 'not-an-rpc-response' : error.message.slice(0, 120);
        perFileRows.push({ file: name, unreadable: 1, reason, transactions: 0, payloadsChecked: 0, decoded: 0, decodeErrors: 0, disagreements: 0, noInterface: 0, missingBytes: 0 });
        continue;
      }
      throw error;
    }
    const before = {
      transactions: summary.transactionsChecked,
      payloadsChecked: summary.payloadsChecked,
      decoded: summary.decoded,
      decodeErrors: summary.decodeErrors,
      disagreements: summary.disagreements,
      noInterface: summary.noInterface,
      missingBytes: summary.missingBytes,
      unreadable: summary.transactionsUnreadable,
    };
    recordWireMeta(built.wireMeta);
    inputTransactionCount += built.document.transactions.length;
    await runDocument(built.document.transactions);
    const row = {
      file: name,
      encoding: built.wireMeta.encoding,
      transactions: summary.transactionsChecked - before.transactions,
      unreadable: summary.transactionsUnreadable - before.unreadable,
      chainParsed: built.wireMeta.chainParsed,
      payloadsChecked: summary.payloadsChecked - before.payloadsChecked,
      decoded: summary.decoded - before.decoded,
      decodeErrors: summary.decodeErrors - before.decodeErrors,
      disagreements: summary.disagreements - before.disagreements,
      noInterface: summary.noInterface - before.noInterface,
      missingBytes: summary.missingBytes - before.missingBytes,
    };
    perFileRows.push(row);
    summary.fixturesTotal += 1;
  }
} else if (kind === 'harvest' || kind === 'sample') {
  // The harvest/sample documents are sememe's OWN shapes (a program at
  // document level / per-row programs) — read verbatim, exactly as before
  // the sweep existed. Only the RPC paths go through the normalizer.
  const sourceFile = harvestPath ?? samplePath;
  let document;
  try {
    document = JSON.parse(await readFile(sourceFile, 'utf8'));
  } catch (error) {
    usageExit(`cannot read ${sourceFile}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  if (!Array.isArray(document.transactions) || !document.transactions.length) {
    usageExit(`${sourceFile} carries no readable transactions`);
  }
  if (kind === 'harvest' && typeof document.program !== 'string') {
    usageExit(`${sourceFile} is a harvest without a program field`);
  }
  inputProgram = kind === 'harvest' ? document.program : null;
  inputTransactionCount = document.transactions.length;
  // The harvest path names its program at document level; the per-row program
  // is filled in here so runDocument stays shape-agnostic.
  if (kind === 'harvest') {
    for (const transaction of document.transactions) {
      for (const row of transaction.payloads ?? []) row.program = inputProgram;
    }
  }
  await runDocument(document.transactions);
} else {
  const sourceFile = rpcResponsePath;
  let built;
  try {
    built = await buildDocumentFromFile(sourceFile);
  } catch (error) {
    if (error instanceof UsageRefusal) usageExit(error.message);
    throw error;
  }
  recordWireMeta(built.wireMeta);
  inputTransactionCount = built.document.transactions.length;
  await runDocument(built.document.transactions);
}

summary.byteExactRate = summary.decoded > 0
  ? Number((100 * (summary.byteExactFull + summary.byteExactDescribed) / summary.decoded).toFixed(1))
  : null;

// Sweep vs single-file failure semantics, measured and stated rather than
// inherited: the SINGLE-FILE contract (what a stranger copies from the
// README) stays byte-identical — any refusal exits 1. A SWEEP over a foreign
// repo's whole fixture set answers a different question: can the instrument
// read and give a verdict to every fixture, and does every payload it DECODED
// reproduce its bytes? Refusals (unknown discriminator, unwitnessed short
// form, no interface) are verdicts with reasons — the acquisition gaps this
// run quantifies — and are pinned per file in the report and per number in
// the committed research artifact, so a NEW refusal still goes red.
const failed = kind === 'fixtures-dir'
  ? summary.disagreements > 0
    || summary.transactionsUnreadable > 0
    || summary.payloadsChecked === 0
  : summary.decodeErrors > 0 || summary.disagreements > 0
    || summary.transactionsUnreadable > 0
    || (summary.payloadsChecked > 0 && summary.noInterface === summary.payloadsChecked)
    || summary.payloadsChecked === 0;
const report = {
  tool: 'stranger-decode',
  ...(kind === 'fixtures-dir' ? {
    fixturesDir,
    fixturesTotal: summary.fixturesTotal,
    fixturesUnreadable: summary.fixturesUnreadable,
    perFile: perFileRows,
  } : {}),
  generatedAt: new Date().toISOString(),
  status: failed ? 'fail' : 'pass',
  input: {
    file: kind === 'fixtures-dir' ? fixturesDir : (harvestPath ?? samplePath ?? rpcResponsePath),
    kind,
    ...(inputProgram !== null ? { program: inputProgram } : {}),
    transactionsInDocument: inputTransactionCount,
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
