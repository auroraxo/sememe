// The published package must be able to consume a reeflog mailbox.
//
// DEFECT (measured 2026-11-17 on the npm channel a stranger installs):
// `sememe@0.4.33` ships ZERO reeflog capability.
//
//   node -e "import('sememe/mailbox')"
//     -> ERR_PACKAGE_PATH_NOT_EXPORTED (./mailbox not in the exports map)
//   import('sememe') → no export whose name mentions mailbox/reeflog/harvest
//   find node_modules/sememe -name '*.mjs' → no file reads a mailbox row
//
// The reader that honours reeflog's retraction contract exists ONLY in
// `tools/harvest-reeflog.mjs`, and `package.json`'s `files` allowlist
// deliberately excludes `tools/`. So the contract that took two pulses to
// close on this side — "a row the chain unmade is never a payload source" —
// is unreachable from the channel consumers actually install.
//
// Meanwhile the integration itself WORKS: measured 2026-11-17 with
// `reeflog-client@0.7.32` + `sememe@0.4.33` both installed from npm into an
// empty app, against a real 2,417-event mainnet-beta journal: 63 events
// delivered, 1,307 instructions, 71 of them for the pinned program, 71/71
// decoded and 71/71 byte-exact round trip. Every line of that ran from
// `tools/` in a checkout. Nothing shipped.
//
// These tests pin the SHIPPED surface:
//   D1  `sememe/mailbox` resolves through the exports map
//   D2  the module reaches the consumer's node_modules (the file ships)
//   D3  a seal-retracted row is never a payload source, on the shipped module
//   D4  a channel-retracted row (row still says `finalized`) is never a
//       payload source either — the seal is a snapshot; the channel is not
//   D5  the retraction is NAMED, not dropped, and the reader states it read
//       the channel (a document that claims a retraction was honoured without
//       asking the channel is the same defect in a second shape)
//   G1  guard: an ordinary enriched row still yields its payloads
//   G2  guard: a row whose envelope exists but carries no instructions is
//       DEBT, not a silent drop, and a foreign program yields none
//
// Every D-face is RED on the pre-fix tree — not because the logic is wrong
// there, but because the surface does not exist at all: the module cannot be
// imported, so the behaviour cannot be reached by a consumer. That IS the
// defect. G1/G2 are GREEN on both trees whenever the module exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const OTHER = '11111111111111111111111111111111';
const DATA_A = '3Bvo8NsR';
const DATA_X = '41iY';

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

/** An enriched row the way `reeflog tail` prints it. `seal` is `undefined`
 *  unless the caller passes one, so `row()` is the shape WITHOUT a seal and
 *  `row(sig, slot, 'reverted')` the shape reeflog actually prints. */
function row(signature, slot, seal) {
  const r = {
    signature, slot, err: null, source: 'ws', first_seen: 1700000000000,
    accounts: {
      program_id: WHIRLPOOL,
      err: null,
      instructions: [
        { inner: false, outer: 0, program_id: WHIRLPOOL, accounts: [], data: DATA_A },
      ],
    },
    account_state: null,
    logs: ['Program log: hi'],
    payload_state: null,
  };
  if (seal !== undefined) r.seal = seal;
  return r;
}

/** A `reeflog reorg tail` record: the retraction itself. */
function reorg(reorgId, signature, slot = 100) {
  return { reorg_id: reorgId, signature, slot, detected_at: 1700000000000, status_source: 'status', tx_source: 'tx', detail: 'both sources refused' };
}

async function loadShipped() {
  const target = pkg.exports?.['./mailbox'];
  assert.ok(target, `package.json exports must declare "./mailbox" (found ${JSON.stringify(pkg.exports?.['./mailbox'])})`);
  await stat(path.join(ROOT, target));
  return import(pathToFileURL(path.join(ROOT, target)).href);
}

test('D1/D2: sememe/mailbox resolves through the exports map and ships', async () => {
  const mod = await loadShipped();
  assert.equal(typeof mod.mailboxTransactions, 'function', 'the shipped module must export mailboxTransactions');
  assert.equal(typeof mod.payloadsFromEnvelope, 'function', 'the shipped module must export payloadsFromEnvelope');
});

test('D3: a seal-retracted row is never a payload source', async () => {
  const { mailboxTransactions } = await loadShipped();
  const { transactions, counts } = mailboxTransactions({
    rows: [row('SIG_GOOD', 100), row('SIG_REVERTED', 101, 'reverted')],
    retractions: [],
    program: WHIRLPOOL,
  });
  assert.deepEqual(transactions.map((t) => t.signature), ['SIG_GOOD'],
    'a row the chain unmade must not become a payload source');
  assert.equal(counts.rowsReverted, 1, 'the retracted row must be counted, not dropped');
  assert.deepEqual(counts.revertedSignatures, ['SIG_REVERTED'], 'the signature must be named');
});

test('D4: a channel-retracted row is never a payload source, whatever the seal says', async () => {
  const { mailboxTransactions } = await loadShipped();
  const late = row('SIG_LATE', 102, 'finalized'); // seal is a snapshot taken at read time
  const { transactions, counts } = mailboxTransactions({
    rows: [row('SIG_GOOD', 100), late],
    retractions: [reorg(7, 'SIG_LATE')],
    program: WHIRLPOOL,
  });
  assert.deepEqual(transactions.map((t) => t.signature), ['SIG_GOOD'],
    'the retraction channel exists because the seal cannot see a later retraction');
  assert.equal(counts.rowsReverted, 1);
  assert.deepEqual(counts.reorgOnlySignatures, ['SIG_LATE'],
    'the reader must distinguish "the row said so" from "the channel said so"');
  assert.equal(counts.reorgRetractions, 1, "the channel's own delivery must be counted");
});

test('D5: the reader states that it read the retraction channel', async () => {
  const { mailboxTransactions } = await loadShipped();
  const { counts } = mailboxTransactions({
    rows: [row('SIG_GOOD', 100)],
    retractions: [],
    program: WHIRLPOOL,
    channelRead: true,
  });
  assert.equal(counts.channelRead, true,
    'a reader that never asked the channel must say so instead of claiming it honoured one');
  const silent = mailboxTransactions({ rows: [row('SIG_GOOD', 100)], retractions: [], program: WHIRLPOOL });
  assert.notEqual(silent.counts.channelRead, true, 'omitting the argument must not fabricate a read');
});

test('G1: an ordinary enriched row still yields its payloads', async () => {
  const { mailboxTransactions } = await loadShipped();
  const { transactions, counts } = mailboxTransactions({
    rows: [row('SIG_GOOD', 100)],
    retractions: [],
    program: WHIRLPOOL,
    channelRead: true,
  });
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].signature, 'SIG_GOOD');
  assert.equal(transactions[0].slot, 100);
  assert.ok(Array.isArray(transactions[0].payloads) && transactions[0].payloads.length === 1,
    'the enriched row must yield exactly its own target payload');
  assert.equal(transactions[0].payloads[0].dataBase58, DATA_A);
  assert.equal(counts.payloads, 1);
  assert.equal(counts.rowsReverted, 0);
  assert.equal(counts.reorgRetractions, 0);
});

test('G2: missing envelope is debt, an envelope without instructions is debt, a foreign program yields none', async () => {
  const { mailboxTransactions } = await loadShipped();
  const noEnvelope = { signature: 'SIG_NOENV', slot: 101, accounts: null };
  const noIxs = { signature: 'SIG_NOIX', slot: 102, accounts: { program_id: WHIRLPOOL } };
  const { transactions, counts } = mailboxTransactions({
    rows: [row('SIG_GOOD', 100), noEnvelope, noIxs],
    retractions: [],
    program: WHIRLPOOL,
    channelRead: true,
  });
  assert.equal(transactions.length, 1, 'only the enriched row yields payloads');
  assert.equal(counts.rowsWithoutEnvelope, 1, 'a row the mailbox has not enriched is debt, named');
  assert.equal(counts.rowsWithoutInstructions, 1, 'an envelope that cannot yield payloads is debt, named');

  const foreign = mailboxTransactions({ rows: [row('SIG_GOOD', 100)], retractions: [], program: OTHER });
  assert.equal(foreign.transactions.length, 1, 'a transaction with no target instruction stays in the denominator');
  assert.equal(foreign.counts.payloads, 0, 'the foreign program yields no payloads');
  assert.equal(foreign.counts.transactionsWithoutTarget, 1, 'and that shortfall is counted');
});

test('G2b: degenerate inputs never throw and never invent payloads', async () => {
  const { mailboxTransactions, payloadsFromEnvelope } = await loadShipped();
  assert.deepEqual(payloadsFromEnvelope(null, WHIRLPOOL), []);
  assert.deepEqual(payloadsFromEnvelope({}, WHIRLPOOL), []);
  assert.deepEqual(payloadsFromEnvelope({ instructions: 'nope' }, WHIRLPOOL), []);
  const empty = mailboxTransactions({ rows: [], retractions: [], program: WHIRLPOOL });
  assert.deepEqual(empty.transactions, []);
  assert.equal(empty.counts.payloads, 0);
  // A malformed member is skipped, never guessed into a byte.
  assert.deepEqual(payloadsFromEnvelope({
    instructions: [
      null,
      { inner: false, outer: 0, program_id: 42, data: DATA_A },
      { inner: false, outer: 0, program_id: WHIRLPOOL, data: 7 },
    ],
  }, WHIRLPOOL), [{ ix: 0, depth: 0, dataBase58: '', dataHex: '' }]);
});
