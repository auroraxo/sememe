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
//   decoded     12,384 (98.5%)  — an available interface could name them
//   refused        172          — interface present, bytes refused (source lag)
//   no-interface    16          — no interface acquirable at all
//   byte-exact re-encode: 11,691/12,384 = 94.4% of decoded
// The split is the finding, and it moved the same day it was measured:
// the first run of this report (same sample) put 5,418 payloads at
// "no-interface", 99.7% of them SPL Token + Token-2022, which publish no IDL
// account at either address sememe can pull from — an ACQUISITION gap. The
// fix shipped the same day: the two token wire tables are now derived from
// the pinned upstream Rust crates (src/token-interface.mjs), so 5,401 of
// those 5,402 payloads decode through the product. What remains of the
// acquisition gap is 16 payloads on two programs (Raydium AMM v4, Jupiter
// Liquidity) — the honest, small remainder.

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
  assert.equal(h.decoded, 12384, '12,384 payloads decoded — fewer means a decoder or store-fixture regression');
  assert.equal(h.coveredPct, 98.5, 'the honest unbiased-traffic coverage is 98.5% after the token tables landed');
  assert.equal(h.refused, 172,
    '172 payloads refused by an interface that EXISTS (source lag) — refusals must not be hidden inside no-interface');
  assert.equal(h.noInterface, 16,
    '16 payloads have no interface at all — the acquisition gap, now measured small and named');

  // Byte evidence: decoding is not enough, the bytes must come back.
  assert.equal(h.byteExact, 11691, '11,691 decoded payloads re-encode byte-exactly');
  assert.equal(h.byteExactPctOfDecoded, 94.4);

  // Refusal is a statement about the interface, not about the chain: there are
  // payloads the chain ACCEPTED and the interface still refused (source lag),
  // and payloads with no interface at all inside successful transactions.
  const v = report.outcomeVsChain;
  assert.equal(v.decoded_txSuccess + v.decoded_txFailed, h.decoded,
    'every decoded payload sits in some transaction outcome');
  assert.equal(v.refused_txSuccess + v.refused_txFailed, h.refused);
  assert.equal(v.noInterface_txSuccess + v.noInterface_txFailed, h.noInterface);
  assert.equal(v.refused_txSuccess, 21,
    '21 refused payloads were in transactions the chain accepted — a refusal never implies chain failure');
  assert.ok(v.noInterface_txSuccess > 0,
    'the acquisition-gap payloads include successful transactions — real traffic the product cannot name');

  // The measurement went through the product, not a parallel implementation.
  assert.match(report.sample.measurementPath, /decodePayload|decodeUnionPayload|native/,
    'the report must name the product entry points it measured through');
});

test('the token gap was closed by derivation, not by relabelling', async () => {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  const byName = new Map(report.programs.map((row) => [row.name ?? row.program, row]));

  // SPL Token + Token-2022: the two programs that publish NO IDL account.
  // Their payloads decode through the vendored-upstream token tables now —
  // measured through the same product entry points as every other program.
  const spl = byName.get('SPL Token');
  const token2022 = byName.get('Token-2022');
  assert.equal(spl.payloads + token2022.payloads, 5402, 'the two token programs carry 5,402 payloads');
  assert.equal(spl.decoded, 3804, 'every SPL Token payload decodes through the pinned upstream table');
  assert.equal(spl.noInterface, 0);
  assert.equal(token2022.decoded, 1597);
  assert.equal(token2022.noInterface, 0);
  assert.equal(token2022.refused, 1, 'the one refusal is the token-metadata fallback, named and force-fitted to nothing');

  // The measurement path names the token decoder: the number moved because
  // the product gained a decode path, not because the denominator changed.
  assert.match(report.sample.measurementPath, /token decoder/);

  // What REMAINS of the acquisition queue is small and named.
  const remaining = report.acquisitionQueue.reduce((acc, row) => acc + row.payloads, 0);
  assert.equal(remaining, report.headline.noInterface,
    'the acquisition queue is exactly the no-interface remainder');
  assert.ok(remaining <= 20, 'the remaining acquisition gap is the measured 16 payloads');
});

test('the interfaces that exist decode at 90%+; the rest is source lag', async () => {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  const byName = new Map(report.programs.map((row) => [row.name ?? row.program, row]));

  // Programs WITH interfaces decode at 90%+ of their traffic; the gap is
  // acquisition or source lag, not decoding. (Pump/PumpSwap carry source
  // lag — refused — which is measured under refusals, not hidden here.)
  const withInterface = report.programs.filter((row) => row.noInterface === 0);
  const dec = withInterface.reduce((a, r) => a + r.decoded, 0);
  const pl = withInterface.reduce((a, r) => a + r.payloads, 0);
  assert.equal(pl, 12556, 'everything except the 16 no-interface payloads has an interface');
  assert.equal(dec, 12384);
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
  // The queue's top entry follows the MEASURED gap: SPL Token used to lead
  // it (3,804 payloads, now decoded via the vendored upstream table), so the
  // biggest remaining no-interface row is Raydium AMM v4.
  assert.equal(report.acquisitionQueue[0].name, 'Raydium AMM v4', 'the top of the queue is the biggest measured gap');
  assert.equal(report.acquisitionQueue.length, 2, 'only two programs still have no interface at all');
});
