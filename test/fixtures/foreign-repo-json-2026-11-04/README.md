# Foreign-repo JSON fixtures (2026-11-04)

Verbatim test fixtures copied from TWO foreign repositories, committed so the
`--rpc-response` `encoding:"json"` path is qualified against what foreign
repositories ACTUALLY hold — their own test fixtures — and so the numbers
pinned in `test/foreign-repo-json-ingest.test.mjs` re-derive from stable bytes.

## Files

| file | source repository | source path |
|---|---|---|
| orca_initialize_pool_v2.json | step-finance-oss/step-ingestooor | crates/parsers/tests/orca/orca_initialize_pool_v2.json |
| sol_orca_swap_tx.json | step-finance-oss/step-ingestooor | crates/parsers/tests/orca/sol_orca_swap_tx.json |
| missing_ata.json | step-finance-oss/step-ingestooor | crates/parsers/tests/jupiter/missing_ata.json |
| swap_mu.json | step-finance-oss/step-ingestooor | crates/parsers/tests/meteora_amm/swap_mu.json |
| farm_deposit.json | step-finance-oss/step-ingestooor | crates/parsers/tests/kamino/farm_deposit.json |
| withdraw_close_all.json | step-finance-oss/step-ingestooor | crates/parsers/tests/meteora_dlmm/withdraw_close_all.json |
| transfer_transaction.json | CryptGodSon/Solana-Explorer | tests/fixtures/transfer_transaction.json |
| LICENSE | both repositories | MIT, both notices included verbatim |

(step-ingestooor commit 001cf39 "Initial reference source snapshot";
Solana-Explorer commit 9e465e8. Both MIT, notices in LICENSE.)

## Why these six + one

step-ingestooor holds 122 transaction fixtures (1.5 MB of real mainnet
transactions, 1,541 instructions). The six chosen here maximize watched
payloads per byte while spanning five different protocol families (Whirlpool,
Jupiter v6, Meteora DAMM, Kamino Lend, Meteora DLMM) plus the Solana-Explorer
transfer fixture, and they exercise both reported versions (`legacy` and `0`)
and the lookup-table-in-accountKeys shape.

## Measured facts (2026-11-04, before the fix)

- sememe's `--rpc-response` accepted ONLY the default `encoding:"base64"`
  shape. Run on ANY of these fixtures it exited 2:
  `not-an-rpc-response: no RPC result found`.
- All 122 step-ingestooor fixtures are `encoding:"json"` getTransaction
  results: instruction `data` as base58, `programId` spelled out on every
  instruction (1,541/1,541; zero `programIdIndex`), 932 of 1,541 instructions
  already `parsed` by the chain with NO bytes in the document, 69/122
  transactions with address-table keys already expanded inside
  `message.accountKeys` (`source: "lookupTable"`), and `meta.loadedAddresses`
  absent.
- CryptGodSon/Solana-Explorer holds the same shape
  (transfer_transaction.json, slot 311234567).

The full-suite qualification lives in `test/foreign-repo-json-ingest.test.mjs`.
