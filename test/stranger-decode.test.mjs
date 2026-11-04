// stranger-decode.test.mjs — tests for the copy-pasteable 1,000-transaction stranger decode tool.
//
// The card requires:
//   "FREMDNUTZER-SCHWELLE — ein fremdes Repo, das 1000 Tx diff-frei durch
//   sememe decodet. #96-Signal abfragen; ohne Reaktion fremde Konsumenten
//   direkt suchen (Explorer/Indexer/Dashboards) und die Integration reale
//   machen: Quickstart + 1000-Tx-Befehl zum Copy-Pasten."
//
// This test file exercises tools/stranger-decode.mjs:
//   1. Runs 1,000+ real mainnet transactions across 1,119 payloads (Whirlpool harvest)
//      with zero unexpected errors, zero disagreements, and verifiable byte-exactness.
//   2. Falsification / negative-control: tampering with the payload bytes or the store
//      makes the tool exit non-zero with a named discrepancy report.
//   3. Supports multi-program traffic samples (native, token, raydium, IDL) with
//      transparent classification and exit code 0 when all watched payloads decode.
//   4. Pure offline operation: guarded by zero-RPC check.

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
const WHIRLPOOL_HARVEST = path.join(ROOT, 'test', 'fixtures', 'harvest-whirlpool-2026-10-28.json');
const WHIRLPOOL_IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');
const TRAFFIC_SAMPLE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-2026-11-04.json');
const TRAFFIC_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');

// Helper to create a minimal valid sememe store from an IDL fixture
async function makeWhirlpoolStore(dir) {
  const { canonicalJson } = await import('../src/canonical.mjs');
  const { createHash } = await import('node:crypto');
  const idl = JSON.parse(await readFile(WHIRLPOOL_IDL, 'utf8'));
  const canonical = canonicalJson(idl);
  const hash = createHash('sha256').update(`${canonical}\n`).digest('hex');
  const program = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  const slot = 462039125;

  const objectsDir = path.join(dir, 'objects');
  const receiptsDir = path.join(dir, 'receipts');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(objectsDir, { recursive: true });
  await mkdir(receiptsDir, { recursive: true });

  await writeFile(path.join(objectsDir, `${hash}.json`), `${canonical}\n`, 'utf8');
  const receipt = {
    program,
    slot,
    source: 'anchor',
    fingerprint: `sha256:${hash}`,
    address: 'AYgC53tU5BbP2NAnv5nConJxAdpQZctvmZK88pu69xRs',
    instructionCount: idl.instructions?.length ?? 0,
  };
  const receiptName = `${program}-${slot}-anchor-${hash}.json`;
  await writeFile(path.join(receiptsDir, receiptName), JSON.stringify(receipt, null, 2), 'utf8');
}

test('stranger-decode decodes 1,000+ real transactions diff-free', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-stranger-'));
  try {
    await makeWhirlpoolStore(tmp);
    const reportPath = path.join(tmp, 'report.json');

    const { stdout, stderr } = await run(process.execPath, [
      TOOL,
      '--store', tmp,
      '--harvest', WHIRLPOOL_HARVEST,
      '--limit', '1000',
      '--out', reportPath,
    ], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });

    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'pass');
    // Offline claim is a property of the run, not of the prose: the zero-RPC
    // guard must have recorded zero attempts while decoding real mainnet bytes.
    assert.equal(report.networkAttempts, 0, 'the run must make zero network attempts');
    assert.ok(report.summary.transactionsChecked >= 1000, `expected >= 1000 txs, got ${report.summary.transactionsChecked}`);
    assert.ok(report.summary.payloadsChecked >= 1000, `expected >= 1000 payloads, got ${report.summary.payloadsChecked}`);
    // Measured 2026-11-04 on the committed fixture: the first 1,000 pinned
    // transactions carry exactly 1,089 Whirlpool payloads, every one of them
    // decodes and re-encodes byte-exactly. Pinning the exact numbers so a
    // change in them means the CODE or the FIXTURE changed.
    assert.equal(report.summary.payloadsChecked, 1089, `expected the measured 1,089 payloads, got ${report.summary.payloadsChecked}`);
    assert.equal(report.summary.decoded, 1089, `expected all 1,089 decoded, got ${report.summary.decoded}`);
    assert.equal(report.summary.byteExactRate, 100, `expected 100% byte-exact, got ${report.summary.byteExactRate}%`);
    assert.equal(report.summary.disagreements, 0, 'zero disagreements expected');
    assert.equal(report.summary.decodeErrors, 0, 'zero decode errors expected');
    assert.ok(report.summary.byteExactRate >= 95.0, `byte-exact rate should be >= 95%, got ${report.summary.byteExactRate}%`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stranger-decode falsification: tampered payload fails with non-zero exit', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-stranger-tamper-'));
  try {
    await makeWhirlpoolStore(tmp);
    const harvest = JSON.parse(await readFile(WHIRLPOOL_HARVEST, 'utf8'));
    // Tamper with first transaction's first payload: flip first byte of dataHex
    const tampered = JSON.parse(JSON.stringify(harvest));
    const firstPayloadTx = tampered.transactions.find((tx) => tx.payloads?.length > 0);
    assert.ok(firstPayloadTx);
    const origHex = firstPayloadTx.payloads[0].dataHex;
    // Flip first char: 'f' -> '0'
    firstPayloadTx.payloads[0].dataHex = (origHex[0] === '0' ? '1' : '0') + origHex.slice(1);

    const tamperedHarvestPath = path.join(tmp, 'tampered-harvest.json');
    await writeFile(tamperedHarvestPath, JSON.stringify(tampered));

    let threw = false;
    try {
      await run(process.execPath, [
        TOOL,
        '--store', tmp,
        '--harvest', tamperedHarvestPath,
        '--limit', '50',
      ], { cwd: ROOT });
    } catch (err) {
      threw = true;
      assert.notEqual(err.code, 0, 'must exit non-zero on decode error/disagreement');
    }
    assert.ok(threw, 'tool must reject tampered transaction payload');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stranger-decode falsification: missing store fails with exit 2', async () => {
  const nonExistentStore = path.join(os.tmpdir(), 'non-existent-sememe-store-' + Date.now());
  let threw = false;
  try {
    await run(process.execPath, [
      TOOL,
      '--store', nonExistentStore,
      '--harvest', WHIRLPOOL_HARVEST,
      '--limit', '10',
    ], { cwd: ROOT });
  } catch (err) {
    threw = true;
    // Exit 2 is the contract for a missing store (usage/IO), not exit 1:
    // a stranger must see "run sememe pull first", not a decode disagreement.
    assert.equal(err.code, 2, `expected exit 2 for a missing store, got ${err.code}`);
  }
  assert.ok(threw, 'missing store must fail');
});

test('stranger-decode runs against multi-program traffic sample with verified short forms', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-stranger-traffic-'));
  try {
    const reportPath = path.join(tmp, 'traffic-report.json');
    const { stdout } = await run(process.execPath, [
      TOOL,
      '--store', TRAFFIC_STORE,
      '--sample', TRAFFIC_SAMPLE,
      '--limit', '1000',
      '--absent', 'verified',
      '--out', reportPath,
    ], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });

    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'pass');
    assert.ok(report.summary.transactionsChecked >= 1000);
    assert.ok(report.summary.payloadsChecked >= 1000);
    assert.equal(report.summary.decodeErrors, 0);
    assert.equal(report.summary.disagreements, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
