// Pin test for research/harvest-reorg-channel-2026-11-16.json.
//
// The measurement tool (tools/measure-harvest-reorg-channel.mjs) re-derives
// the artifact from a real reeflog binary: it plants three enriched rows —
// live, seal-retracted, and one whose seal still says `finalized` while the
// retraction channel carries its record — runs the harvest tool, then removes
// the channel read and runs again.
//
// FACE SEMANTICS: for every face, `prefix`/`fixed` record whether that face's
// FAILURE is present in that tree. For P1-P3 (the defect) that means "the
// channel-only retraction leaked / went unnamed" — true before the fix,
// false after. For P4-P6 (guards) it means "the fix broke something that used
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
const ARTIFACT = path.join(ROOT, 'research', 'harvest-reorg-channel-2026-11-16.json');

const raw = fs.readFileSync(ARTIFACT, 'utf8');
const doc = JSON.parse(raw);
const face = (name) => {
  const f = doc.faces.find((x) => x.face === name);
  assert.ok(f, `face ${name} is missing from the artifact`);
  return f;
};

test('D1: the channel-only retraction leaks before the fix and is gone after', () => {
  const f = face('P1_the_channel_only_retraction_is_not_pinned');
  assert.equal(f.prefix, true, 'the pre-channel reader must be shown pinning the late-retracted signature');
  assert.equal(f.fixed, false, 'the fixed reader must be shown NOT pinning it');
  assert.equal(doc.prefix.latePinned, true);
  assert.equal(doc.fixed.latePinned, false);
});

test('D2: the channel-only retraction is not a transaction on the fixed tree', () => {
  const f = face('P2_the_channel_only_retraction_is_never_a_transaction');
  assert.equal(f.prefix, true);
  assert.equal(f.fixed, false);
  assert.equal(doc.prefix.lateTransaction, true);
  assert.equal(doc.fixed.lateTransaction, false);
});

test('D3: the channel-only retraction is named only after the fix', () => {
  const f = face('P3_the_channel_only_retraction_is_named');
  assert.equal(f.prefix, true, 'before the fix the late retraction was NOT named (failure present)');
  assert.equal(f.fixed, false, 'after the fix it IS named (failure absent)');
  assert.equal(doc.fixed.rowsReverted, 2, 'the seal-retracted row AND the channel-only row are reported');
  assert.equal(doc.fixed.lateNamed, true, 'the signature itself is named');
  assert.equal(doc.prefix.lateNamed, false, 'and it was not named before the fix');
  assert.equal(doc.fixed.reorgRetractions, 2, "the channel's own delivery is counted");
});

test('G1: the live row survives on both trees (the fix over-corrects nothing)', () => {
  const f = face('P4_the_live_row_survives_on_both_trees');
  assert.equal(f.prefix, false);
  assert.equal(f.fixed, false);
  assert.ok(doc.prefix._raw.signatures.some((s) => s.signature.startsWith('ValidSig')));
  assert.ok(doc.fixed._raw.signatures.some((s) => s.signature.startsWith('ValidSig')));
});

test('G2: the seal gate still works on both trees (the channel work weakened nothing)', () => {
  const f = face('P5_the_seal_gate_still_works_on_both_trees');
  assert.equal(f.prefix, false, 'the seal gate is present on both trees — it catches SEAL_SIG');
  assert.equal(f.fixed, false);
  assert.ok(!doc.fixed._raw.signatures.some((s) => s.signature.startsWith('SealSig')));
});

test('G3: a retraction is not counted as an open envelope debt on either tree', () => {
  const f = face('P6_a_retraction_is_not_an_open_envelope_debt');
  assert.equal(f.prefix, false);
  assert.equal(f.fixed, false);
  assert.equal(doc.prefix.rowsWithoutEnvelope, 0);
  assert.equal(doc.fixed.rowsWithoutEnvelope, 0);
});

test('C1: verdict, denominator, and the zero-RPC promise are all present', () => {
  assert.equal(doc.verdict, 'reader-honours-the-retraction-channel');
  assert.equal(doc.prefix.exitCode, 0, 'the pre-fix run wrote its document');
  assert.equal(doc.fixed.exitCode, 0);
  assert.equal(doc.prefix.documentWritten, true);
  assert.equal(doc.fixed.documentWritten, true);
  assert.equal(doc.prefix.pinnedSignatures, 2, 'pre-fix: the live row AND the channel-only retraction');
  assert.equal(doc.fixed.pinnedSignatures, 1, 'post-fix: only the live row');
  assert.match(doc.method, /reorg-channel read removed/);
  assert.match(doc.fixed.method, /reorg tail --cursor/, 'the fixed run must say both channels were read');
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
    doc.limits.some((l) => /SEAL half/i.test(l)),
    'this artifact measures only the channel half — say which half is not covered here',
  );
});
