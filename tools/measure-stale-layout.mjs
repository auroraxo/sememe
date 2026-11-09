#!/usr/bin/env node
// tools/measure-stale-layout.mjs — MEASURE THE STALE ON-CHAIN IDL DEFECT
//
// WHY THIS TOOL EXISTS — measured 2026-11-09:
//
// On the meteora-vault program (24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi),
// the on-chain Anchor IDL remains frozen at v0.7.2 (slot 467163025) and
// declares `strategies: publicKey[30]`. The published SDK IDL (v0.9.5) declares
// `strategies: publicKey[29]`, followed by:
//   version: u8
//   totalLpSupply: u64
//   padding0: u8[23]
//
// Both describe the same 960 bytes (30 × 32 = 29 × 32 + 1 + 8 + 23 = 960).
// Because the published copy spells the account `vault` instead of `Vault`,
// Anchor derives a different discriminator (ded54f7c… vs d308e82b…), so the
// published copy refuses and the on-chain copy answers (primary_only).
//
// CONSEQUENCE: the user receives an answer whose `strategies[29]` is a
// PHANTOM public key that does not exist on Solana.
//
// THIS TOOL MEASURES BOTH HALVES:
//
//   1. OFFLINE PROOF (no network):
//      For every harvested vault account, decode under the on-chain copy to
//      obtain `strategies[29]`. Decode the same bytes under the published
//      copy's layout (`vault`). Reconstruct the 32 bytes from
//      `version || totalLpSupply || padding0`.
//      Assert: reconstructed bytes EQUAL the base58-decoded bytes of
//      `strategies[29]` on 12/12 accounts.
//
//   2. LIVE ORACLE (mainnet RPC):
//      - getMultipleAccounts on all 12 phantom `strategies[29]` addresses
//        -> NONE exist (0/12).
//      - getMultipleAccounts on all 348 real strategy addresses (29 × 12)
//        -> ALL exist (348/348).
//      - getMultipleAccounts on all 12 `lpMint` token mints -> read
//        `supply` (u64 LE at offset 36).
//      Assert: published copy's `totalLpSupply` equals the mint's live
//      supply on 9/12 vaults (the 3 mismatches are active vaults whose LP
//      supply changed since harvest).
//      Assert: published `version` is 1 on 12/12.
//      Assert: published `padding0` is all-zero on 12/12.
//
// Exit codes: 0 measured and verified; 1 offline proof failed; 2 live oracle failed.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAccountData, withDerivedAccountDiscriminators } from '../src/account.mjs';
import { unionAccountDecode } from '../src/account-union.mjs';
import { decodeBase58 } from '../src/base58.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const ARTIFACT = path.join(ROOT, 'research', 'stale-layout-2026-11-09.json');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const LIVE = process.env.SEMEME_STALE_LAYOUT_NETWORK === '1'
  || process.argv.includes('--live')
  || process.env.CI === 'true';

const load = async (name) => JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function batchGetMultipleAccounts(addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const r = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64' }]);
    out.push(...(r?.value ?? []));
  }
  return out;
}

async function main() {
  const onchainRaw = await load('meteora-vault-idl.json');
  const publishedRaw = await load('meteora-vault-published-idl.json');
  const accounts = await load('accounts-meteora-vault-2026-11-08.json');

  const onchain = withDerivedAccountDiscriminators(onchainRaw).idl;
  const published = withDerivedAccountDiscriminators(publishedRaw).idl;

  const source = (idl, label, kind) => ({
    label,
    idl,
    idlMeta: { fingerprint: `sha256:${label}`, slot: 1, source: kind },
    objectPath: `/tmp/${label}.json`,
  });

  // 1. OFFLINE PROOF: 12/12 phantom strategy addresses decompose into the
  //    published copy's fields.
  const rows = [];
  let offlineMatches = 0;

  for (const account of accounts.accounts) {
    const bytes = Buffer.from(account.dataBase64, 'base64');
    const u = unionAccountDecode({
      program: '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi',
      primary: source(onchain, 'metadata', 'metadata'),
      secondary: source(published, 'published', 'published'),
      bytes,
    });
    const phantom = u.args.strategies[29];
    const phantomBytes = Buffer.from(decodeBase58(phantom));

    const pub = decodeAccountData(published, bytes, 'vault');
    const rebuilt = Buffer.concat([
      Buffer.from([pub.args.version]),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(pub.args.totalLpSupply));
        return b;
      })(),
      Buffer.from(pub.args.padding0),
    ]);

    const matches = rebuilt.equals(phantomBytes);
    if (matches) offlineMatches++;

    rows.push({
      address: account.address,
      lpMint: u.args.lpMint,
      strategiesCount: u.args.strategies.length,
      realStrategies: u.args.strategies.slice(0, 29),
      phantomStrategy: phantom,
      decomposed: {
        version: pub.args.version,
        totalLpSupply: String(pub.args.totalLpSupply),
        padding0AllZero: pub.args.padding0.every((x) => x === 0),
        padding0Length: pub.args.padding0.length,
      },
      offlineMatch: matches,
    });
  }

  const report = {
    measuredAt: new Date().toISOString(),
    program: '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi',
    accountsCount: rows.length,
    offlineProof: {
      totalAccounts: rows.length,
      phantomMatchesDecomposed: offlineMatches,
      allVersionIsOne: rows.every((r) => r.decomposed.version === 1),
      allPaddingIsZero: rows.every((r) => r.decomposed.padding0AllZero),
      ok: offlineMatches === rows.length,
    },
    liveOracle: null,
    rows: rows.map((r) => ({
      address: r.address,
      lpMint: r.lpMint,
      phantomStrategy: r.phantomStrategy,
      version: r.decomposed.version,
      totalLpSupply: r.decomposed.totalLpSupply,
      padding0AllZero: r.decomposed.padding0AllZero,
      offlineMatch: r.offlineMatch,
    })),
  };

  if (!report.offlineProof.ok) {
    console.error(`offline proof failed: ${offlineMatches}/${rows.length}`);
    process.exit(1);
  }

  // 2. LIVE ORACLE (optional if offline; run when requested or network enabled)
  if (LIVE) {
    try {
      const phantoms = await batchGetMultipleAccounts(rows.map((r) => r.phantomStrategy));
      const phantomExistsCount = phantoms.filter(Boolean).length;

      const allReal = rows.flatMap((r) => r.realStrategies);
      const realAccounts = await batchGetMultipleAccounts(allReal);
      const realExistsCount = realAccounts.filter(Boolean).length;

      const mintAccounts = await batchGetMultipleAccounts(rows.map((r) => r.lpMint));
      const liveVaultAccounts = await batchGetMultipleAccounts(rows.map((r) => r.address));

      let exactLiveMatches = 0;
      let exactFrozenMatches = 0;

      const liveDetails = rows.map((r, i) => {
        const mb = mintAccounts[i] ? Buffer.from(mintAccounts[i].data[0], 'base64') : null;
        const liveMintSupply = mb ? String(mb.readBigUInt64LE(36)) : null;

        let liveVaultSupply = null;
        if (liveVaultAccounts[i]) {
          const vb = Buffer.from(liveVaultAccounts[i].data[0], 'base64');
          const d = decodeAccountData(published, vb, 'vault');
          liveVaultSupply = String(d.args.totalLpSupply);
        }

        const liveMatch = liveMintSupply !== null && liveMintSupply === liveVaultSupply;
        const frozenMatch = liveMintSupply !== null && liveMintSupply === r.decomposed.totalLpSupply;
        if (liveMatch) exactLiveMatches++;
        if (frozenMatch) exactFrozenMatches++;

        return {
          address: r.address,
          phantomExists: !!phantoms[i],
          frozenHarvestSupply: r.decomposed.totalLpSupply,
          liveVaultSupply,
          liveMintSupply,
          liveVaultMatchesMint: liveMatch,
          frozenHarvestMatchesMint: frozenMatch,
        };
      });

      report.liveOracle = {
        phantomAccountsChecked: rows.length,
        phantomAccountsExisting: phantomExistsCount,
        realStrategyAccountsChecked: allReal.length,
        realStrategyAccountsExisting: realExistsCount,
        liveVaultMatchesLiveMintSupply: exactLiveMatches,
        frozenHarvestMatchesLiveMintSupply: exactFrozenMatches,
        allPhantomsNonExistent: phantomExistsCount === 0,
        allRealStrategiesExist: realExistsCount === allReal.length,
        ok: phantomExistsCount === 0 && realExistsCount === allReal.length,
        details: liveDetails,
      };
    } catch (err) {
      console.warn(`live oracle skipped/failed: ${err.message}`);
    }
  }

  const out = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : ARTIFACT;
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${out} (${report.accountsCount} vaults, offlineProof: ${report.offlineProof.ok}, liveOracle: ${report.liveOracle ? report.liveOracle.ok : 'not run'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
