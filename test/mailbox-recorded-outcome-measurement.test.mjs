// Pin test for the recorded-outcome measurement artifacts.
//
// The measurement (tools/measure-mailbox-recorded-outcome.mjs) plants a REAL
// journal through the REAL reeflog binary and runs the harvest tool on it:
// a live row, a row that is still OWED, and three rows the journal has
// RECORDED as permanently lost ('unavailable', 'no_metadata', 'invalid').
//
// FACE SEMANTICS:
//   prefix    — the pre-fix tree: the lost rows land in the repairable debt
//               bucket (`rowsWithoutEnvelope`) and the tool names a hydrate
//               repair that can never succeed.
//   fixed     — the fixed tree: owed debt and recorded outcomes are separate
//               buckets, each recorded outcome named.
//   published — `sememe/mailbox` imported from the PUBLISHED npm package:
//               what a stranger installs today.
//
// These assertions pin what the record SAYS. A tampered, stale or
// hand-edited artifact must not pass: the counts, the verdict and the
// advice face are all checked against each other, and the artifact must
// carry no host path.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = path.join(ROOT, 'research', 'mailbox-recorded-outcome-2026-11-19.json');
const PUBLISHED_ARTIFACT = path.join(ROOT, 'research', 'mailbox-recorded-outcome-published-v0439-2026-11-19.json');

const raw = fs.readFileSync(ARTIFACT, 'utf8');
const doc = JSON.parse(raw);

const publishedRaw = fs.readFileSync(PUBLISHED_ARTIFACT, 'utf8');
const publishedDoc = JSON.parse(publishedRaw);

// --- the artifact says what happened --------------------------------------

test('D1: the verdict is the HOLD verdict, on measured numbers', () => {
  assert.equal(doc.verdict, 'mailbox-recorded-outcomes-name-themselves');
  assert.equal(doc.prefix.rowsWithoutEnvelope, 4,
    'before the fix, four rows shared the one repairable bucket');
  assert.equal(doc.prefix.rowsRecordedOutcome, null,
    'before the fix there was no recorded-outcome vocabulary at all');
  assert.equal(doc.fixed.rowsWithoutEnvelope, 1,
    'after the fix only the OWED row is debt');
  assert.equal(doc.fixed.rowsRecordedOutcome, 3,
    'after the fix the three recorded outcomes have their own bucket');
  assert.equal(doc.fixed.payloads, 1, 'the live payload is untouched on both trees');
});

test('D2: every recorded outcome is NAMED in the fixed face', () => {
  const outcomes = doc.fixed.recordedOutcomes;
  assert.equal(Array.isArray(outcomes), true, 'the fixed face must carry the outcomes');
  assert.equal(outcomes.length, 3);
  const named = outcomes.map((o) => o.payloadState ?? o.accountState).sort();
  assert.deepEqual(named, ['invalid', 'no_metadata', 'unavailable'],
    'each outcome the journal recorded must be named');
});

test('D3: the advice face names an outcome, not an impossible repair', () => {
  assert.equal(doc.advicePrefix.namesHydrateRepair, true,
    'before the fix the tool promised a hydrate that can never succeed');
  assert.match(doc.advicePrefix.stderr, /hydrate/);
  assert.equal(doc.adviceFixed.namesHydrateRepair, false,
    'after the fix the tool must not promise a repair that cannot succeed');
  assert.match(doc.adviceFixed.stderr, /RECORDED outcome/,
    'after the fix the tool must name the recorded outcome');
  assert.match(doc.adviceFixed.stderr, /unavailable/,
    'and name WHICH outcome it was');
});

test('D4: the guards are green', () => {
  for (const [name, guard] of Object.entries(doc.guards)) {
    assert.equal(guard.green, true, `guard ${name} must be green`);
  }
});

test('D5: the published channel carries the defect — it is what a stranger installs', () => {
  assert.equal(publishedDoc.published.tag, 'published@0.4.39',
    'the v0439 artifact records what 0.4.39 shipped');
  assert.equal(publishedDoc.published.rowsWithoutEnvelope, 4,
    'the published reader still lumps the lost rows into the debt bucket');
  assert.equal(publishedDoc.published.rowsRecordedOutcome, null,
    'the published reader has no recorded-outcome vocabulary');
  assert.equal(publishedDoc.published.payloads, 1,
    'but the live payload still works — the defect is only in the accounting');
});

test('D6: the measurement used the REAL reeflog binary and REAL rows', () => {
  assert.equal(doc.reeflogRows.length, 5, 'five rows were planted and read back');
  const states = doc.reeflogRows
    .flatMap((r) => [r.payload_state, r.account_state])
    .filter((s) => s && s !== 'held')
    .sort();
  assert.deepEqual(states, ['invalid', 'no_metadata', 'unavailable'],
    'the three recorded outcomes read back through the real binary\'s tail');
  const owed = doc.reeflogRows.find((r) => r.signature.startsWith('Owed'));
  assert.equal(owed.account_state, null, 'the owed row\'s account state is still null — unknown, not empty');
  assert.equal(owed.logs, 'present', 'and its payload is already there');
});

// --- the artifact is not hand-edited --------------------------------------

test('G1: no host path leaked into either artifact', () => {
  const home = os.homedir();
  assert.ok(!raw.includes(home), 'the artifact must not carry a host path');
  assert.ok(!publishedRaw.includes(home), 'the published artifact must not carry a host path');
});

test('G2: the two artifacts agree about the prefix face', () => {
  assert.equal(publishedDoc.prefix.rowsWithoutEnvelope, doc.prefix.rowsWithoutEnvelope);
  assert.equal(publishedDoc.prefix.rowsRecordedOutcome, doc.prefix.rowsRecordedOutcome);
});

test('G3: the published artifact also carries the fixed face', () => {
  assert.equal(publishedDoc.fixed.rowsRecordedOutcome, 3);
  assert.equal(publishedDoc.fixed.rowsWithoutEnvelope, 1);
});
