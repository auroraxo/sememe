// Pin test for research/harvest-retraction-2026-11-16.json.
//
// The measurement tool (tools/measure-harvest-retraction.mjs) re-derives the
// artifact from a real reeflog binary: it plants a finalized and a retracted
// row, runs the harvest tool, then removes the seal gate and runs again.
//
// FACE SEMANTICS: for every face, `prefix`/`fixed` record whether that face's
// FAILURE is present in that tree. For P1-P3 (the defect) that means "the
// retracted event leaked / the retraction went unnamed" — true before the fix,
// false after. For P4-P5 (guards) it means "the fix broke something that used
// to work" — false on both trees, and they must stay false.
//
// These assertions pin what the record SAYS. If the artifact starts claiming
// the defect is absent before the fix, or that the retraction is named without
// it being named, these fail. A tampered or stale artifact must not pass.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = path.join(ROOT, 'research', 'harvest-retraction-2026-11-16.json');

const raw = fs.readFileSync(ARTIFACT, 'utf8');
const doc = JSON.parse(raw);
const face = (name) => {
  const f = doc.faces.find((x) => x.face === name);
  assert.ok(f, `face ${name} is missing from the artifact`);
  return f;
};

test('D1: the artifact records the defect before the fix and its absence after', () => {
  const f = face('P1_pinned_signatures_names_the_retracted_event');
  assert.equal(f.prefix, true, 'the pre-fix reader must be shown pinning the retracted signature');
  assert.equal(f.fixed, false, 'the fixed reader must be shown NOT pinning it');
  assert.equal(doc.prefix.pinnedContainsRetracted, true);
  assert.equal(doc.fixed.pinnedContainsRetracted, false);
});

test('D2: a retracted event is not a transaction on the fixed tree', () => {
  const f = face('P2_retracted_row_is_never_a_transaction');
  assert.equal(f.prefix, true);
  assert.equal(f.fixed, false);
  assert.equal(doc.prefix.transactionContainsRetracted, true);
  assert.equal(doc.fixed.transactionContainsRetracted, false);
});

test('D3: the retraction is named only after the fix', () => {
  const f = face('P3_the_retraction_is_named_in_the_document');
  assert.equal(f.prefix, true, 'before the fix the retraction was NOT named (failure present)');
  assert.equal(f.fixed, false, 'after the fix it IS named (failure absent)');
  assert.equal(doc.fixed.rowsReverted, 1, 'exactly one retracted row was reported');
  assert.equal(doc.fixed.revertedSignaturesNamed, true, 'the signature itself is named');
  assert.equal(doc.prefix.revertedSignaturesNamed, false, 'and it was not named before the fix');
});

test('G1: the live row survives on both trees (the fix over-corrects nothing)', () => {
  const f = face('P4_live_rows_are_still_harvested');
  assert.equal(f.prefix, false, 'pre-fix the finalized row was harvested');
  assert.equal(f.fixed, false, 'post-fix it still is');
  assert.ok(doc.prefix._raw.signatures.some((s) => s.signature.startsWith('ValidSig')));
  assert.ok(doc.fixed._raw.signatures.some((s) => s.signature.startsWith('ValidSig')));
});

test('G2: a retraction is not counted as an open envelope debt on either tree', () => {
  const f = face('P5_the_retraction_is_not_an_open_envelope_debt');
  assert.equal(f.prefix, false);
  assert.equal(f.fixed, false);
  assert.equal(doc.prefix.rowsWithoutEnvelope, 0);
  assert.equal(doc.fixed.rowsWithoutEnvelope, 0);
});

test('C1: verdict, denominator, and the zero-RPC promise are all present', () => {
  assert.equal(doc.verdict, 'reader-honours-retraction');
  assert.equal(doc.prefix.exitCode, 0, 'the pre-fix run wrote its document');
  assert.equal(doc.fixed.exitCode, 0);
  assert.equal(doc.prefix.documentWritten, true);
  assert.equal(doc.fixed.documentWritten, true);
  assert.equal(doc.prefix.pinnedSignatures, 2, 'pre-fix: both rows were payload sources');
  assert.equal(doc.fixed.pinnedSignatures, 1, 'post-fix: only the live row');
  assert.match(doc.zeroRpcGuard, /network-guard/);
});

test('H1: no host path leaks into the artifact', () => {
  const home = process.env.HOME;
  if (home) assert.ok(!raw.includes(home), 'the artifact must not carry a host path');
  assert.ok(!raw.includes('/home/'), 'no absolute home directory in the record');
});

test('L1: the recorded limits keep the claim honest', () => {
  assert.ok(Array.isArray(doc.limits) && doc.limits.length >= 3, 'limits are stated');
  assert.ok(
    doc.limits.some((l) => /synthetic/i.test(l)),
    'the probe is synthetic, not an observed mainnet fork — say so',
  );
  assert.ok(
    doc.limits.some((l) => /reorg CHANNEL|reorg tail/i.test(l)),
    'the reorg channel is out of scope for this tool — say so',
  );
});
