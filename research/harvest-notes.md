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

- `test/fixtures/harvest-whirlpool-2026-10-28.json` (662 KB) preserves every transaction that carries a Whirlpool payload (1,029 transactions, 1,119 payloads), along with the slot range, the metadata, and an explicit `signatures` array.
- Any caller with RPC access can re-derive the payloads from the pinned signature list using:
  ```
  node tools/harvest.mjs --from-signatures test/fixtures/harvest-whirlpool-2026-10-28.json --out rederived.json
  ```
- `tools/tx-diff.mjs` consumes this fixture and produces the full diff against `@orca-so/whirlpools-client` in under 2 seconds.

## Which signature list re-derives a harvest (and the bug found here)

There are two candidate lists in a harvest document, and they are **not** the same set:

- `transactions` — the transactions the harvest actually read, i.e. the payload set.
- `signatures` — the `getSignaturesForAddress` page that selected which blocks to read.

Measured on this repo's own harvest: **only 298 of the 1,029 payload-bearing transactions appear in that page**. The reason is the CPI placement finding above: a transaction that reaches Whirlpool only through a CPI does not list Whirlpool in its own account keys, so it never shows up in `getSignaturesForAddress(whirlpool)`. The page is a *sampling frame* for blocks, not a description of the payloads.

Two defects were found and fixed against the committed fixture on 2026-10-28, both of the "looks successful, measures nothing" class:

1. The fixture had no top-level `signatures` array at all, so the documented `--from-signatures` command resolved to an empty list, harvested zero transactions, and then crashed on `usedSlots.length`. The command was in `README.md` and in these notes — i.e. the published reproducibility claim did not work.
2. The harvester pinned `harvest.pinned`, the signature *page*, rather than the transactions it read. A file re-derived that way would re-derive a different, smaller sample while reporting a successful run.

Fixes: `tools/lib/pinned.mjs` resolves the list from the transaction records (the payload set) first, falls back to a declared `signatures` array, and **throws** when a document pins nothing instead of returning an empty list. `tools/harvest.mjs` pins the transactions it read, and refuses to write an empty harvest. The committed fixture now carries an explicit `signatures` array with one entry per transaction it keeps. Covered by `test/pinned.test.mjs` (5 tests): the committed fixture pins exactly the transactions it carries (both directions, no partial list), transaction records win over a declared list, and a document that pins nothing is refused rather than resolving to empty.

## A partial fetch is not a reproduction

A public RPC rate-limits, so a re-derivation can come back incomplete: 37 of 40 transactions fetched, the rest marked `missing` with the RPC error. That run still writes a file and still exits 0, which is indistinguishable from a reproduction unless something compares the two.

`tools/lib/rederive-verify.mjs` makes the comparison explicit, and `--verify` wires it into the CLI:

```
node tools/harvest.mjs --from-signatures test/fixtures/harvest-whirlpool-2026-10-28.json \
  --out rederived.json --verify test/fixtures/harvest-whirlpool-2026-10-28.json
```

It reports `pinned`, `fetched`, `missing`, `payloadSetsChecked`, `payloadSetsMatched` and `mismatched`, and exits non-zero unless every pinned transaction came back with byte-identical payloads. `payloadBytesMatched` is a claim about the whole pinned set, not about what happened to arrive — a partial fetch that matches perfectly on the transactions it got still does not claim byte-exactness. Covered by `test/rederive-verify.test.mjs` (5 tests), including the negative controls: a rate-limited fetch, a changed payload byte, and a dropped payload each fail the comparison.

Measured on 2026-10-28 against live mainnet: a 15-transaction subset re-derived completely (15/15 fetched, 17 payloads, all byte-identical, exit 0), and a tampered payload made the same command exit 1 with `payload 0 dataHex differs`.

## Final results

The first run (243 blocks, 75,685 transactions, 793 payloads) was superseded by a second, larger run with signature paging (148 blocks from 3,309 paged signatures, 40,013 transactions, 1,119 payloads from 1,029 payload-bearing transactions) which is what the committed fixture contains. Both runs agreed on the decoding results: zero errors, zero disagreements, zero byte mismatches.
