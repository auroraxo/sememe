// test/mailbox-shipped-measurement.test.mjs — the DELIVERY measurement of the
// mailbox reader, asked at the CHANNEL.
//
// This file pins the committed artifact of
// tools/measure-mailbox-shipped.mjs:
//
//   research/mailbox-shipped-2026-11-17.json
//
// WHY A CHANNEL MEASUREMENT AND NOT A WORKING-TREE ONE
//   The defect was never in the reader's LOGIC — it was in WHERE the reader
//   lived. `tools/harvest-reeflog.mjs` honoured both of reeflog's retraction
//   signals, and `package.json`'s `files` allowlist excludes `tools/`, so the
//   published `sememe@0.4.33` shipped no reader at all:
//
//     import('sememe/mailbox') -> ERR_PACKAGE_PATH_NOT_EXPORTED
//
//   A working-tree measurement would have said "the logic is right" and the
//   published tarball would still have refused. This repo's most-repeated
//   defect class is exactly that gap — "main fixed, the pin pointing behind
//   it" — so the published version AND a fresh pack of this tree are installed
//   into two EMPTY apps and the same byte-identical probe runs inside each,
//   against the same REAL journal rows.
//
// WHAT THE MEASUREMENT FOUND
//   carrier: sememe@0.4.33 from the npm registry -> the subpath REFUSED.
//   fixed:   npm pack of this tree                -> the subpath RESOLVED, the
//            reader answered the same real rows with the same counts, and the
//            published decoder decoded every payload byte-exactly.
//
// FALSIFICATION
//   The carrier MUST refuse and the fixed tree MUST resolve. A run in which
//   both refuse is not a verdict but a broken probe — and the artifact must
//   say so rather than look clean. The pin fails when either side is
//   indistinguishable from the other.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'mailbox-shipped-2026-11-17.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
const raw = await readFile(ARTIFACT, 'utf8');

test('the artifact measures a published carrier and a fresh pack, and reaches a verdict', () => {
  assert.ok(artifact.carrier.spec, 'the carrier must name the published version it installed');
  assert.ok(artifact.fixed.spec, 'the fixed side must name what it installed');
  assert.ok(artifact.carrier.installedVersion, 'the carrier must report the version it actually installed');
  assert.ok(artifact.fixed.installedVersion, 'the fixed side must report the version it actually installed');
  assert.notEqual(artifact.carrier.installedVersion, artifact.fixed.installedVersion,
    'a comparison against itself measures nothing');
  assert.equal(artifact.verdict, 'closed-on-the-published-channel',
    `unexpected verdict: ${artifact.verdict}`);
  assert.ok(artifact.journal.rows > 0, 'the measurement must run against real journal rows');
});

test('the PUBLISHED carrier refuses the mailbox surface — a clean baseline would not prove anything', () => {
  assert.equal(artifact.carrier.subpath, 'refused',
    'the published carrier must refuse the subpath, otherwise the defect is unprovable');
  assert.equal(artifact.carrier.reader, null, 'the published carrier must ship no reader');
  assert.equal(artifact.carrier.behaviour, null, 'a refusing carrier must produce no behaviour to compare');
});

test('the FRESH pack resolves the subpath and answers the same real rows', () => {
  assert.equal(artifact.fixed.subpath, 'resolved', 'the fresh pack must resolve the subpath');
  assert.equal(artifact.fixed.reader, 'present', 'the fresh pack must ship the reader');
  assert.ok(artifact.fixed.behaviour, 'the fresh pack must answer the real rows');
  assert.equal(artifact.fixed.behaviour.counts.journalRows, artifact.journal.rows,
    'the reader must have seen every row the journal produced');
  assert.ok(artifact.fixed.behaviour.counts.payloads > 0,
    'the reader must have produced payloads from the real rows');
  assert.equal(artifact.fixed.behaviour.counts.channelRead, true,
    'the reader must report that the retraction channel was read');
});

test('every payload the reader produced decodes byte-exactly through the published decoder', () => {
  const decode = artifact.fixed.behaviour.decode;
  assert.ok(decode, 'the measurement must decode the payloads it read');
  assert.equal(decode.decoded, artifact.fixed.behaviour.counts.payloads,
    'every payload the reader produced must decode');
  assert.equal(decode.roundTrip, decode.decoded, 'every decoded payload must round-trip byte-exactly');
  assert.equal(decode.refusals, 0, 'no payload may be refused on the way through');
});

test('the artifact carries no host path and no absolute path', () => {
  assert.ok(!raw.includes('/home/'), 'the artifact must not carry a host path');
  assert.ok(!raw.includes('/tmp/'), 'the artifact must not carry a tmp path');
  // Every path that WAS absolute is scrubbed to the marker, so the record is
  // portable and the leak guard cannot be satisfied by an empty string.
  assert.ok(raw.includes('<work>'), 'scrubbed paths must read as the scrub marker');
});

test('the checks are all green — a partially green run is not a verdict', () => {
  const failed = artifact.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], `these checks failed: ${failed.map((c) => c.name).join(', ')}`);
  assert.equal(artifact.checksPass, `${artifact.checks.length}/${artifact.checks.length}`);
});
