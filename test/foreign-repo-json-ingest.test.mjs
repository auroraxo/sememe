// foreign-repo-json-ingest.test.mjs — a foreign repository's OWN fixtures must decode.
//
// The card's next step is the FIRST FOREIGN RUN: dock onto a concrete foreign
// repository that holds RPC responses and decode what IT holds. Two foreign
// repositories were measured for this (2026-11-04):
//
//   step-finance-oss/step-ingestooor (MIT) — 122 transaction fixtures under
//     crates/parsers/tests/, each a `encoding:"json"` getTransaction result:
//     instruction data as base58, every instruction carrying `programId`
//     spelled out, inner instructions under `meta`, and the address-table keys
//     ALREADY EXPANDED inside `message.accountKeys` (entries with
//     `source: "lookupTable"`).
//
//   CryptGodSon/Solana-Explorer (MIT) — the same shape in its
//     tests/fixtures/transfer_transaction.json.
//
// The gap this file measures, before the fix: sememe's `--rpc-response` read
// ONLY the default `encoding:"base64"` shape. Run against a foreign repo's
// own fixture it exited 2 with `not-an-rpc-response` — the integration could
// not read a single foreign artifact, because the one shape it accepted was
// the shape sememe's OWN harvester produces.
//
// The second gap, measured in the same fixtures: in the json encoding the
// chain's parser has ALREADY parsed 104 of 160 instruction rows (spl-token,
// system, associated-token, stake, memo) and REPLACED their bytes with a
// parsed object. Those rows carry no bytes at all. Feeding them to the
// decoder as empty payloads would turn a missing document field into a fake
// refusal — so they are counted (`chainParsedInstructions` / `missingBytes`)
// and never decoded.
//
// Falsification ladder (each mutation below is individually red):
//   - json encoding refused outright            -> T1/T2 red (the tool exits 2),
//   - chain-parsed rows decoded as empty bytes  -> T3 red (missingBytes 0),
//   - a wrong program attribution                -> T3 red (noInterface/decoded),
//   - a document with an unresolvable index      -> T4 red (must be refused),
//   - the base64 path broken by the change       -> T5 red (the wire path still
//     decodes 4,425 payloads of the block fixture diff-free),
//   - a mutated byte in a foreign fixture       -> T6 red (structural damage
//     must fail the run; a structurally-valid argument mutation passes by
//     design — the json encoding carries no signature over these bytes, and
//     that limit is stated in the test rather than hidden).

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
const FOREIGN_DIR = path.join(ROOT, 'test', 'fixtures', 'foreign-repo-json-2026-11-04');
const TRAFFIC_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');
const WIRE_BLOCK = path.join(ROOT, 'test', 'fixtures', 'block-wire-464588080.json');

// The six fixtures copied verbatim from step-finance-oss/step-ingestooor
// (commit 001cf39) and one from CryptGodSon/Solana-Explorer. Both are MIT.
const FOREIGN_FIXTURES = [
  'orca_initialize_pool_v2.json',
  'missing_ata.json',
  'swap_mu.json',
  'farm_deposit.json',
  'withdraw_close_all.json',
  'sol_orca_swap_tx.json',
  'transfer_transaction.json',
];

async function runTool(args) {
  return run(process.execPath, [TOOL, ...args], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
}

/** Run the tool on one foreign fixture and return its report. */
async function reportFor(file, extra = []) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-foreign-json-'));
  try {
    const reportPath = path.join(tmp, 'report.json');
    const { stdout } = await runTool([
      '--store', TRAFFIC_STORE,
      '--rpc-response', path.join(FOREIGN_DIR, file),
      '--out', reportPath,
      ...extra,
    ]);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    return { report, stdout: JSON.parse(stdout) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test('a foreign repository\'s own json fixture decodes through the product', async () => {
  const { report, stdout } = await reportFor('orca_initialize_pool_v2.json');
  assert.equal(report.status, 'pass', 'a foreign fixture must decode, not fail the run');
  assert.equal(report.networkAttempts, 0, 'the zero-RPC guard must hold on foreign input');
  assert.equal(report.summary.rpcEncoding, 'json', 'the document shape must be recognized as the json encoding');
  assert.equal(report.summary.transactionsChecked, 1);
  assert.equal(report.summary.transactionsUnreadable, 0, 'no foreign transaction may be dropped');
  // The Whirlpool initialize_pool_v2 payload of the fixture, byte-exact.
  // Measured 2026-11-04: the fixture carries 8 byte-bearing Whirlpool
  // instructions (1x initialize_pool_v2 + 7 open-position forms) — all 8
  // decode byte-exactly through the store's Whirlpool IDL.
  assert.equal(report.summary.decoded, 8, `expected 8 decoded Whirlpool payloads, got ${report.summary.decoded}`);
  assert.equal(report.summary.disagreements, 0, 'diff-free means zero disagreements');
  assert.equal(report.summary.decodeErrors, 0);
  assert.equal(report.summary.byteExactRate, 100, `byte-exact rate must be 100, got ${report.summary.byteExactRate}`);
  assert.equal(stdout.programs >= 1, true);
});

test('all seven foreign fixtures from TWO foreign repositories decode diff-free', async () => {
  const totals = { transactions: 0, decoded: 0, missingBytes: 0, chainParsed: 0, decodeErrors: 0, disagreements: 0, noInterface: 0 };
  for (const file of FOREIGN_FIXTURES) {
    const { report } = await reportFor(file);
    assert.equal(report.status, 'pass', `${file} must decode`);
    assert.equal(report.networkAttempts, 0, `${file}: zero-RPC guard`);
    assert.equal(report.summary.transactionsUnreadable, 0, `${file}: no transaction may be dropped`);
    assert.equal(report.summary.decodeErrors, 0, `${file}: every decoded name must be reproducible`);
    assert.equal(report.summary.disagreements, 0, `${file}: diff-free means zero disagreements`);
    totals.transactions += report.summary.transactionsChecked;
    totals.decoded += report.summary.decoded;
    totals.missingBytes += report.summary.missingBytes;
    totals.chainParsed += report.summary.chainParsedInstructions;
    totals.decodeErrors += report.summary.decodeErrors;
    totals.disagreements += report.summary.disagreements;
    totals.noInterface += report.summary.noInterface;
  }
  // Measured 2026-11-04 on these seven fixtures (six from step-ingestooor,
  // one from Solana-Explorer): 7 transactions, 160 payload rows of which 56
  // carry bytes, 48 decoded byte-exactly, 8 with no interface in the store
  // (named, not dropped), 104 chain-parsed rows without bytes.
  assert.equal(totals.transactions, 7, `expected 7 foreign transactions, got ${totals.transactions}`);
  assert.equal(totals.decoded, 48, `expected 48 decoded payloads, got ${totals.decoded}`);
  assert.equal(totals.missingBytes, 104, `expected 104 chain-parsed rows without bytes, got ${totals.missingBytes}`);
  assert.equal(totals.chainParsed, 104, 'the chain-parsed rows must be counted by name');
  assert.equal(totals.noInterface, 8, 'payloads of programs outside the store must be named, not dropped');
  assert.equal(totals.decodeErrors, 0);
  assert.equal(totals.disagreements, 0);
});

test('a chain-parsed instruction carries no bytes and is never decoded as empty', async () => {
  const { report } = await reportFor('orca_initialize_pool_v2.json');
  // The fixture's inner instructions are system/spl-token instructions the
  // chain already parsed: they carry a parsed object and NO data field.
  assert.ok(report.summary.chainParsedInstructions > 0, 'the fixture must contain chain-parsed instructions');
  assert.equal(report.summary.missingBytes, report.summary.chainParsedInstructions,
    'every chain-parsed row must be counted as a row without bytes');
  assert.equal(report.summary.payloadsChecked, 8, 'only the rows that carry bytes enter the decode denominator');
});

test('a foreign document whose instruction index cannot resolve is refused by name', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-foreign-broken-'));
  try {
    const doc = JSON.parse(await readFile(path.join(FOREIGN_DIR, 'orca_initialize_pool_v2.json'), 'utf8'));
    // Break the account list: the instruction still names its program by
    // index, but the document no longer carries enough keys to resolve it.
    doc.transaction.message.accountKeys = doc.transaction.message.accountKeys.slice(0, 1);
    doc.transaction.message.instructions = doc.transaction.message.instructions.map((ix) => ({
      programIdIndex: 7,
      accounts: ix.accounts,
      data: ix.data,
    }));
    const file = path.join(tmp, 'unresolvable.json');
    await writeFile(file, JSON.stringify(doc));
    const outcome = await runTool(['--store', TRAFFIC_STORE, '--rpc-response', file]).then(
      () => 'unexpected-pass',
      (error) => `exit-${error.code}`,
    );
    assert.notEqual(outcome, 'unexpected-pass', 'an unresolvable index must not decode');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('the base64 wire path still decodes the whole block diff-free (the change did not break it)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-foreign-wire-'));
  try {
    const reportPath = path.join(tmp, 'report.json');
    await runTool(['--store', TRAFFIC_STORE, '--rpc-response', WIRE_BLOCK, '--absent', 'verified', '--out', reportPath]);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'pass');
    assert.equal(report.summary.rpcEncoding, 'base64', 'the wire encoding must still be recognized');
    assert.equal(report.summary.payloadsChecked, 4425, `expected the measured 4,425 payloads, got ${report.summary.payloadsChecked}`);
    assert.equal(report.summary.disagreements, 0);
    assert.equal(report.summary.decodeErrors, 0);
    assert.equal(report.networkAttempts, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a mutated byte in a foreign fixture does not silently pass', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-foreign-mutated-'));
  try {
    const doc = JSON.parse(await readFile(path.join(FOREIGN_DIR, 'orca_initialize_pool_v2.json'), 'utf8'));
    const ix = doc.transaction.message.instructions.find((i) => i.programId === 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
    const bytes = Buffer.from(ix.data, 'base64');
    // Flip the DISCRIMINATOR byte: the payload no longer names a known
    // instruction, so the decoder refuses it by name and the run must FAIL.
    // (Measured limit, stated here rather than hidden: a structurally-valid
    // argument mutation passes this check BY DESIGN — decode + re-encode
    // proves the bytes are structurally what the decoder claims, not that
    // the chain executed that value. The json encoding carries no signature
    // over these bytes; the base64 wire path's ed25519 check is what covers
    // value-level tampering, and it cannot apply to a document that holds no
    // message bytes.)
    bytes[0] ^= 0xff;
    ix.data = bytes.toString('base64');
    const file = path.join(tmp, 'mutated.json');
    await writeFile(file, JSON.stringify(doc));
    const reportPath = path.join(tmp, 'report.json');
    const outcome = await runTool(['--store', TRAFFIC_STORE, '--rpc-response', file, '--out', reportPath]).then(
      () => 'unexpected-pass',
      (error) => (error.code === 1 ? 'failed-as-expected' : `unexpected-exit-${error.code}`),
    );
    assert.equal(outcome, 'failed-as-expected', 'a structurally damaged payload must fail the run');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'fail', 'a damaged payload must fail the report');
    assert.ok(report.summary.decodeErrors + report.summary.disagreements > 0,
      'the mutation must show up as a decode error or a disagreement, never a pass');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
