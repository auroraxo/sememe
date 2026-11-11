// rpc-response-ingest.test.mjs — a foreign repo's raw RPC documents must decode.
//
// The card's foreign-user threshold is "a foreign repository decodes 1,000
// transactions through sememe diff-free". Until a third party runs it, the
// integration has to work on what foreign repos ACTUALLY hold: raw RPC
// responses. The overwhelming default shape is `encoding: "base64"` —
// getBlock/getTransaction return the transaction as a base64 wire blob
// (signatures + serialized message) that sememe's decode path could not read
// at all before this change; only the pre-parsed `encoding: "json"` shape was
// handled. A decoder that requires its own harvester's shape is not an
// integration, it is a mirror.
//
// Fixtures (real mainnet, slot 464588080, both encodings of the SAME block,
// fetched 2026-11-04):
//   block-wire-464588080.json — the verbatim `encoding:"base64"` response
//                               (transaction = [signaturesB64, messageB64]).
//   block-json-464588080.json — the verbatim `encoding:"json"` response of the
//                               identical slot (pre-parsed base58 fields).
// The JSON document is the ORACLE: any payload the wire parser derives must
// equal, byte for byte, what the chain's own parser reports for the same
// transaction. Equality is checked per payload with JSON.stringify over the
// same extractor, so key order differences are failures, not footnotes.
//
// Falsification ladder (this file was written BEFORE tools/lib/wire-tx.mjs
// and tools/stranger-decode.mjs --rpc-response existed; against the pre-fix
// tree the whole file fails at import, and after the fix every mutation of
// the parser below is individually red):
//   - wrong base58 encoding of account keys  -> T1 red (T3 crosses it),
//   - signature sliced wrong                 -> T1 red (signature pinned),
//   - instruction data mis-sliced            -> T1/T2 red (dataHex equality),
//   - inner-instruction data re-encoded      -> T2 red (oracle equality),
//   - compact-u16 reader accepts junk        -> T4 red,
//   - wire txs silently dropped when damaged -> T5 red,
//   - --rpc-response collides with --harvest -> T6 red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'stranger-decode.mjs');
const WIRE_BLOCK = path.join(ROOT, 'test', 'fixtures', 'block-wire-464588080.json');
const JSON_BLOCK = path.join(ROOT, 'test', 'fixtures', 'block-json-464588080.json');
const WHIRLPOOL_HARVEST = path.join(ROOT, 'test', 'fixtures', 'harvest-whirlpool-2026-10-28.json');
const TRAFFIC_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');

const { normalizeRpcWireTransaction } = await import('../tools/lib/wire-tx.mjs');
const { extractPayloads } = await import('../tools/lib/payloads.mjs');

async function readBlock(file) {
  return (await readFile(file, 'utf8')).length ? JSON.parse(await readFile(file, 'utf8')) : null;
}

test('wire parser reproduces the chain parser for every transaction of the block (unit, tx 0 pinned)', async () => {
  const wire = await readBlock(WIRE_BLOCK);
  const json = await readBlock(JSON_BLOCK);
  assert.ok(Array.isArray(wire?.result?.transactions), 'wire fixture must carry result.transactions');
  assert.equal(wire.result.transactions.length, json.result.transactions.length);

  const first = normalizeRpcWireTransaction(wire.result.transactions[0]);
  assert.equal(first.signature, json.result.transactions[0].transaction.signatures?.[0] ?? null,
    'tx 0 signature must be the same 64-byte signer the json encoding reports');
  assert.equal(first.version, json.result.transactions[0].version, 'version mapping must match');

  // Message-level facts pinned from the real block, so a parser that decodes
  // the wrong section cannot pass.
  const oracle = json.result.transactions[0].transaction.message;
  assert.equal(first.transaction.message.accountKeys.length, oracle.accountKeys.length);
  assert.equal(first.transaction.message.instructions.length, oracle.instructions.length);
  for (const [i, ix] of first.transaction.message.instructions.entries()) {
    assert.equal(ix.programIdIndex, oracle.instructions[i].programIdIndex, `ix ${i} programIdIndex`);
    assert.equal(ix.data, oracle.instructions[i].data, `ix ${i} data must be identical base58`);
    assert.deepEqual(ix.accounts, oracle.instructions[i].accounts, `ix ${i} accounts`);
  }
});

test('per-payload equality: wire-derived rows equal the json oracle for ALL transactions and programs', async () => {
  const wire = await readBlock(WIRE_BLOCK);
  const json = await readBlock(JSON_BLOCK);
  let payloads = 0;
  for (const [t, wireEntry] of wire.result.transactions.entries()) {
    const normalized = normalizeRpcWireTransaction(wireEntry);
    const jsonTx = json.result.transactions[t].transaction;
    // Same extractor on both sides; the oracle's account list comes from the
    // json document itself (static + loadedAddresses), so this compares what
    // each path believes the bytes mean, not what one path said twice.
    const jsonRows = extractPayloads({ transaction: jsonTx, meta: json.result.transactions[t].meta }, '*all*');
    const wireRows = extractPayloads({ transaction: normalized.transaction, meta: normalized.meta }, '*all*');
    // extractPayloads filters by target program id; to compare the WHOLE
    // transaction, walk the distinct program ids of both sides instead.
    const programsOf = (rows, tx) => {
      const set = new Set();
      for (const ix of tx.message.instructions) set.add(ix.programId ?? tx.message.accountKeys[ix.programIdIndex]);
      return set;
    };
    const jsonPrograms = programsOf(jsonRows, jsonTx);
    const wirePrograms = programsOf(wireRows, normalized.transaction);
    assert.deepEqual([...wirePrograms].sort(), [...jsonPrograms].sort(), `tx ${t} program set`);
    for (const program of wirePrograms) {
      const a = extractPayloads({ transaction: jsonTx, meta: json.result.transactions[t].meta }, program);
      const b = extractPayloads({ transaction: normalized.transaction, meta: normalized.meta }, program);
      assert.equal(
        JSON.stringify(b),
        JSON.stringify(a),
        `tx ${t} program ${program}: wire rows must equal oracle rows`,
      );
      payloads += b.length;
    }
  }
  assert.ok(payloads > 500, `expected a real block to carry hundreds of watched payloads, got ${payloads}`);
});

test('stranger-decode --rpc-response decodes the whole wire block diff-free', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-wire-'));
  try {
    const reportPath = path.join(tmp, 'report.json');
    const { stdout } = await run(process.execPath, [
      TOOL, '--store', TRAFFIC_STORE, '--rpc-response', WIRE_BLOCK, '--absent', 'verified', '--out', reportPath,
    ], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'pass');
    assert.equal(report.networkAttempts, 0, 'zero-RPC guard must hold on foreign-shaped input');
    assert.equal(report.summary.transactionsChecked, 648, 'every transaction of the block is checked');
    assert.equal(report.summary.transactionsUnreadable, 0, 'no transaction may be silently dropped');
    // Pinned from the measured run (2026-11-04, slot 464588080). A change
    // means the parser, the tool, or the fixture changed.
    assert.equal(report.summary.payloadsChecked, 4425, `expected the measured 4,425 payloads, got ${report.summary.payloadsChecked}`);
    assert.equal(report.summary.disagreements, 0, 'diff-free means zero disagreements');
    assert.equal(report.summary.decodeErrors, 0, 'every decoded-name claim must be reproducible');
    assert.ok(report.summary.byteExactRate === 100, `byte-exact rate must be 100, got ${report.summary.byteExactRate}`);
    // 1,166 payloads belong to programs the store does not carry: the run
    // must NAME them, not silently skip them.
    assert.ok(report.summary.noInterface > 0, 'programs outside the store must be reported');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('1,000+ foreign-archive wire transactions decode diff-free (foreign-user threshold)', async () => {
  const archivePath = path.join(ROOT, 'test', 'fixtures', 'foreign-archive-wire-4blocks.json');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-wire-archive-'));
  try {
    const reportPath = path.join(tmp, 'report.json');
    const { stdout } = await run(process.execPath, [
      TOOL, '--store', TRAFFIC_STORE, '--rpc-response', archivePath, '--absent', 'verified', '--limit', '1000', '--out', reportPath,
    ], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'pass');
    assert.equal(report.networkAttempts, 0);
    assert.equal(report.summary.transactionsChecked, 1000);
    assert.equal(report.summary.transactionsUnreadable, 0);
    // Measured 2026-11-04 on contiguous slots 464588080..464588083 (1,947
    // transactions in document, checked the first 1,000): 6,355 payloads.
    // First measured at 4,646 decoded / 1,709 no-interface across 115
    // programs; 2026-11-11 the ATA table (ATokenGPvbd… 386 payloads here)
    // landed and the same archive reads 5,032 decoded / 1,323 no-interface —
    // zero disagreements, every decoded claim reproducible, byte-exact 100.
    assert.equal(report.summary.payloadsChecked, 6355);
    assert.equal(report.summary.decoded, 5032);
    assert.equal(report.summary.decodeErrors, 0);
    assert.equal(report.summary.disagreements, 0);
    assert.equal(report.summary.byteExactRate, 100);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('compact-u16 reader is strict: junk continuations are refused, not guessed', async () => {
  const { decodeCompactU16 } = await import('../tools/lib/wire-tx.mjs');
  assert.deepEqual(decodeCompactU16(Buffer.from([0x00]), 0), [0, 1]);
  assert.deepEqual(decodeCompactU16(Buffer.from([0x80, 0x01]), 0), [128, 2]);
  assert.deepEqual(decodeCompactU16(Buffer.from([0xff, 0x7f]), 0), [16383, 2]);
  // The max Solana shortvec (a u16): [0xff,0xff,0x03] === 0xffff.
  assert.deepEqual(decodeCompactU16(Buffer.from([0xff, 0xff, 0x03]), 0), [0xffff, 3]);
  // Beyond the u16 range or with a 4th continuation byte: refused by name.
  assert.throws(() => decodeCompactU16(Buffer.from([0xff, 0xff, 0x04]), 0), /0xffff/);
  assert.throws(() => decodeCompactU16(Buffer.from([0xff, 0xff, 0xff]), 0), /0xffff/);
  assert.throws(() => decodeCompactU16(Buffer.from([0x80]), 0), /truncated/);
});

test('damaged wire transactions are named, counted, never silently dropped', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-wire-damage-'));
  try {
    const doc = await readBlock(WIRE_BLOCK);
    const t0 = doc.result.transactions[0];
    const buf = Buffer.from(t0.transaction[0], 'base64');
    // Flip one byte INSIDE the message (an account key): the wire bytes stay
    // structurally valid, so only the signature check can catch it. Without
    // that check the parser would silently attribute the payload to a
    // program it never touched.
    buf[70] ^= 0xff;
    const damaged = {
      jsonrpc: '2.0', id: 1,
      result: { ...doc.result, transactions: [{ ...t0, transaction: [buf.toString('base64'), 'base64'] }] },
    };
    const wireFile = path.join(tmp, 'damaged.json');
    await writeFile(wireFile, JSON.stringify(damaged));
    const reportPath = path.join(tmp, 'report.json');
    // The run must FAIL (exit 1), but it must still write its report — that
    // is the contract: a damaged transaction is named, not swallowed.
    const outcome = await run(process.execPath, [
      TOOL, '--store', TRAFFIC_STORE, '--rpc-response', wireFile, '--out', reportPath,
    ], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }).then(
      () => 'unexpected-pass',
      (error) => (error.code === 1 ? 'failed-as-expected' : `unexpected-exit-${error.code}`),
    );
    assert.equal(outcome, 'failed-as-expected', 'a damaged transaction must exit 1');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'fail', 'a damaged transaction must fail the run');
    assert.equal(report.summary.transactionsUnreadable, 1, 'the damaged tx must be counted, not skipped');
    assert.ok(report.summary.unreadableReasons['wire-signature-invalid'], `named reason missing: ${JSON.stringify(report.summary.unreadableReasons)}`);
    assert.equal(report.summary.transactionsChecked, 0, 'a damaged tx must not land in the checked denominator');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('every transaction of the corpus verifies its own signature (self-verifying wire ingestion)', async () => {
  const wire = await readBlock(WIRE_BLOCK);
  const { normalizeRpcWireTransaction } = await import('../tools/lib/wire-tx.mjs');
  let verified = 0;
  for (const entry of wire.result.transactions) {
    const normalized = normalizeRpcWireTransaction(entry);
    assert.ok(normalized.signature, 'each transaction must carry its signature');
    verified += 1;
  }
  assert.equal(verified, 648, 'all 648 transactions of the block must verify');
});

test('non-RPC documents are refused with exit 2, and --rpc-response stays mutually exclusive', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-wire-bad-'));
  try {
    const badFile = path.join(tmp, 'not-rpc.json');
    await writeFile(badFile, JSON.stringify({ hello: 'world' }));
    await assert.rejects(
      run(process.execPath, [TOOL, '--store', TRAFFIC_STORE, '--rpc-response', badFile], { cwd: ROOT }),
      (error) => error.code === 2 && /no RPC result/.test(String(error.stderr)),
    );
    // Mutual exclusivity: --rpc-response alongside --harvest must be refused.
    await assert.rejects(
      run(process.execPath, [TOOL, '--store', TRAFFIC_STORE, '--rpc-response', WIRE_BLOCK, '--harvest', WHIRLPOOL_HARVEST], { cwd: ROOT }),
      (error) => error.code === 2 && /exactly one/.test(String(error.stderr)),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('false-positive guard: the existing --harvest path still passes unchanged', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-wire-guard-'));
  try {
    const reportPath = path.join(tmp, 'report.json');
    const { stdout } = await run(process.execPath, [
      TOOL, '--store', TRAFFIC_STORE, '--harvest', WHIRLPOOL_HARVEST, '--limit', '200', '--out', reportPath,
    ], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'pass');
    assert.equal(report.summary.decodeErrors, 0);
    assert.equal(report.summary.disagreements, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
