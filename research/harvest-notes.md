# Mainnet Harvest Notes (2026-10-28)

## Why block harvest instead of getTransaction

The public mainnet RPC (`api.mainnet-beta.solana.com`) hard-throttles per-transaction calls: empirical testing of batched `getTransaction` requests across 12 consecutive rounds produced 9 successes and 111 `HTTP 429 Too Many Requests` responses (a 7.5% success rate). Reaching 1,000 transactions over individual RPC calls is rate-limited into multihour stalls.

`getBlock`, by contrast, returns hundreds of transactions in a single call (measured: 200–330 transactions per finalized block, latency ~0.3s). Because Whirlpool transactions are dense on mainnet (the program is invoked in a large fraction of aggregator and router calls), harvesting by block is both orders of magnitude faster and the only shape that reaches 1,000-scale transactions on a public endpoint without paid infrastructure.

## How the harvest picks blocks

A naive walk backwards from the tip would waste most calls on blocks with no Whirlpool traffic. `tools/harvest.mjs` instead:
1. Calls `getSignaturesForAddress` once (measured ~0.3s for 1,000 entries) to get the newest transactions referencing the program.
2. Deduplicates their slot numbers into an ordered list of blocks known to contain this program's traffic.
3. Fetches those specific blocks in parallel (concurrency 2, rate-limited sleep between rounds) via `getBlock` with `maxSupportedTransactionVersion: 1` and `commitment: "finalized"`.
4. Extracts every instruction of the target program from each block, top-level and CPI alike.

## Instruction resolution in the JSON encoding

Two real extraction bugs were found and fixed during implementation (covered by `test/payloads.test.mjs`):

1. **`programIdIndex` resolution:** in `encoding: "json"`, instructions do not spell out `programId`. They carry a `programIdIndex` into the transaction's account list. For versioned transactions (v0/v1), the account list is the static keys followed by the address lookup table entries:
   ```
   accounts = staticKeys + loadedAddresses.writable + loadedAddresses.readonly
   ```
   An extractor that looks only for `instruction.programId` or only at static keys silently returns zero payloads for almost all modern mainnet transactions.

2. **CPI placement:** in the JSON encoding, inner instructions live under `meta.innerInstructions`, not `message.innerInstructions`. Because Whirlpool is almost exclusively invoked via CPI on mainnet (routers such as Jupiter, aggregator CPIs), dropping `meta.innerInstructions` understates the actual payload count by ~99%.

## Re-derivation and compactness

The full harvest of 40,013 transactions across 148 blocks is a 10 MB file (`/tmp/harvest-1000b.json`). To keep the repository small while retaining full reproducibility:

- `test/fixtures/harvest-whirlpool-2026-10-28.json` (508 KB) preserves every transaction that carries a Whirlpool payload (1,029 transactions, 1,119 payloads), along with the slot range and metadata.
- Any caller with RPC access can re-derive the payloads from the pinned signature list using:
  ```
  node tools/harvest.mjs --from-signatures test/fixtures/harvest-whirlpool-2026-10-28.json --out rederived.json
  ```
- `tools/tx-diff.mjs` consumes this fixture and produces the full diff against `@orca-so/whirlpools-client` in under 2 seconds.

## Final results

The first run (243 blocks, 75,685 transactions, 793 payloads) was superseded by a second, larger run with signature paging (148 blocks from 3,309 paged signatures, 40,013 transactions, 1,119 payloads from 1,029 payload-bearing transactions) which is what the committed fixture contains. Both runs agreed on the decoding results: zero errors, zero disagreements, zero byte mismatches.
