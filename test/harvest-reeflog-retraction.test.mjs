// A mailbox row the chain UNMADE must not become a payload source.
//
// reeflog keeps its side of this promise already (measured 2026-11-16 on the
// reeflog main tree, its own release binary): `tail` prints the row's CURRENT
// seal on every row — including `"seal":"reverted"` — and `reorg tail` carries
// the retraction itself on its own cursor. Its README states the boundary:
// "it marks and delivers the retraction instead".
//
// The reader did not honor it. Measured on the real tool against a real reeflog
// journal holding one finalized and one reverted event (both with full account
// envelopes):
//
//   counts.pinnedSignatures = 2
//   signatures[]            = [ValidSig…, RevertedSig…]
//   "seal" in the document  = false      (the field never reaches the document)
//   "reverted" in the document = false   (no retraction marker of any kind)
//
// So the one thing the mailbox owner does to keep a consumer from acting on a
// fill the chain no longer knows was dropped between `tail` and the document —
// this is precisely the "retracted claim" reeflog issue #1 was filed against,
// and it is the reader's half of that contract.
//
// The contract these tests pin:
//   * a row whose seal is `reverted` is NEVER a transaction, signature, or
//     payload — its bytes describe an event that does not exist on chain;
//   * the row is NAMED, not silently dropped: `counts.rowsReverted` plus the
//     signatures in `revertedSignatures`, so the debt is visible the same way
//     `rowsWithoutEnvelope` is;
//   * every other seal (`finalized`, `confirmed`, `error`, `missing`, null,
//     absent) still harvests — an event that is merely not final yet is a real
//     event, and reading `reverted` where the row says nothing would be the
//     same lie in the other direction;
//   * a journal whose rows are ALL retracted yields no success document.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const DATA_A = '3Bvo8NsR';
const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'harvest-reeflog.mjs');

function fakeReeflog(dir, lines) {
  const bin = path.join(dir, 'reeflog-fake');
  fs.writeFileSync(bin, `#!/bin/sh\nexec cat <<'REEFLOG_FAKE_EOF'\n${lines.join('\n')}\nREEFLOG_FAKE_EOF\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/// One enriched row: `seal` is `undefined` unless the caller passes one, so
/// `sealRow(sig, slot)` is the pre-fix shape (no seal field at all) and
/// `sealRow(sig, slot, seal)` the shape reeflog actually prints.
function sealRow(signature, slot, seal) {
  const row = {
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
  if (seal !== undefined) row.seal = seal;
  return JSON.stringify(row);
}

function harvest(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-retract-'));
  const db = path.join(dir, 'j.db');
  fs.writeFileSync(db, 'placeholder');
  const bin = fakeReeflog(dir, rows);
  const out = path.join(dir, 'harvest.json');
  const stdout = execFileSync(process.execPath, [
    TOOL, '--db', db, '--out', out, '--reeflog-bin', bin,
  ], { encoding: 'utf8' });
  return {
    doc: JSON.parse(fs.readFileSync(out, 'utf8')),
    report: JSON.parse(stdout),
    out,
    dir,
  };
}

function harvestFailure(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-retract-'));
  const db = path.join(dir, 'j.db');
  fs.writeFileSync(db, 'placeholder');
  const bin = fakeReeflog(dir, rows);
  const out = path.join(dir, 'harvest.json');
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, [TOOL, '--db', db, '--out', out, '--reeflog-bin', bin], { encoding: 'utf8' });
  } catch (error) {
    code = error.status;
    stderr = String(error.stderr);
  }
  return { code, stderr, out, dir };
}

// --- D: the defect -------------------------------------------------------

test('D1: a reverted row is not a transaction and is named in the document', () => {
  const { doc } = harvest([
    sealRow('VALIDSIG', 100, 'finalized'),
    sealRow('REVERTEDSIG', 101, 'reverted'),
  ]);

  assert.equal(doc.counts.journalRows, 2, 'the denominator still counts every row');
  assert.equal(doc.counts.rowsReverted, 1, 'the retracted row is counted as its own debt');
  assert.deepEqual(doc.counts.revertedSignatures, ['REVERTEDSIG'], 'named, not silently dropped');
  assert.ok(
    !doc.transactions.some((t) => t.signature === 'REVERTEDSIG'),
    `a chain-unmade event must not be a payload source; got ${JSON.stringify(doc.transactions.map((t) => t.signature))}`,
  );
  assert.ok(
    !doc.signatures.some((s) => s.signature === 'REVERTEDSIG'),
    'the pinned signature list must not carry a retracted signature',
  );
  assert.equal(doc.counts.fetched, 1, 'only the live row is fetched');
  assert.equal(doc.counts.payloads, 1, 'the retracted row contributes no payload');
});

test('D2: the retracted row is not swallowed by the envelope-debt counters', () => {
  // A retraction is not debt `hydrate --accounts` can ever close: the chain no
  // longer knows the transaction. Counting it as `rowsWithoutEnvelope` would
  // promise a fill that can never arrive.
  const { doc } = harvest([
    sealRow('REVERTEDSIG', 101, 'reverted'),
    sealRow('VALIDSIG', 100, 'finalized'),
  ]);
  assert.equal(doc.counts.rowsWithoutEnvelope, 0, 'a retraction is not an open envelope debt');
  assert.equal(doc.counts.rowsWithoutInstructions, 0);
  assert.equal(doc.counts.rowsReverted, 1);
  assert.equal(doc.slotRange.oldest, 100, 'the slot range describes rows that still exist');
  assert.equal(doc.slotRange.newest, 100);
  assert.equal(doc.tipAtHarvest, 100);
});

/// D4 is the defect seen through the debt counters: pre-fix the retracted row
/// was an ordinary transaction, so `fetched` was 2 and the two buckets
/// overlapped nothing — post-fix exactly one row is fetched and each row lands
/// in exactly one bucket.
test('D4: retracted and live rows keep the debt buckets disjoint', () => {
  const { doc } = harvest([
    sealRow('VALIDSIG', 100, 'finalized'),
    sealRow('REVERTEDSIG', 101, 'reverted'),
    JSON.stringify({ signature: 'NOENV', slot: 102, seal: 'confirmed', accounts: null }),
    JSON.stringify({ signature: 'NOINSTR', slot: 103, seal: 'confirmed', accounts: { program_id: WHIRLPOOL } }),
  ]);
  assert.equal(doc.counts.journalRows, 4);
  assert.equal(doc.counts.rowsReverted, 1);
  assert.equal(doc.counts.rowsWithoutEnvelope, 1, 'each row lands in exactly one bucket');
  assert.equal(doc.counts.rowsWithoutInstructions, 1);
  assert.equal(doc.counts.fetched, 1, 'pre-fix this was 2: the retracted row was fetched');
  assert.equal(doc.transactions.length, 1);
  assert.equal(doc.counts.requested, 4, 'the requested denominator is untouched');
});

/// C1 pins the shape of the new reporting: the counters are ALWAYS present, and
/// an empty list is `[]` rather than an absent key — the same discipline the
/// tool already applies to `revertedSignatures`' siblings in the debt counters.
test('C1: the retraction counters are always present, empty list not absent', () => {
  const { doc } = harvest([sealRow('VALIDSIG', 100, 'finalized')]);
  assert.equal(doc.counts.rowsReverted, 0, 'absent retraction must be a counted zero');
  assert.deepEqual(doc.counts.revertedSignatures, [], 'empty list, never an absent key');
  assert.deepEqual(doc.revertedSignatures ?? [], []);
});

test('D3: a reverted row cannot turn a clean journal into a success document', () => {
  const { code, stderr, out } = harvestFailure([sealRow('REVERTEDSIG', 101, 'reverted')]);
  assert.equal(code, 1, 'a harvest of nothing must not look successful');
  assert.match(stderr, /retract/i, 'the refusal must say WHY nothing was harvestable');
  assert.equal(fs.existsSync(out), false, 'no success document is written');
});

// --- G: guards that must stay green on BOTH trees ------------------------

/// Guards below assert only behaviour that holds on BOTH trees: they exist to
/// catch a fix that over-corrects — inventing a revert where the row said
/// nothing, or dropping not-yet-final events along with the retracted one.
/// They deliberately do not reference `rowsReverted`/`revertedSignatures`,
/// because those keys did not exist before the fix.
test('G1: rows without a seal field still harvest (the reader never invents a revert)', () => {
  const { doc } = harvest([
    sealRow('NOSEAL', 100),
    sealRow('NULLSEAL', 101, null),
  ]);
  assert.equal(doc.counts.journalRows, 2);
  assert.equal(doc.transactions.length, 2, 'both rows are still payload sources');
  assert.equal(doc.counts.payloads, 2);
  assert.deepEqual(doc.signatures.map((s) => s.signature).sort(), ['NOSEAL', 'NULLSEAL']);
});

test('G2: every non-reverted seal still harvests', () => {
  const { doc } = harvest([
    sealRow('S_FINALIZED', 100, 'finalized'),
    sealRow('S_CONFIRMED', 101, 'confirmed'),
    sealRow('S_ERROR', 102, 'error'),
    sealRow('S_MISSING', 103, 'missing'),
  ]);
  assert.equal(doc.counts.journalRows, 4);
  assert.equal(doc.transactions.length, 4, 'not-final-yet is a real event');
  assert.equal(doc.counts.payloads, 4);
  assert.equal(doc.signatures.length, 4);
  assert.equal(doc.slotRange.oldest, 100);
  assert.equal(doc.slotRange.newest, 103);
});
