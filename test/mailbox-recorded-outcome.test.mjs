// A row the journal has RECORDED as lost is not debt, and it must not be
// reported as debt.
//
// The claim under test
// --------------------
// reeflog's rows carry the difference explicitly. `payload_state` /
// `account_state` are NULL while a row is still OWED ("hydrate will fill it
// later") and name an OUTCOME once it can never be filled:
//
//   'unavailable'  — the chain no longer knows the transaction
//   'invalid'      — the endpoint refuses the key
//   'no_metadata'  — the response carried no usable account metadata
//
// journal.rs says so in the field's own doc comment: "None while still
// pending — unknown, not empty." reeflog's own surfaces act on it: `status`
// refuses to alarm on a recorded outcome ("Alarming on them would alarm
// forever") and `tail --with-accounts` SKIPS and consumes such a row instead
// of holding the delivery at it.
//
// The shipped reader (src/mailbox.mjs, the `sememe/mailbox` subpath a
// consumer imports) had no vocabulary for this. Every row without a complete
// envelope landed in ONE counter, `rowsWithoutEnvelope`, whose documented
// meaning is debt `hydrate --accounts` closes:
//
//   "rowsWithoutEnvelope: rows the journal has not enriched (or enriched with
//    an older binary). Reported, never hidden — `hydrate --accounts` with the
//    current binary is what closes it."
//
// So a transaction the chain has permanently forgotten was reported as an
// open repair task, and the harvest tool named a repair that can never
// succeed ("no enriched rows in the journal — run `reeflog start` and
// `reeflog hydrate --accounts` first"). This is the permanent-false-alarm
// class reeflog already closed on its own surfaces, crossing the package
// boundary back in.
//
// The contract these tests pin:
//   * a row with a RECORDED outcome is never counted as owed debt — it gets
//     its own counter, with the outcome named per row;
//   * a row that is still OWED (state NULL) stays in `rowsWithoutEnvelope`:
//     the fix must not turn repairable debt into silence;
//   * the live payload is untouched: the owed/recorded rows must not
//     swallow a transaction that CAN be harvested;
//   * the tool names the recorded outcome, not a repair that cannot succeed.
//
// Written RED-first: every D-case fails on the pre-fix tree.

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

/// A row in the shape reeflog's `tail` prints. `payloadState` / `accountState`
/// are the journal's own vocabulary: null = still owed, a name = recorded.
function row(signature, slot, { payloadState = null, accountState = null, withEnvelope = true, logs = true } = {}) {
  return JSON.stringify({
    signature, slot, err: null, source: 'ws', first_seen: 1700000000000,
    seal: 'finalized',
    logs: logs ? ['Program log: hi'] : null,
    payload_state: payloadState,
    accounts: withEnvelope ? {
      program_id: WHIRLPOOL,
      err: null,
      instructions: [
        { inner: false, outer: 0, program_id: WHIRLPOOL, accounts: [], data: DATA_A },
      ],
    } : null,
    account_state: accountState,
  });
}

function harvest(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-outcome-'));
  const db = path.join(dir, 'j.db');
  fs.writeFileSync(db, 'placeholder');
  const bin = fakeReeflog(dir, rows);
  const out = path.join(dir, 'harvest.json');
  const stdout = execFileSync(process.execPath, [
    TOOL, '--db', db, '--out', out, '--reeflog-bin', bin,
  ], { encoding: 'utf8' });
  return { doc: JSON.parse(fs.readFileSync(out, 'utf8')), report: JSON.parse(stdout), dir };
}

function harvestFailure(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-outcome-'));
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

// D3 (the live payload survives alongside recorded rows) is pinned as G5: it
// passes on the pre-fix tree too, so it is a guard, not a defect face.

test('D1: a recorded outcome is not owed debt — it gets its own counter', () => {
  const { doc } = harvest([
    row('LIVESIG', 100),
    row('OWEDSIG', 101, { withEnvelope: false }),
    row('LOSTSIG', 102, { payloadState: 'unavailable', withEnvelope: false, logs: false }),
    row('ENVSIG', 103, { accountState: 'no_metadata', withEnvelope: false }),
    row('INVALIDSIG', 104, { payloadState: 'invalid', withEnvelope: false, logs: false }),
  ]);

  assert.equal(doc.counts.rowsWithoutEnvelope, 1,
    'only the row that is still OWED may count as envelope debt');
  assert.equal(doc.counts.rowsRecordedOutcome, 3,
    'the three recorded outcomes must be counted on their own');
  assert.equal(doc.counts.payloads, 1,
    'the live row still yields its payload');
});

test('D2: each recorded row is NAMED with the outcome the journal recorded', () => {
  const { doc } = harvest([
    row('LIVESIG', 100),
    row('LOSTSIG', 102, { payloadState: 'unavailable', withEnvelope: false, logs: false }),
    row('ENVSIG', 103, { accountState: 'no_metadata', withEnvelope: false }),
    row('INVALIDSIG', 104, { payloadState: 'invalid', withEnvelope: false, logs: false }),
  ]);

  assert.ok(Array.isArray(doc.counts.recordedOutcomes),
    'the document must carry the recorded outcomes');
  const bySignature = Object.fromEntries(
    doc.counts.recordedOutcomes.map((o) => [o.signature, o]),
  );
  assert.equal(bySignature.LOSTSIG.payloadState, 'unavailable', 'the payload outcome is named');
  assert.equal(bySignature.ENVSIG.accountState, 'no_metadata', 'the account outcome is named');
  assert.equal(bySignature.INVALIDSIG.payloadState, 'invalid', 'the invalid key is named');
  for (const outcome of doc.counts.recordedOutcomes) {
    assert.ok(outcome.payloadState || outcome.accountState,
      `every recorded outcome must name what the journal recorded: ${JSON.stringify(outcome)}`);
  }
});

test('D4: a journal of only recorded outcomes names the outcome, not an impossible repair', () => {
  // The advice face: nothing can be harvested, so the tool must say WHAT is
  // wrong. Naming `hydrate` here promises a fill that can never arrive — the
  // permanent false alarm.
  const { code, stderr } = harvestFailure([
    row('LOSTSIG', 102, { payloadState: 'unavailable', withEnvelope: false, logs: false }),
    row('INVALIDSIG', 104, { payloadState: 'invalid', withEnvelope: false, logs: false }),
  ]);

  assert.notEqual(code, 0, 'a harvest with nothing to harvest must not succeed');
  assert.ok(!/hydrate/.test(stderr),
    `the tool must not name a repair that cannot succeed: ${stderr}`);
  assert.ok(/unavailable|invalid|recorded/i.test(stderr),
    `the tool must name the recorded outcome: ${stderr}`);
});

// --- G: guards (green on BOTH trees) -------------------------------------

test('G1: a row that is still OWED keeps counting as debt', () => {
  const { doc } = harvest([
    row('LIVESIG', 100),
    row('OWEDSIG', 101, { withEnvelope: false }),
  ]);

  assert.equal(doc.counts.rowsWithoutEnvelope, 1,
    'repairable debt must stay visible — the fix may not turn debt into silence');
  assert.equal(doc.counts.rowsRecordedOutcome ?? 0, 0, 'and it is not a recorded outcome');
});

test('G2: a complete envelope is never debt', () => {
  const { doc } = harvest([row('LIVESIG', 100)]);

  assert.equal(doc.counts.rowsWithoutEnvelope, 0);
  assert.equal(doc.counts.rowsWithoutInstructions, 0);
  assert.equal(doc.counts.rowsRecordedOutcome ?? 0, 0);
  assert.equal(doc.counts.payloads, 1);
});

test('G3: an envelope without instructions is its own bucket, not a recorded outcome', () => {
  const { doc } = harvest([
    row('LIVESIG', 100),
    JSON.stringify({
      signature: 'NOINSTR', slot: 200, err: null, source: 'ws', seal: 'finalized',
      logs: ['Program log: hi'], payload_state: 'held',
      accounts: { program_id: WHIRLPOOL }, account_state: null,
    }),
  ]);

  assert.equal(doc.counts.rowsWithoutInstructions, 1);
  assert.equal(doc.counts.rowsWithoutEnvelope, 0);
  assert.equal(doc.counts.rowsRecordedOutcome ?? 0, 0);
});

test('G4: the tool still never touches the network', () => {
  const { report } = harvest([row('LIVESIG', 100)]);

  assert.equal(report.networkAttempts, 0, 'the harvest never reached for the network');
});

test('G5: recorded rows must not swallow a harvestable transaction', () => {
  const { doc } = harvest([
    row('LIVESIG', 100),
    row('OWEDSIG', 101, { withEnvelope: false }),
    row('LOSTSIG', 102, { payloadState: 'unavailable', withEnvelope: false, logs: false }),
  ]);

  assert.equal(doc.counts.payloads, 1, 'the harvestable row still yields its payload');
  assert.equal(doc.counts.pinnedSignatures, 1, 'and is still pinned');
  assert.deepEqual(doc.signatures.map((s) => s.signature), ['LIVESIG']);
});
