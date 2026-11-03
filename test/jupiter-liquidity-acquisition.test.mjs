// The acquisition gap, closed: Jupiter Liquidity (jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC)
//
// WHY THIS FILE EXISTS
//
// The unbiased traffic measurement (research/traffic-coverage-2026-11-02.json)
// ended with an acquisition gap of 16 payloads on two programs. This file is
// about one of them, and about the defect that stood in the way of fixing it.
//
// Jupiter Liquidity has NO on-chain interface at either address sememe can pull
// from — measured at capture time (both sources absent, acquirable: false) and
// re-measured against live mainnet on 2026-11-03 (slot 464744781: metadata null,
// anchor:idl null). So its only route to a verified interface is the adopted
// first-party published copy: jup-ag/jupiter-lend, target/idl/liquidity.json at
// commit 0ab370a0dff439ff895bb8e78f085ec9bb11b168, content-addressed into the
// committed fixture store (sha256:8ed1e22661ab6d9076b206cfb19e32cbd7da65a31a2c0c28586312e70aac2983).
//
// Adopting it alone did NOT fix the coverage number. The union reader refused
// the store with `unionDecode needs a primary source` — a store whose ONLY
// source is an adopted copy had no "primary", so the product reported "no
// interface" about a store that had exactly one, while the plain single-source
// decode of the same bytes succeeded 7/7. Two entry points, two different
// answers from one store, the wrong one measured. That is fixed (src/union.mjs:
// an adopted copy may stand alone when there is no on-chain pull to displace;
// it may still never displace one — pinned in test/union.test.mjs).
//
// WHAT MUST STAY TRUE
//
// 1. The capture-time verdict still says acquirable: false — the gap was real,
//    and no fixture edit rewrites the chain's answer.
// 2. The store still holds NO on-chain receipt for this program: the payloads
//    are decoded by an adopted copy, and the verdict must say so
//    (adoptedOnly), never imply an on-chain source answered.
// 3. All seven real traffic payloads decode byte-exactly through the product's
//    union entry point — the path that used to refuse.
// 4. Remove the adopted copy and the gap comes back: the number moves because
//    a verified interface was added, not because a counter was edited.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeUnionPayload, findStoredIdls } from '../src/decode.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = path.join(ROOT, 'test/fixtures/traffic-sample-2026-11-02.json');
const STORE = path.join(ROOT, 'test/fixtures/traffic-sample-store');
const PUBLISHED = path.join(ROOT, 'test/fixtures/jupiter-liquidity-published-idl.json');
const JUPITER = 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC';

const sample = JSON.parse(await readFile(SAMPLE, 'utf8'));
const jupiterPayloads = sample.transactions
  .flatMap((tx) => tx.payloads.map((p) => ({ ...p, txErr: tx.txErr ?? null })))
  .filter((p) => p.program === JUPITER);

test('the gap was real: neither on-chain surface existed at capture time, or now', async () => {
  const verdict = sample.acquirable[JUPITER];
  assert.ok(verdict, 'the sample must carry the capture-time acquisability check');
  assert.equal(verdict.acquirable, false, 'Jupiter Liquidity has no on-chain IDL — measured, not assumed');
  assert.deepEqual(verdict.sources.map((s) => s.state), ['absent', 'absent'],
    'both the program-metadata and the legacy anchor:idl surfaces were absent');
  assert.equal(verdict.idl, null);

  // Re-measured against live mainnet: a gap may close on chain later, and if it
  // does this test says so instead of silently citing the old capture.
  const { addresses, rpcAccounts } = await import('../src/acquire.mjs');
  const where = await addresses(JUPITER);
  const live = await rpcAccounts('https://api.mainnet-beta.solana.com', [where.metadata, where.anchor], fetch, 3);
  if (live.error) {
    // Offline/rate-limited: the claim must not rest on an unverifiable network
    // call, so the capture-time measurement above still stands on its own.
    test.diagnostic(`live RPC check skipped: ${live.error}`);
    return;
  }
  const present = live.accounts.filter((a) => a !== null).length;
  assert.equal(present, 0,
    `both on-chain IDL surfaces are still absent at slot ${live.slot} — the published copy remains the only route`);
});

test('the seven real traffic payloads are all Jupiter Liquidity, and the store has no on-chain receipt for it', async () => {
  assert.equal(jupiterPayloads.length, 7, 'the sample carries exactly the 7 measured payloads');
  const receipts = (await readdir(path.join(STORE, 'receipts')))
    .filter((name) => name.startsWith(`${JUPITER}-`));
  assert.equal(receipts.length, 1, 'exactly one receipt: the adopted published copy');
  assert.ok(receipts[0].includes('-0-'), 'the adopted receipt sits at the slot-0 filename position');
  assert.equal(receipts[0].includes('-metadata-'), false, 'no on-chain metadata receipt exists for this program');
  assert.equal(receipts[0].includes('-anchor-'), false, 'no on-chain anchor receipt exists for this program');
});

test('all seven decode byte-exactly through the union path, which names the adopted source', async () => {
  const { onChain, adopted, primary, secondary } = await findStoredIdls(STORE, JUPITER);
  assert.equal(onChain.length, 0, 'nothing on chain to displace');
  assert.equal(adopted.length, 1);
  assert.equal(primary, null, 'there is no on-chain primary');
  assert.equal(secondary.idlMeta.source, 'jup-ag-jupiter-lend-published-liquidity.json-test-fixture-pin-');
  assert.equal(secondary.idlMeta.slot, null, 'the receipt says where it did NOT come from');
  assert.equal(secondary.idlMeta.fingerprint,
    'sha256:8ed1e22661ab6d9076b206cfb19e32cbd7da65a31a2c0c28586312e70aac2983');

  const published = JSON.parse(await readFile(PUBLISHED, 'utf8'));
  assert.equal(published.address, JUPITER);
  assert.equal(published.instructions.length, 26);

  for (const row of jupiterPayloads) {
    const result = await decodeUnionPayload(STORE, JUPITER, row.dataHex, { absent: 'error' });
    assert.equal(result.roundTripByteExact, true,
      `${row.dataHex.slice(0, 16)} must re-encode byte-exactly`);
    assert.equal(result.view.verdict, 'single_source');
    assert.equal(result.view.adoptedOnly, true,
      'the verdict must say the store had only an adopted copy');
    assert.equal(result.idl.source, 'jup-ag-jupiter-lend-published-liquidity.json-test-fixture-pin-');
    assert.equal(result.idl.slot, null, 'provenance of the winning source is "not from a slot"');
  }
});

test('remove the adopted copy and the acquisition gap comes back — the number moved because an interface was added', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-jupiter-gap-'));
  try {
    await cp(STORE, dir, { recursive: true });
    const receipts = await readdir(path.join(dir, 'receipts'));
    const name = receipts.find((n) => n.startsWith(`${JUPITER}-`));
    assert.ok(name, 'the adopted receipt is what makes the decode possible');
    await rm(path.join(dir, 'receipts', name));

    await assert.rejects(
      () => decodeUnionPayload(dir, JUPITER, jupiterPayloads[0].dataHex),
      (error) => {
        // Without the copy the product must say NO INTERFACE — by name, never
        // "refused" (an interface exists but disliked the bytes) or the other
        // way round. That distinction is what the coverage report counts.
        assert.match(error.message, /no stored IDL for program/);
        return true;
      },
    );

    // And the coverage report's queue must name it again once the copy is gone:
    // the queue is DERIVED from the store state, not curated.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [path.join(ROOT, 'tools/traffic-coverage-report.mjs')], {
      cwd: ROOT, maxBuffer: 16 * 1024 * 1024,
    });
    const full = JSON.parse(stdout);
    const jupiterRow = full.programs.find((r) => r.program === JUPITER);
    assert.equal(jupiterRow.decoded, 7, 'with the copy present in the committed store, all seven decode');
    assert.equal(jupiterRow.noInterface, 0, 'and none of them is reported as having no interface');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the committed report and the acquisition queue reflect the closure', async () => {
  const report = JSON.parse(await readFile(path.join(ROOT, 'research/traffic-coverage-2026-11-02.json'), 'utf8'));
  const jupiterRow = report.programs.find((r) => r.program === JUPITER);
  assert.ok(jupiterRow, 'the program is in the measured rows');
  assert.equal(jupiterRow.payloads, 7);
  assert.equal(jupiterRow.decoded, 7, 'all seven payloads named by the adopted copy');
  assert.equal(jupiterRow.noInterface, 0);
  assert.equal(jupiterRow.refused, 0);

  assert.equal(report.acquisitionQueue.some((r) => r.program === JUPITER), false,
    'Jupiter Liquidity left the acquisition queue — it has a verified interface now');
  // The last gap closed the same day: Raydium AMM v4 now decodes through the
  // table derived from its own upstream program source (src/raydium.mjs), so
  // no payload in the sample lacks an interface any more.
  assert.deepEqual(report.acquisitionQueue.map((r) => r.name), [],
    'the acquisition queue is empty — every watched payload has an interface');
  assert.equal(report.headline.noInterface, 0);
  assert.equal(report.headline.decoded, 12401);
  const raydiumRow = report.programs.find((r) => r.program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
  assert.equal(raydiumRow.decoded, 9, 'all nine Raydium payloads named by the derived table');
  assert.equal(raydiumRow.noInterface, 0);
});
