# Store `traffic-sample-store-2026-11-04-pulled` (2026-11-04)

The foreign-used fixture store of `test/fixtures/traffic-sample-store-2026-11-04`,
augmented by the measured acquisition this directory pins
(`test/batch-pull.test.mjs`, `research/batch-pull-2026-11-04.json`).

## Contents

- 55 on-chain receipts: the 21 receipts of the base store PLUS the 34 IDLs the
  acquisition-gap classifier had measured as `pullable` (live mainnet, slots
  465308534/465308538, batched `getMultipleAccounts` through
  `tools/batch-pull.mjs` — one write path with `sememe pull`, `installIdl` in
  src/pull.mjs).
- 13 `published` receipts: first-party IDL copies adopted from the foreign
  repository step-finance-oss/step-ingestooor (MIT, commit 001cf39,
  crates/idl-gens/idls/*.json). Each receipt records its `origin` filename.
  These are provenance of BYTES, not proof the bytes describe the deployed
  program — the union decode arbitrates between on-chain and published by
  byte evidence (src/union.mjs).

The 13 adopted programs (files from crates/idl-gens/idls/):
jup_dca.json, kamino_farms.json, hubble_lending.json, nx_leverage.json,
dflow.json, kamino_vaults.json, jup_perps.json, marginfi.json,
meteora_farms.json, defituna.json, tr_referrals.json, jupiter_staking.json,
flash_trade.json.

## Why

The gap artifact (research/acquisition-gap-2026-11-04.json) classified the
foreign sweep's 306 no-interface payloads: 177 sat behind 34 programs that
publish an on-chain IDL sememe never pulled, 129 behind programs that publish
nothing. After the acquisition and the union with the 13 published copies,
the same 156-fixture sweep measures (research/step-ingestooor-full-sweep-pulled-2026-11-04.json):

- noInterface 306 -> 129 (only the publish-nothing programs remain)
- decoded 493 -> 661, byte-exact 100%, disagreements 0
- decodeErrors 7 -> 16: every remaining refusal is named (deployed-newer
  discriminators, stale IDL layouts, unwitnessed short forms)

## License

The 13 adopted IDL copies are MIT-licensed content of
step-finance-oss/step-ingestooor (commit 001cf39); the verbatim MIT notice
lives in ../foreign-repo-json-2026-11-04/LICENSE. The on-chain pulls are
facts read from the Solana chain, content-addressed and receipt-bound.
