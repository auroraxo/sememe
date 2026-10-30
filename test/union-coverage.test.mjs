// The committed union report must be the one the tool computes — no hand-edited
// numbers — and the headline must hold the way it was measured.
//
// Why this file exists: the union decode path is the product form of a
// measurement (research/traffic-coverage-2026-10-30.json, where a hand-merged
// union IDL decoded 914/996 pump.fun payloads). It is easy to change arbitration
// or source selection in a way that looks fine in a demo and quietly regresses
// that number. So the numbers are pinned twice: as an exact deep-equal against
// what the tool produces right now, and as explicit assertions with messages
// that say what each count MEANS.
//
// The headline, all on the same 996 payloads from one mainnet window:
//   on-chain copy alone   669/996 (research/traffic-coverage)
//   published copy alone  880/996 (research/traffic-coverage)
//   union via this repo   915/996 decoded, 81 refused by both
// The +1 over the hand-merged union is a real difference: that merge added
// instructions only, so the published-only SweepBondingCurveFeeEvent payload
// was refused; the product union carries both sources whole.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const TOOL = fileURLToPath(new URL('../tools/union-coverage.mjs', import.meta.url));
const REPORT = new URL('../research/union-coverage-2026-10-30.json', import.meta.url);

test('the committed report is the one the tool produces (no hand-edited numbers)', async () => {
  const { stdout } = await run(process.execPath, [TOOL], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    maxBuffer: 8 * 1024 * 1024,
  });
  const produced = JSON.parse(stdout);
  const committed = JSON.parse(await readFile(REPORT, 'utf8'));
  delete produced.generatedAt;
  delete committed.generatedAt;
  assert.deepEqual(committed, produced,
    'research/union-coverage-2026-10-30.json has drifted from what tools/union-coverage.mjs computes');
});

test('the headline numbers hold, with their meaning intact', async () => {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  const p = report.pumpFun;
  assert.equal(p.traffic.payloads, 996, 'the fixture must be the measured 996-payload window');
  const decoded = Object.values(p.unionVerdicts).reduce((a, b) => a + b, 0);
  const refused = Object.entries(p.refusals)
    .filter(([key]) => !key.includes('::')).reduce((sum, [, count]) => sum + count, 0);
  assert.equal(decoded, 915, 'union must decode 915/996 — fewer means a source was dropped or arbitration broke');
  assert.equal(refused, 81, 'both sources refuse exactly 81 payloads — a refusal must not be silently accepted');
  assert.equal(decoded + refused, p.traffic.payloads, 'every payload has a verdict, none vanishes');

  // Verdict distribution: each count is a claim about a distinct disagreement.
  assert.equal(p.unionVerdicts.fallback_secondary, 246,
    '246 payloads are known only to the published copy (measured stale on-chain account)');
  assert.equal(p.unionVerdicts.primary_only, 35,
    '35 payloads the published copy refuses (truncated layouts) but the on-chain copy decodes');
  assert.equal(p.unionVerdicts.agree, 546, '546 payloads both sources decode identically');
  assert.equal(p.unionVerdicts.layout_drift, 88,
    '88 payloads both decode to different arguments — the drift must stay visible, not absorbed');

  // Byte evidence decided every non-default arbitration.
  assert.equal(p.arbitrationBasis.primary_refused, 246);
  assert.equal(p.arbitrationBasis.secondary_refused, 35);
  assert.equal(p.arbitrationBasis.primary_by_default, 546);
  assert.equal(p.arbitrationBasis.byte_evidence_full_roundtrip, 1,
    'exactly one payload was decided by a full round trip the other source could not produce (CreateEvent depth)');
  assert.equal(p.arbitrationBasis.byte_evidence_fewer_unexplained_bytes, 87,
    'exactly 87 payloads were decided by strictly fewer unexplained bytes (TradeEvent creator_fee_unclaimed)');

  // Refusal is a statement about the IDL, not about the chain.
  assert.ok(p.decodeVsChainOutcome.refused_txSuccess > 0,
    'some refused payloads sit in transactions the chain accepted — refusal must never imply chain failure');

  // Every decoded payload re-encodes at least its described prefix byte-for-byte.
  assert.equal(p.byteExactness.describedRoundTrip, decoded,
    'every decoded payload must re-encode its described prefix byte-exactly');
  assert.equal(p.byteExactness.fullRoundTrip, 828,
    '828 payloads re-encode their WHOLE payload; the 87 remaining decoded payloads carry unexplained tails that are reported');
});
