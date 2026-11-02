// The committed traffic-coverage report must be the one the tool computes —
// no hand-edited numbers — and the measured coverage must hold the way it was
// measured.
//
// Why this file exists: the card's stated risk is the COVERAGE ILLUSION.
// Every previous sememe qualification measured programs that were chosen
// because they were already in the store; the 915/996 pump.fun number is real
// for its window but says nothing about the ecosystem. This test pins the
// honest number from the other direction: contiguous recent mainnet blocks
// that were collected WITHOUT consulting the store, then measured through the
// product's own entry points. The number can only get worse with a code
// regression, never better — which is exactly what a coverage number is for.
//
// The headline (research/traffic-coverage-2026-11-02.json, sample captured
// 2026-11-02T15:50Z from four contiguous finalized blocks):
//   12,572 watched payloads from 1,872 transactions in 4 blocks
//   decoded      6,983 (55.5%)  — an available interface could name them
//   refused        171          — interface present, bytes refused (source lag)
//   no-interface 5,418          — no interface acquirable at all
//   byte-exact re-encode: 6,712/6,983 = 96.1% of decoded
// The split is the finding: 99.7% of no-interface sits on SPL Token +
// Token-2022 (43% of watched traffic), which publish no IDL account at either
// address sememe can pull from — an ACQUISITION gap, not a decoder gap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const TOOL = fileURLToPath(new URL('../tools/traffic-coverage-report.mjs', import.meta.url));
const REPORT = new URL('../research/traffic-coverage-2026-11-02.json', import.meta.url);
const SAMPLE = new URL('../test/fixtures/traffic-sample-2026-11-02.json', import.meta.url);

test('the committed report is the one the tool produces (no hand-edited numbers)', async () => {
  const { stdout } = await run(process.execPath, [TOOL], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    maxBuffer: 16 * 1024 * 1024,
  });
  const produced = JSON.parse(stdout);
  const committed = JSON.parse(await readFile(REPORT, 'utf8'));
  delete produced.generatedAt;
  delete committed.generatedAt;
  assert.deepEqual(committed, produced,
    'research/traffic-coverage-2026-11-02.json has drifted from what tools/traffic-coverage-report.mjs computes');
});

test('the sample is traffic without store-selection bias', async () => {
  const sample = JSON.parse(await readFile(SAMPLE, 'utf8'));
  assert.equal(sample.meta.blocksWithTraffic, 4, 'the measured window is four blocks');
  assert.equal(sample.meta.skippedSlots.length, 0, 'no skipped slot silently shrank the sample');
  assert.equal(sample.meta.requestedSlots.length, 4);
  assert.ok(sample.meta.capturedAt.startsWith('2026-11-02'), 'the sample is the dated capture this report is about');
  // The watched list is the repo catalog + native, captured before any decode.
  assert.equal(sample.meta.watchedPrograms, 22);
  // The acquisability check rode along at capture time — the report's
  // acquisition-gap verdicts cite it, so it must be present and complete.
  assert.equal(Object.keys(sample.acquirable).length, 30,
    '22 watched + 8 probed non-watched programs were acquisability-checked at capture time');
});

test('the headline numbers hold, with their meaning intact', async () => {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  const h = report.headline;

  // The denominator: every watched payload has exactly one verdict.
  assert.equal(h.watchedPayloads, 12572, 'the measured denominator is 12,572 watched payloads');
  assert.equal(h.decoded + h.refused + h.noInterface, h.watchedPayloads,
    'every payload has a verdict — decoded, refused, or no-interface; none vanishes');

  // Coverage, measured through the product entry points.
  assert.equal(h.decoded, 6983, '6,983 payloads decoded — fewer means a decoder or store-fixture regression');
  assert.equal(h.coveredPct, 55.5, 'the honest unbiased-traffic coverage is 55.5%');
  assert.equal(h.refused, 171,
    '171 payloads refused by an interface that EXISTS (source lag) — refusals must not be hidden inside no-interface');
  assert.equal(h.noInterface, 5418,
    '5,418 payloads have no interface at all — the acquisition gap, reported separately');

  // Byte evidence: decoding is not enough, the bytes must come back.
  assert.equal(h.byteExact, 6712, '6,712 decoded payloads re-encode byte-exactly');
  assert.equal(h.byteExactPctOfDecoded, 96.1);

  // Refusal is a statement about the interface, not about the chain: there are
  // payloads the chain ACCEPTED and the interface still refused (source lag),
  // and payloads with no interface at all inside successful transactions.
  const v = report.outcomeVsChain;
  assert.equal(v.decoded_txSuccess + v.decoded_txFailed, h.decoded,
    'every decoded payload sits in some transaction outcome');
  assert.equal(v.refused_txSuccess + v.refused_txFailed, h.refused);
  assert.equal(v.noInterface_txSuccess + v.noInterface_txFailed, h.noInterface);
  assert.equal(v.refused_txSuccess, 20,
    '20 refused payloads were in transactions the chain accepted — a refusal never implies chain failure');
  assert.ok(v.noInterface_txSuccess > 4000,
    '4,278 payloads inside SUCCESSFUL transactions have no interface — the acquisition gap costs real traffic');

  // The measurement went through the product, not a parallel implementation.
  assert.match(report.sample.measurementPath, /decodePayload|decodeUnionPayload|native/,
    'the report must name the product entry points it measured through');
});

test('the split names acquisition, not the decoder, as the dominant gap', async () => {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  const byName = new Map(report.programs.map((row) => [row.name ?? row.program, row]));

  const spl = byName.get('SPL Token');
  const token2022 = byName.get('Token-2022');
  assert.equal(spl.noInterface, 3804, 'SPL Token has no interface in sememe at all');
  assert.equal(token2022.noInterface, 1598, 'Token-2022 has no interface in sememe at all');
  const tokenShare = (spl.noInterface + token2022.noInterface) / report.headline.noInterface;
  assert.ok(tokenShare > 0.99,
    '99.7% of the no-interface gap is the two token programs — the queue must not pretend it is scattered');

  // SPL Token + Token-2022 alone are 43% of all watched traffic: the single
  // biggest lever on the coverage number.
  const tokenTraffic = spl.payloads + token2022.payloads;
  assert.equal(tokenTraffic, 5402, 'the two token programs carry 5,402 payloads');
  assert.equal(Math.round(100 * tokenTraffic / report.headline.watchedPayloads), 43,
    'the token family is 43% of watched traffic');

  // Programs WITH interfaces decode at 96%+ of their non-token traffic;
  // the gap is acquisition, not decoding. (Pump/PumpSwap carry source lag —
  // refused — which is measured under refusals, not hidden here.)
  const withInterface = report.programs.filter((row) => row.noInterface === 0);
  const dec = withInterface.reduce((a, r) => a + r.decoded, 0);
  const pl = withInterface.reduce((a, r) => a + r.payloads, 0);
  assert.equal(dec, 6983);
  assert.equal(pl, 7154);
  assert.ok(dec / pl > 0.9, 'programs with an interface decode >90% of their traffic');

  // Adopting the FIRST-PARTY published copy is what moved PumpSwap from 82%
  // to 96.4% — the union path arbitrating between a stale on-chain IDL and a
  // published copy is a coverage lever, not just a decode nicety.
  const pumpSwap = byName.get('PumpSwap');
  assert.equal(pumpSwap.decoded, 487, 'PumpSwap: 487 payloads decoded');
  assert.equal(pumpSwap.refused, 18, 'PumpSwap: 18 payloads still refused (the undeclared e445a52e form)');
  assert.equal(pumpSwap.coveredPct, 96.4);
});

test('the acquisition queue is derivable, not curated', async () => {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  const sample = JSON.parse(await readFile(SAMPLE, 'utf8'));

  // The queue is exactly the no-interface rows, ordered by traffic.
  const fromReport = report.acquisitionQueue.map((row) => row.program);
  const expected = report.programs.filter((row) => row.noInterface > 0)
    .sort((a, b) => b.payloads - a.payloads).map((row) => row.program);
  assert.deepEqual(fromReport, expected, 'the queue must be the measured gap, ordered by traffic');

  // Every acquirable=false verdict in the queue cites the capture-time check.
  for (const row of report.acquisitionQueue) {
    const checked = sample.acquirable[row.program];
    assert.ok(checked, `queue entry ${row.program} was acquisability-checked at capture time`);
    assert.equal(row.acquirable, checked.acquirable,
      `queue verdict for ${row.program} must quote the capture-time check, not a later guess`);
  }
  assert.equal(report.acquisitionQueue[0].name, 'SPL Token', 'the top of the queue is the biggest measured gap');
});
