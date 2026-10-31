// Reeflog-mailbox harvest contract — byte equivalence with the network
// harvester, enforced by tests over a built envelope, not assumed.
//
// `tools/harvest-reeflog.mjs` claims: the document it writes has the same
// shape as `harvest.mjs` output, and `payloadsFromEnvelope(envelope, p)`
// yields records identical in shape AND key order to what
// `extractPayloads(rawTx, p)` yields for the same transaction. That claim is
// only worth what its tests prove:
//
//   1. key order (callers compare payloads with JSON.stringify)
//   2. depth-0 and CPI rows land in the same order as the RPC path
//   3. reeflog's inner flags (`inner: true`, `outer` = parent index,
//      `inner_index` = position in the group) map to the RPC path's
//      `ix` = group.index and `innerIndex` = position-in-group — the map
//      that is easy to get backwards, pinned here in both directions
//   4. foreign programs are skipped, never mixed in
//   5. rows without an envelope and envelopes without instructions are debt
//      in DIFFERENT counters, and a journal with zero enriched rows makes
//      the tool exit non-zero instead of writing a zero-payload "success"
//   6. the zero-RPC guard: the tool installs it via import order, a fetch
//      under the guard throws and is counted, and the tool fails loudly if
//      it ever attempted a network call
//
// No network here: the CLI tests drive the real tool against a fake
// `reeflog` binary that replays fixed journal rows (the live byte
// equivalence against real mainnet lives in tools/e2e-reeflog-harvest.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPayloads, payloadsFromEnvelope, toHex } from '../tools/lib/payloads.mjs';
import { guard, unguard } from '../tools/lib/network-guard.mjs';

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const OTHER = '11111111111111111111111111111111';
const DATA_A = '3Bxs4BPskWMDufRZfDnNUs';
const DATA_B = '2qFook';
const DATA_X = '41iY';
const DATA_Y = '5YvL';

test('payloadsFromEnvelope matches extractPayloads byte-for-byte, key order included', () => {
  // reeflog envelope: outer 0 = target (DATA_A), outer 1 = foreign (DATA_X),
  // outer 1 spawns two CPIs: target at group position 0 (DATA_B), foreign at
  // position 1 (DATA_Y).
  const envelope = {
    program_id: WHIRLPOOL,
    err: null,
    instructions: [
      { inner: false, outer: 0, program_id: WHIRLPOOL, accounts: [], data: DATA_A },
      { inner: false, outer: 1, program_id: OTHER, accounts: [], data: DATA_X },
      { inner: true, outer: 1, inner_index: 0, program_id: WHIRLPOOL, accounts: [], data: DATA_B },
      { inner: true, outer: 1, inner_index: 1, program_id: OTHER, accounts: [], data: DATA_Y },
    ],
  };
  // The same transaction as the RPC path sees it.
  const rawTx = {
    transaction: {
      message: {
        accountKeys: [OTHER, WHIRLPOOL],
        instructions: [
          { programIdIndex: 1, accounts: [], data: DATA_A },
          { programIdIndex: 0, accounts: [], data: DATA_X },
        ],
      },
    },
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 1,
          instructions: [
            { programIdIndex: 1, accounts: [], data: DATA_B },
            { programIdIndex: 0, accounts: [], data: DATA_Y },
          ],
        },
      ],
    },
  };
  const fromEnvelope = payloadsFromEnvelope(envelope, WHIRLPOOL);
  const fromRpc = extractPayloads(rawTx, WHIRLPOOL);
  assert.equal(JSON.stringify(fromEnvelope), JSON.stringify(fromRpc),
    'same records, same order, same key order');
  assert.deepEqual(fromEnvelope, [
    { ix: 0, depth: 0, dataBase58: DATA_A, dataHex: toHex(DATA_A) },
    { ix: 1, depth: 1, innerIndex: 0, dataBase58: DATA_B, dataHex: toHex(DATA_B) },
  ]);

  // The foreign program gets exactly its own rows, no cross-talk.
  assert.deepEqual(payloadsFromEnvelope(envelope, OTHER), extractPayloads(rawTx, OTHER));
  assert.deepEqual(payloadsFromEnvelope(envelope, OTHER), [
    { ix: 1, depth: 0, dataBase58: DATA_X, dataHex: toHex(DATA_X) },
    { ix: 1, depth: 1, innerIndex: 1, dataBase58: DATA_Y, dataHex: toHex(DATA_Y) },
  ]);
});

test('degenerate envelopes yield fewer payloads, never wrong or guessed ones', () => {
  assert.deepEqual(payloadsFromEnvelope(null, WHIRLPOOL), []);
  assert.deepEqual(payloadsFromEnvelope({}, WHIRLPOOL), []);
  assert.deepEqual(payloadsFromEnvelope({ instructions: [] }, WHIRLPOOL), []);
  assert.deepEqual(payloadsFromEnvelope({ instructions: 'nope' }, WHIRLPOOL), []);
  // Malformed members are skipped; a numeric program_id can never match.
  assert.deepEqual(payloadsFromEnvelope({
    instructions: [
      null,
      { inner: false, outer: 0, program_id: 42, data: DATA_A },
      { inner: false, outer: 0, program_id: WHIRLPOOL, data: 7 },
    ],
  }, WHIRLPOOL), [{ ix: 0, depth: 0, dataBase58: '', dataHex: '' }]);
});

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'harvest-reeflog.mjs');

function fakeReeflog(dir, lines) {
  const bin = path.join(dir, 'reeflog-fake');
  fs.writeFileSync(bin, `#!/bin/sh\nexec cat <<'REEFLOG_FAKE_EOF'\n${lines.join('\n')}\nREEFLOG_FAKE_EOF\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function enrichedRow(signature, slot) {
  return JSON.stringify({
    signature, slot,
    accounts: {
      program_id: WHIRLPOOL,
      err: null,
      instructions: [
        { inner: false, outer: 0, program_id: WHIRLPOOL, accounts: [], data: DATA_A },
        { inner: true, outer: 0, inner_index: 0, program_id: WHIRLPOOL, accounts: [], data: DATA_B },
      ],
    },
  });
}

test('CLI: enriched journal -> harvest document with honest debt counters and zero RPC', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-reeflog-'));
  const db = path.join(dir, 'j.db');
  fs.writeFileSync(db, 'placeholder');
  const bin = fakeReeflog(dir, [
    enrichedRow('SIG1', 100),
    JSON.stringify({ signature: 'SIG2', slot: 101, accounts: null }),
    JSON.stringify({ signature: 'SIG3', slot: 102, accounts: { program_id: WHIRLPOOL } }),
  ]);
  const out = path.join(dir, 'harvest.json');
  const stdout = execFileSync(process.execPath, [
    TOOL, '--db', db, '--out', out, '--reeflog-bin', bin,
  ], { encoding: 'utf8' });
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  const report = JSON.parse(stdout);

  assert.equal(report.networkAttempts, 0, 'the tool never reached for the network');
  assert.equal(doc.rpc, 'none (local reeflog journal)');
  assert.match(doc.method, /reeflog tail --cursor/);

  // Only the enriched row becomes a transaction; the other two are debt.
  assert.equal(doc.counts.journalRows, 3);
  assert.equal(doc.counts.fetched, 1);
  assert.equal(doc.counts.payloads, 2);
  assert.equal(doc.counts.rowsWithoutEnvelope, 1);
  assert.equal(doc.counts.rowsWithoutInstructions, 1);
  assert.equal(doc.counts.transactionsWithTargetPayloads, 1);
  assert.equal(doc.counts.failedOnChain, 0);
  assert.equal(doc.transactions[0].signature, 'SIG1');
  assert.equal(doc.transactions[0].slot, 100);
  assert.equal(doc.transactions[0].position, null);
  assert.deepEqual(doc.transactions[0].payloads, [
    { ix: 0, depth: 0, dataBase58: DATA_A, dataHex: toHex(DATA_A) },
    { ix: 0, depth: 1, innerIndex: 0, dataBase58: DATA_B, dataHex: toHex(DATA_B) },
  ]);
  assert.ok(doc.signatures.length === 1 && doc.signatures[0].signature === 'SIG1');
  assert.equal(doc.slotRange.oldest, 100);
  assert.equal(doc.slotRange.newest, 100);
});

test('CLI: a journal with zero enriched rows exits 1 and writes no document', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-reeflog-'));
  const db = path.join(dir, 'j.db');
  fs.writeFileSync(db, 'placeholder');
  const bin = fakeReeflog(dir, [
    JSON.stringify({ signature: 'SIG1', slot: 5, accounts: null }),
  ]);
  const out = path.join(dir, 'harvest.json');
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, [TOOL, '--db', db, '--out', out, '--reeflog-bin', bin], { encoding: 'utf8' });
  } catch (error) {
    code = error.status;
    stderr = error.stderr;
  }
  assert.equal(code, 1, 'a zero-yield harvest must not look successful');
  assert.match(stderr, /no enriched rows/);
  assert.equal(fs.existsSync(out), false, 'no success document is written');
});

test('CLI: usage errors exit 2', () => {
  for (const args of [[], ['--db', '/dev/null']]) {
    let code = 0;
    try {
      execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
    } catch (error) { code = error.status; }
    assert.equal(code, 2);
  }
});

test('the zero-RPC guard rejects fetch loudly and counts the attempt', async () => {
  // The mechanism the tool relies on, exercised directly: a fetch under the
  // guard must reject (not silently pass) and must be recorded, so a failing
  // run shows exactly which path reached for the network. Without this test,
  // "zero RPC" would be an assertion about a guard nobody ever fired.
  const before = guard.attempts.length;
  await assert.rejects(
    () => globalThis.fetch('https://api.mainnet-beta.solana.com'),
    /zero-RPC guard/,
  );
  assert.equal(guard.attempts.length, before + 1, 'the attempt is counted');
  assert.match(guard.attempts.at(-1), /mainnet-beta/);
  // Restore the real fetch so later tests in this process see the network.
  unguard();
  assert.equal(typeof globalThis.fetch, 'function');
});

test('the tool installs the zero-RPC guard before anything else can fetch', () => {
  // The guard only protects what runs after it is installed; the tool's
  // claim "zero RPC, enforced" depends on the import-order rule its header
  // documents. Pin the order so a future re-order cannot silently disarm it.
  const source = fs.readFileSync(TOOL, 'utf8');
  const guardImport = source.indexOf("from './lib/network-guard.mjs'");
  assert.ok(guardImport > 0, 'tool imports the guard');
  for (const other of ["from 'node:child_process'", "from './lib/payloads.mjs'", "from './lib/slot-range.mjs'"]) {
    const at = source.indexOf(other);
    assert.ok(at > 0, `tool imports ${other}`);
    assert.ok(guardImport < at, 'the guard import comes first');
  }
});
