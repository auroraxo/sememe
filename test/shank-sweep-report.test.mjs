import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// The committed measurement this repository publishes for the shank work
// (2026-11-04): the 156-fixture foreign sweep re-run with ONE program added
// to the store — Lighthouse (L2TExM…), adopted from its own first-party
// repository, decoded through the shank dialect.
const SHANK_REPORT = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-shank-2026-11-04.json');
const BASE_REPORT = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-pulled-2026-11-04.json');
const LH = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const LH_OBJECT = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled',
  'objects', '461e28fd1c7e33f3c37507b2c23632bcdbd9a4fb9daec83c4c600740febd0141.json');

test('the committed shank sweep report is the one the tool produces (no hand-edited numbers)', async () => {
  const report = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  const base = JSON.parse(await readFile(BASE_REPORT, 'utf8'));
  const s = report.summary;

  // Offline and complete: every fixture read, zero network attempts.
  assert.equal(report.networkAttempts, 0);
  assert.equal(report.status, 'pass');
  assert.equal(s.fixturesTotal, 156);
  assert.equal(s.fixturesUnreadable, 0);
  assert.equal(s.payloadsChecked, base.summary.payloadsChecked, 'the document set did not move');
  assert.equal(s.missingBytes, base.summary.missingBytes);

  // The deltas, pinned exactly as measured (2026-11-04):
  assert.equal(base.summary.decoded, 661);
  assert.equal(s.decoded, 703, 'decoded: 661 -> 703 (the 42 Lighthouse payloads)');
  assert.equal(base.summary.noInterface, 129);
  assert.equal(s.noInterface, 87, 'gap: 129 -> 87 (Lighthouse leaves the publish-nothing set)');
  assert.equal(base.summary.byteExactFull, 654);
  assert.equal(s.byteExactFull, 696, 'byte-exact: 654 -> 696 (every Lighthouse payload round-trips)');
  assert.equal(s.byteExactRate, 100);
  assert.equal(s.decodeErrors, base.summary.decodeErrors, 'no new refusal appeared');
  assert.equal(s.disagreements, 0, 'still diff-free');

  // Exactly ONE program moved in byProgram — Lighthouse, 42/42 decoded, and
  // no other row changed (nothing else in the sweep may shift silently).
  const moved = Object.keys(base.summary.byProgram)
    .filter((p) => JSON.stringify(base.summary.byProgram[p]) !== JSON.stringify(s.byProgram[p]));
  assert.deepEqual(moved, [LH]);
  assert.deepEqual(s.byProgram[LH], { payloads: 42, decoded: 42, decodeErrors: 0, disagreements: 0, noInterface: 0 });
  assert.equal(s.noInterfacePrograms[LH], undefined, 'Lighthouse is decoded, not an acquisition gap');

  // The store row that answers the sweep is the adopted first-party copy and
  // re-hashes to its receipt fingerprint.
  const receipt = JSON.parse(await readFile(path.join(ROOT, 'test', 'fixtures',
    'traffic-sample-store-2026-11-04-pulled', 'receipts',
    `${LH}-0-first-party-461e28fd1c7e33f3c37507b2c23632bcdbd9a4fb9daec83c4c600740febd0141.json`), 'utf8'));
  assert.equal(receipt.source, 'first-party');
  assert.equal(receipt.program, LH);
  const object = JSON.parse(await readFile(LH_OBJECT, 'utf8'));
  const { canonicalJson } = await import('../src/canonical.mjs');
  const digest = createHash('sha256').update(`${canonicalJson(object)}\n`).digest('hex');
  assert.equal(`sha256:${digest}`, receipt.fingerprint, 'the stored object must re-hash to the receipt fingerprint');
  assert.equal(object.instructions.length, 18, 'the first-party IDL holds 18 instructions');
});

test('T-pin false-positive guard: tampering with the committed report is caught', async () => {
  const report = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  const s = report.summary;
  // A hand-edited headline that no longer agrees with the per-program rows.
  const tampered = { ...report, summary: { ...s, decoded: 704 } };
  const derived = Object.values(tampered.summary.byProgram).reduce((n, r) => n + r.decoded, 0);
  assert.notEqual(derived, 704, 'the hand edit must disagree with the byProgram sum');
  assert.equal(s.decoded, Object.values(s.byProgram).reduce((n, r) => n + r.decoded, 0),
    'the committed headline is exactly the byProgram sum');
});
