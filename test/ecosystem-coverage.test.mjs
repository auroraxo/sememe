// The ecosystem-coverage measurement: the denominator the curated watchlist
// never gave the coverage claim.
//
// This file pins the committed artifact of tools/ecosystem-coverage.mjs:
//
//   research/ecosystem-coverage-2026-11-11.json
//
// WHAT THE MEASUREMENT FOUND (the point of pinning it):
//
//   The committed traffic-coverage report (research/traffic-coverage-
//   2026-11-04.json) reads coveredPct 100 over 89,546 watched payloads, while
//   the same artifact reports 320 distinct programs / 36,027 instructions /
//   22,622 transactions OUTSIDE the watched list as counted-but-not-measured.
//   The 100% claim was real for its window, but it had never been measured
//   on the traffic a consumer actually meets first.
//
//   This measurement samples 6 contiguous finalized mainnet blocks (2,436
//   transactions, 22,265 instructions, 192 distinct programs), selects the
//   measured set by TRAFFIC VOLUME (watchlist + top-volume others, never
//   store-selected), pulls and installs the acquirable interfaces through the
//   product's own write path, and measures the bytes through the product's
//   own entry points:
//
//     measured payloads        21,350
//     decoded                 17,558   coveredPctOfMeasured  82.2%
//     refused                  1,258   (interface present, bytes refused)
//     no-interface             2,534   (nothing acquirable at either address)
//     byte-exact re-encode    16,387/17,558 = 93.3% of decoded
//     ALL traffic seen        22,265   coveredPctOfAllSeen   72.5%
//     counted-not-measured       915   (152 programs below the bounds)
//
//   THE SPLIT IS THE FINDING. The same bytes, split by which denominator the
//   old claim used versus the one it never touched:
//
//     watchlist  (the committed claim's denominator): 16,382 payloads, 96.4%
//     outside    (never measured before):             4,968 payloads,  7.1%
//
//   The ecosystem-wide number is 82.2%, not 100%. The gap is dominated by
//   acquisition, not decoding: 2,534 of the 3,792 uncovered payloads are
//   no-interface (L2TE… pump L2 1,214; MNFST… 307; FLASH…
//   134; …), and 817 are refusals on interfaces that ARE acquirable (source
//   lag: pfeeU… 459 unknown-discriminator refusals on its pulled anchor IDL,
//   HADRo… 195 on every payload).
//
//   The watchlist itself regressed against its own 11-04 window: pump.fun
//   decoded 400/842 (47.5%) after decoding ~100% there — a source-lag signal
//   on the freshest single-source pull, not a decoder bug (the union carries
//   no published copy for pump.fun; the old window's decode came through the
//   union of two sources).
//
// THE INVARIANTS are the falsification half:
//   * the committed artifact is byte-for-byte what the tool derives from the
//     committed fixture and store right now (no hand-edited numbers);
//   * the artifact names NO host path (a machine path in a committed
//     measurement makes it non-reproducible and would rot in CI);
//   * the watchlist/outside split is present and ordered (outside strictly
//     below watchlist), so the honest number can never quietly regress into
//     the flattering one;
//   * no-interface must dominate the outside gap — if a future store makes
//     acquirable interfaces decode worse than acquisition, this file holds
//     the old shape as the pin and the change must be argued, not drifted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'ecosystem-coverage.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'ecosystem-coverage-2026-11-11.json');
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact is the one the tool produces from the committed fixture (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.ecosystem-coverage-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, 'report',
      '--sample', SAMPLE, '--store', STORE, '--out', fresh], {
      cwd: ROOT, stdio: 'ignore', timeout: 240_000,
    });
    assert.ok(existsSync(fresh), 'the tool produced no output');
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    const strip = (r) => {
      const copy = { ...r };
      delete copy.generatedAt;
      return copy;
    };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
  }
});

test('the artifact carries no host path', () => {
  const text = readFileSync(ARTIFACT, 'utf8');
  assert.doesNotMatch(text, /\/home\//, 'a committed measurement must not name a home directory');
  assert.doesNotMatch(text, /\/tmp\//, 'a committed measurement must not name a scratch path');
  assert.equal(artifact.sample.store, 'test/fixtures/ecosystem-store-2026-11-11');
});

test('the headline holds and the three outcomes stay split', () => {
  const h = artifact.headline;
  assert.equal(h.measuredPayloads, 21_350);
  assert.equal(h.decoded, 17_558);
  assert.equal(h.refused, 1_258);
  assert.equal(h.noInterface, 2_534);
  assert.equal(h.coveredPctOfMeasured, 82.2);
  assert.equal(h.byteExact, 16_387);
  assert.equal(h.allPayloadsSeen, 22_265);
  assert.equal(h.notMeasuredPayloads, 915);
  // The honest number is the measured one; the all-seen number exists so the
  // un-measured tail can never inflate coverage.
  assert.ok(h.coveredPctOfAllSeen < h.coveredPctOfMeasured);
  assert.ok(h.byteExactPctOfDecoded > 90);
});

test('the falsification view: outside the watchlist the claim does not hold', () => {
  const h = artifact.headline;
  assert.ok(h.watchlist.payloads > 10_000, 'the watchlist view must be the big denominator');
  assert.equal(h.watchlist.coveredPct, 96.4,
    'the curated claim reproduces on its own denominator');
  assert.ok(h.outsideWatchlist.payloads > 3_000,
    'the outside view must carry a real sample');
  assert.ok(h.outsideWatchlist.coveredPct < 60,
    `outside-watchlist coverage must stay honestly below the watchlist, got ${h.outsideWatchlist.coveredPct}`);
  assert.ok(h.outsideWatchlist.coveredPct < h.watchlist.coveredPct - 50,
    'the split must stay decisive — a quiet convergence would mean the outside traffic silently joined the watchlist denominator');
});

test('the gap is dominated by acquisition, not decoding', () => {
  const h = artifact.headline;
  assert.ok(h.noInterface > h.refused * 2,
    `no-interface (${h.noInterface}) must dominate refused (${h.refused}) — the fix is acquisition, not decoder polish`);
  const outside = h.outsideWatchlist;
  assert.ok(outside.noInterface > outside.refused,
    'outside the watchlist the acquisition gap must lead');
  // The named faces of the acquisition gap, pinned so a change is an event.
  // 2026-11-11: the ATA table (ATokenGPvbd…) closed the #1 face — 1,410
  // payloads, no-interface 1,410 -> 0, decoded 0 -> 1,410. The queue's new
  // head is L2TExMFK… (pump L2, 1,214).
  const byId = Object.fromEntries(artifact.programs.map((p) => [p.program, p]));
  assert.equal(byId['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'].noInterface, 0);
  assert.equal(byId['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'].decoded, 1_410);
  assert.equal(byId['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'].byteExact, 1_406,
    'the 1,406 one-byte payloads re-encode byte-exactly; the 4 empty ones are named via the processor fallback and are not byte-exact');
  assert.equal(byId['L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'].noInterface, 1_214);
  assert.equal(byId['MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms'].noInterface, 307);
});

test('the source-lag faces are pinned: acquirable interfaces that refuse bytes', () => {
  const byId = Object.fromEntries(artifact.programs.map((p) => [p.program, p]));
  const pfee = byId['pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'];
  assert.equal(pfee.acquirable, true);
  assert.ok(pfee.refused >= 400,
    `pfeeU… source lag must stay visible (${pfee.refused} refused)`);
  const hadr = byId['HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8'];
  assert.equal(hadr.acquirable, true);
  assert.equal(hadr.decoded, 0,
    'HADRo… must stay a total source-lag face — any decode there is an event, not noise');
  // pump.fun regression against its own 11-04 window (union coverage was
  // ~100% there; the single-source pull now refuses 442 payloads).
  const pump = byId['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'];
  assert.equal(pump.acquirable, true);
  assert.ok(pump.refused >= 400,
    `pump.fun single-source lag must stay visible (${pump.refused} refused)`);
  assert.ok(pump.decoded / pump.payloads < 0.6,
    'pump.fun must stay below its 11-04 union coverage — the regression is pinned until a second source closes it');
});

test('the measurement is volume-honest: un-measured traffic is counted, not dropped', () => {
  assert.equal(artifact.sample.distinctProgramsSeen, 192);
  assert.equal(artifact.sample.measuredPrograms, 46);
  assert.equal(artifact.captureMeta.transactionsInBlocks, 2436);
  assert.equal(artifact.trafficNotMeasured.distinctPrograms, 152);
  assert.equal(artifact.trafficNotMeasured.instructions, 915);
  const notMeasuredPayloads = artifact.notMeasured.reduce((acc, x) => acc + x.payloadCount, 0);
  assert.equal(notMeasuredPayloads, 915);
  assert.ok(Math.max(...artifact.notMeasured.map((x) => x.payloadCount)) <= 31,
    'everything above the bounds must have been measured — the tail must stay a tail');
});
