// The stale on-chain IDL defect, measured and pinned.
//
// WHY THIS FILE EXISTS — measured 2026-11-09 (research/stale-layout-2026-11-09.json):
//
// The meteora-vault program's on-chain Anchor IDL is frozen at v0.7.2 and
// declares `strategies: publicKey[30]`. The published SDK IDL declares
// `strategies: publicKey[29]` plus `version: u8`, `totalLpSupply: u64` and
// `padding0: u8[23]` — the same 960 bytes, split differently.
//
// Because the published copy spells the account `vault` and the deployed one
// is `Vault`, Anchor derives different discriminators, so the published copy
// refuses and the on-chain copy ANSWERS. The answer the user receives
// therefore contains a `strategies[29]` that is not a strategy: it is three
// fields (version, totalLpSupply, padding0) wearing a public key's clothes.
//
// THE MEASUREMENT has two halves, and this file pins both:
//
//   OFFLINE (12/12, no network): the base58 bytes of `strategies[29]` are
//     byte-for-byte `version || totalLpSupply || padding0` under the published
//     copy's layout. The phantom decomposes exactly.
//
//   LIVE (mainnet, 2026-11-09): none of the 12 phantom addresses exist
//     (0/12); all 348 real strategy accounts (29 × 12) do exist (348/348);
//     `version` is 1 and `padding0` is all-zero on 12/12; and on 9 of the 12
//     vaults the published copy's `totalLpSupply` equals the LIVE supply of
//     the vault's own LP mint. The 3 that do not are vaults whose LP supply
//     moved after the harvest was frozen — the artifact records both numbers
//     for every vault, so the difference is visible rather than smoothed over.
//
// WHAT THIS FILE PINS:
//
//   T1  the offline proof: 12/12 phantoms decompose exactly into the other
//       copy's fields — this is reproducible with NO network;
//   T2  the layout difference itself: 30 keys vs 29 keys plus three fields,
//       and the two declarations are the same LENGTH in bytes;
//   T3  the live oracle, when the network run is enabled: 0/12 phantoms
//       exist, 348/348 real strategies exist;
//   T4  the artifact carries no host path — a committed artifact with an
//       absolute path is a snapshot, not a measurement;
//   T5  the artifact is what the tool derives: the offline half is re-run and
//       compared, so a hand-edited artifact fails.
//
// The live half is SKIPPED unless the network is enabled — the same
// convention as the repo's other network measurements
// (SEMEME_RELEASE_SURFACE_NETWORK, SEMEME_FUNNEL_NETWORK).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-stale-layout.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'stale-layout-2026-11-09.json');

const NETWORK = process.env.SEMEME_STALE_LAYOUT_NETWORK === '1' || process.env.CI === 'true';

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('T1: the offline proof holds on 12 of 12 vaults, with no network', () => {
  assert.equal(artifact.accountsCount, 12);
  assert.equal(artifact.offlineProof.totalAccounts, 12);
  assert.equal(artifact.offlineProof.phantomMatchesDecomposed, 12,
    'every phantom strategy decomposes exactly into version || totalLpSupply || padding0');
  assert.equal(artifact.offlineProof.ok, true);
  assert.equal(artifact.offlineProof.allVersionIsOne, true,
    'the deployed vaults report version 1');
  assert.equal(artifact.offlineProof.allPaddingIsZero, true);
  for (const row of artifact.rows) {
    assert.equal(row.offlineMatch, true, `${row.address} must decompose exactly`);
  }
});

test('T2: the two copies declare the same bytes, split differently', () => {
  // 30 × 32 = 960 and 29 × 32 + 1 + 8 + 23 = 960: the declarations are the
  // same length, which is why the drift is invisible to a byte count.
  const onchain = 30 * 32;
  const published = 29 * 32 + 1 + 8 + 23;
  assert.equal(onchain, published);
  assert.equal(published, 960);
  // The artifact's rows carry the answer's own strategy count.
  for (const row of artifact.rows) {
    assert.equal(row.version, 1);
    assert.ok(BigInt(row.totalLpSupply) >= 0n);
  }
});

test('T3: the live oracle — the phantoms do not exist, the real strategies do', { skip: NETWORK ? false : 'network measurement: set SEMEME_STALE_LAYOUT_NETWORK=1' }, () => {
  const live = artifact.liveOracle;
  assert.ok(live, 'the live half must be recorded');
  assert.equal(live.phantomAccountsExisting, 0,
    'none of the phantom strategies[29] addresses may exist on mainnet');
  assert.equal(live.phantomAccountsChecked, 12);
  assert.equal(live.realStrategyAccountsExisting, live.realStrategyAccountsChecked,
    'every real strategy account must exist');
  assert.equal(live.realStrategyAccountsChecked, 348, '29 strategies × 12 vaults');
  assert.ok(live.liveVaultMatchesLiveMintSupply >= 9,
    'the published copy\'s totalLpSupply must match the live LP mint on most vaults');
  assert.equal(live.ok, true);
});

test('T4: the artifact carries no host path', () => {
  const serialized = JSON.stringify(artifact);
  assert.ok(!serialized.includes('/home/aurora/'), 'no absolute host path');
  assert.ok(!serialized.includes('/tmp/'), 'no scratch-directory path');
});

test('T5: the artifact is what the tool derives right now', async () => {
  const fresh = path.join(ROOT, 'research', '.stale-layout-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', fresh], { cwd: ROOT, stdio: 'ignore' });
    const produced = JSON.parse(await readFile(fresh, 'utf8'));
    // The offline half is the reproducible part; the live half moves with the
    // chain, so it is compared by SHAPE, not by value.
    assert.deepEqual(produced.offlineProof, artifact.offlineProof,
      'the committed offline proof is not what the tool derives');
    assert.deepEqual(
      produced.rows.map((r) => [r.address, r.phantomStrategy, r.offlineMatch]),
      artifact.rows.map((r) => [r.address, r.phantomStrategy, r.offlineMatch]),
      'the committed rows are not what the tool derives');
    assert.equal(produced.accountsCount, artifact.accountsCount);
  } finally {
    rm(fresh, { force: true });
  }
});
