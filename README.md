# sememe

A local meaning layer for Solana bytes. `sememe pull <program>` fetches and verifies a program interface; every process on the machine can then decode instructions, accounts, and events offline.

**Status: pull/store plus an offline decoder for instructions and Anchor event self-CPIs, both runnable (October 2026), verified against four real mainnet programs (Whirlpool, Jupiter AMM v6, Kamino Lend and OpenBook v2), with one own repository reading it for both checking and producing recipes (`solana-tx-remix`), no external users.** The 20-program coverage qualification does not show demand or general ecosystem coverage. Lockfiles, catalog import and daemon are still proposals.

## The idea

"What do these bytes mean?" is currently either a paid cloud feature or a decoder rebuilt inside every repository. Vendored IDL files are snapshots without provenance, a fingerprint, or a freshness check.

sememe is a local, content-addressed schema store with a verification contract:

- **pull:** fetch an interface from an on-chain IDL, a curated catalog, or a local file.
- **validate:** fingerprint the canonical form, check discriminator uniqueness, cross-check the chain where possible, and tolerate Anchor IDL format changes.
- **resolve (now implemented for instruction data):** decode and encode locally from the stored IDL, with strict errors instead of guesses. A program without a trustworthy source stays explicitly unverifiable.
- **store:** keep records under `~/.sememe/`; `sememe.lock` pins exact fingerprints per project.
- **resolve:** decode and encode locally, with strict errors instead of guesses. A program without a trustworthy source stays explicitly unverifiable.

## Working now: pull a program's on-chain IDL

```bash
npm ci
npm test
node bin/sememe.mjs pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --store /tmp/sememe-demo
# optional: --rpc https://your-mainnet-rpc.example
```

The CLI fetches the canonical Program Metadata and legacy Anchor IDL accounts at a finalized RPC slot, checks account owner/program binding and JSON instruction shape, prefers canonical when both exist, and stores normalized JSON by SHA-256 under `<store>/objects/`. A receipt under `<store>/receipts/` records program ID, source account address, slot, fingerprint and instruction count. Repeating the pull of identical content does not rewrite the stored object; corrupt files are refused rather than overwritten. A public Whirlpool pull succeeded on 27.10. at slot 462039125 with 66 named instructions and fingerprint `sha256:0b886e375b112206a846a061f076f7db02a4b01b25cd593cd03caa490d86660f` (own run; no outside use).

**Limit:** This is acquisition and content-addressed storage, not an independent audit of the on-chain ABI, offline resolver, freshness guarantee or authority check. Fetch responses are trusted to the configured RPC; first-party repo parity has not been established. Account and event decoding, `resolve`, `decode-tx`, `lock`, `diff` and the optional local daemon remain proposals; only instruction data is decoded today. A later Rust core/TypeScript SDK may replace this Node-based prototype; neither exists yet.

## Working now: decode instruction data offline from the stored IDL

```bash
node bin/sememe.mjs decode whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc \
  2b04ed0b1ac91e62... --store /tmp/sememe-demo   # payload: base58 or hex
```

`src/codec.mjs` reads the byte layout from the stored IDL itself — no generated code and no third-party codec library — and covers primitives, `option`, `vec`, `array`, `defined` struct/enum types, and both unit, tuple and named enum variants. It is deliberately strict: unknown discriminators, unknown variants, invalid `option` tags, invalid bool bytes, out-of-range integers, unknown types and unknown arguments are errors rather than silent coercions, and hostile field names can never pollute prototypes. Decoded values are JSON-safe: 64/128-bit integers become decimal strings, pubkeys become base58, and re-encoding the decoded value must reproduce the input bytes byte-for-byte (`roundTripByteExact`).

**Bytes the IDL does not describe are reported, not guessed and not dropped.** A payload can carry more bytes than the stored IDL explains; sememe decodes the described prefix and returns the remainder under `trailing: {count, hex}`, with `describedRoundTripByteExact` covering the part the IDL does describe. `--trailing error` (or `{trailing: 'error'}`) restores whole-payload refusal when a caller wants it.

This default was changed by a measurement, not by preference. Two real mainnet `swap_v2` payloads are 50 bytes where the stored IDL accounts for 43; the previous behaviour refused them outright. Checks against both references said they were valid:

- Both transactions **succeeded on-chain** (`meta.err = null`, slot 462101502), and the 43-byte form of the same instruction also succeeds (slot 462101506), so the deployed program accepts both lengths. Anchor deserialises instruction args with Borsh `deserialize` over a slice, which reads what the struct needs without requiring the slice to be exhausted.
- **Orca's own `@orca-so/whirlpools-client` decoder accepts both payloads and returns the same argument values** sememe returns.

So refusing them rejected 2 of 50 real, successful mainnet payloads — a decoder that fails on valid traffic cannot replace the first-party path it is meant to replace. `trailing.count` still makes unexplained bytes impossible to overlook: the CLI prints a note to stderr, `tools/crosscheck.mjs` reports them under `unexplained`, and `trailing.count === 0` remains a usable completeness assertion. All 2 unexplained tails observed so far are zero bytes (padding); a non-zero tail would mean the IDL is missing a real field, which the test suite asserts separately.

The fidelity claim was tested against two independent references rather than assumed:

- **Real mainnet bytes:** 50 harvested Whirlpool instruction payloads (8 distinct instructions: `swap`, `swap_v2`, `collect_fees`, `collect_fees_v2`, `decrease_liquidity`, `decrease_liquidity_v2`, `close_position_with_token_extensions`, `update_fees_and_rewards`) decode from the stored IDL with byte-exact re-encoding of the described part, pinned in `test/fixtures/mainnet-whirlpool.json` so the suite keeps re-proving it. Every payload in that fixture was re-verified byte-for-byte against `getTransaction` on mainnet (50/50 matched, 0 mismatches), so the fixture is not a transcription of trusted input.
- **External oracle cross-check:** `tools/crosscheck.mjs` compares sememe against `@orca-so/whirlpools-client` for **all 66 Whirlpool instructions** (oracle-generated bytes → sememe decode → sememe re-encode) plus the same 50 real payloads, checking both byte identity and field-by-field values. Latest run: **66/66 instructions and 50/50 payloads with 0 byte mismatches, 0 value mismatches, 0 errors.** The oracle is used as a test oracle only under the Orca License; nothing from it is vendored into this repository, and it is an optional dependency of the tool.

**Limits of this evidence:** it covers one Anchor program's instruction data on mainnet traffic. Account layouts were untested here and are covered separately below (three programs, 39 real accounts); `repr(C)`/`packed` account types are not decoded yet, and byte-exact agreement with a reference codec shows layout fidelity — not that anyone outside this machine uses sememe. The 50-payload fixture sample was originally the evidence limit; that limit is now closed at scale (see "Verified against an external oracle at scale" below). Run `npm test` and `SEMEME_ORACLE_PATH=<dir>/node_modules node tools/crosscheck.mjs --store <store>` to reproduce. The mainnet-payload tests no longer depend on a live store: the IDL snapshot in `test/fixtures/whirlpool-idl.json` is re-fingerprinted against its receipt on every run, so they execute on a fresh checkout and in CI instead of skipping.

## Compared against my own existing Whirlpool decoder

`tools/decoder-parity.mjs` runs sememe's stored-IDL codec and `solana-tx-remix`'s own first-party Whirlpool decoder path (`src/args.mjs`) over the same 50 real mainnet payloads and compares them field by field. That decoder is the one this repository is supposed to make replaceable, so it is the honest baseline. `disagreed` counts only fields both paths decoded to different values; fields the first-party path declines to decode are counted separately as `firstPartyRefuses`, because a missing value is not a disagreement.

Measured on 27.10. (reproduce: `node tools/decoder-parity.mjs --store <store> --tx-remix <dir> --generated <dir>`):

- **226 of 226 fields both paths decode agree, 0 value disagreements** (50 payloads).
- **0 fields only one side has** — no silent drift in the other direction either.
- **36 field instances the first-party path refuses to decode** (it stops at `option` and defined-type arguments and emits `__optionRemaining`/`__unsupportedDecoder` instead of a value); sememe decodes them, e.g. `remaining_accounts_info: {"__option":"None"}` vs `{"__optionRemaining":"AA=="}`. These are the `option`/`defined`-typed arguments of 17 of 66 Whirlpool instructions (`swap_v2`, `decrease_liquidity_v2`, `open_position`, `lock_position`, …). The count is instances across payloads, not distinct fields.
- The first-party path finds schemas for 65 of 66 instructions (19 have no generated schema file at all).

So the first comparison is exact where both paths overlap, and sememe additionally decodes what that path declines to decode. That clears this repository's own stated gate for the next step.

## One own decoder path is migrated

`solana-tx-remix` now reads the stored sememe artifact for BOTH halves of its single-program Whirlpool path: the verifier decodes arguments from it, and the emitter produces recipes from it (`solana-tx-remix` commits, 28.10). The earlier status — verifier only, emitter still on generated codecs — is superseded. The rest of the paragraph above still holds: other decoder paths, 1,000 transactions, an outside user — none of that has happened.

What was actually measured, on that repository's own flagship recipe `out/remix-6754RLWd.ts` (7 Whirlpool instructions, one real mainnet transaction):

- **The recipe verifies on a fresh clone.** It was `SKIP` in CI for want of an external codec directory; it now passes, all 18 negative controls still failing as declared.
- **The two decoders cross-check each other**: 7 instructions, 24 fields compared, 17 exact agreements, 7 fields the generated path refuses, **0 disagreements**, and 7/7 instruction names agreeing.
- **The bytes now name themselves.** Relabelling `SWAP_V2` as `SWAP` (bytes untouched) was `PASS` for the old verifier and is `FAIL` for the new one — the old one looked the layout up *by* the label, so a false label found a false layout.
- **The artifact is verified, not trusted**: `sha256(canonicalJson(idl) + '\n')` must equal the receipt's fingerprint, re-checked before every decode. Tampering with the stored object is caught and reported as a failure rather than silently falling back to the other decoder — the first version of the verifier did exactly that (found the damage, then printed `PASS`), which was caught by tampering with the store on purpose. That tampering is now performed on purpose by the consumer's own acceptance run, every push: it copies the intact store, edits one argument type so the object still parses as valid JSON, and requires the recipe to fail. Re-disabling the fix makes that check fail loudly, which is how it was shown to be a real control rather than a passing line.

Two enabling changes were needed on this side, both landed and tested:

- **The decode core has no npm dependencies.** `src/base58.mjs` replaces the only third-party import in the decode path (`@solana/web3.js`, used solely to base58 32 raw bytes), and `src/canonical.mjs` holds `canonicalJson` so a consumer can re-check a fingerprint without pulling in the acquisition path. A consumer repository with no `package.json` and no `node_modules` can import the decoder directly — which is what makes the migration above possible without vendoring a copy that could drift. `test/deps.test.mjs` keeps that property: the decode core must import nothing outside `node:` builtins and its own files, and everything else in `src/` must stay within an explicit allowlist. Parity with `@solana/web3.js` is checked on 202 vectors.
- **`canonicalJson` moved out of the pull path** and is still re-exported from `src/pull.mjs`, so nothing that imports it from there changed.

Honest limits: `solana-tx-remix` is my own repository, so this is one consumer I wrote, not an outside user. It is one program (Whirlpool) and one recipe (7 instructions, one transaction), not 1,000 transactions. Nothing here shows ecosystem coverage or demand.

## Both halves of that consumer now read the artifact

The first migration covered the VERIFIER: it re-derives Whirlpool arguments from the pinned IDL. The EMITTER — the code that produces a recipe in the first place — was still reading Codama-generated codec modules that are not in that repository, so a fresh clone exited with "Whirlpool codec directory not found" before it could name a single argument. It now reads the same artifact (`src/sememe-idl-source.mjs` in `solana-tx-remix`), which changed three things, all measured:

- **The tool can produce a recipe on a fresh clone.** The flagship `out/remix-6754RLWd.ts` was re-emitted from the stored IDL. What the verifier reads — `ACCOUNTS`, `LOOKUP_TABLE_ADDRESSES`, `INSTRUCTION_BYTES`, `INNER_BYTES` — is byte-identical to the previous recipe, and the `.json` is unchanged: the transaction did not move, only the description of it got more accurate.
- **The stored IDL names more instructions.** It carries all 57 discriminators the generated directory carries, with identical names, and 9 it does not have at all (`close_position_with_token_extensions`, `initialize_position_bundle_with_metadata`, `set_reward_authority_by_super_authority`, …). Those instructions could not be named even with the codecs on disk.
- **The argument names are the program's own.** `IX6_SWAP_V2_SQRT_PRICE_LIMIT` rather than `IX6_SWAP_V2_SQRTPRICELIMIT`, and `remaining_accounts_info` reads `{"__option":"None"}` rather than the raw `{"__optionRemaining":"AA=="}` the generated path declined to interpret.

The `absent`/`broken` distinction is kept on this side too: an absent store falls back to the generated codecs (or exits naming both sources when neither exists), while a store that is present and does not verify is a hard stop — a damaged artifact must not silently become another source's names.

## Verified against an external oracle at scale (1,000-transaction scale)

The earlier evidence compared 50 harvested payloads. That was a small sample, and "50 payloads, not 1,000 transactions" was the explicitly stated limit of the qualification.

Tools added on 2026-10-28:
- `tools/harvest.mjs`: reproducible bulk harvest over real mainnet blocks. It queries `getSignaturesForAddress` to identify slots that carry the program, fetches full finalized blocks via `getBlock`, and extracts every instruction of the target program (top-level and CPI). Instructions in the JSON encoding resolve through `programIdIndex` against the transaction's static and loaded address tables, and inner instructions are parsed from `meta.innerInstructions` (two real extraction bugs caught and covered by `test/payloads.test.mjs`). The harvest pins the transactions it actually read, so any caller can re-derive the payloads with `--from-signatures`.
- `tools/tx-diff.mjs`: cross-decoder diff across all harvested transactions against `@orca-so/whirlpools-client` (Orca License, used only as a test oracle, nothing vendored).

For every payload, the diff answers three separate questions:
1. **Naming:** does the oracle's encoder reproduce the bytes sememe names the instruction with? (The oracle's per-instruction decoders do not validate discriminators, so the honest naming oracle is the encoder round-trip: the one instruction whose encoder reproduces the bytes is the true name.)
2. **Values:** field-by-field equality across every argument the IDL declares, with known representation differences (camelCase, hoisted structs, unit enums) handled explicitly.
3. **Bytes:** re-encoding the decoded values reproduces the IDL-described prefix byte-for-byte. Trailing bytes the IDL does not describe are tracked separately under `unexplained`.

**Measured on real mainnet traffic (run 2026-10-28):**
- **40,013 transactions** scanned across **148 finalized blocks** (slots 462358216..462358364), with **3,309 pinned signatures** collected by paging `getSignaturesForAddress` backwards until enough slots were covered.
- **1,029 transactions** contain Whirlpool payloads, yielding **1,119 instruction payloads** (the vast majority are CPIs inside router and aggregator calls — Whirlpool top-level invocations are rare on mainnet).
- **1,119/1,119 payloads decoded** by sememe (`sememeErrors: 0`).
- **1,119/1,119 naming agreements** (`namingDisagrees: 0`).
- **1,119/1,119 value agreements** across every decoded argument (`valueDisagrees: 0`).
- **1,119/1,119 byte-exact round-trips** of the described prefix (`byteMismatch: 0`).
- **33 unexplained trailing-byte payloads** (2.95%), all `swap_v2`. The earlier 50-payload sample measured 4.0% (2 of 50), so this phenomenon is confirmed present at over 1,000-payload scale while varying somewhat between samples.
- Instructions observed at scale: `swap_v2` (910), `swap` (162), `increase_liquidity_v2` (15), `reposition_liquidity_v2` (12), and single instances of `open_position`, `open_position_with_token_extensions`, `close_position_with_token_extensions`, `collect_fees_v2`, `decrease_liquidity_v2`, `update_fees_and_rewards`.

**Falsification:** the diff tool is proven to fail when defects are introduced:
1. Flipping a byte in instruction data: `sememeErrors: 1`, exit 1.
2. Identical input to both decoders: exit 0 (no false positives).
3. IDL tamper (`swap_v2` `amount_specified_is_input` bool → u8): `valueDisagrees: 34`, exit 1 (`sememe: "1"` vs `oracle: "true"`), while `byteMismatch: 0` remains exact because both types are 1 byte.
4. Swapping `swap` and `swap_v2` discriminators in the IDL: `namingDisagrees: 34`, `sememeErrors: 10`, exit 1.

**Reproducibility:** the committed fixture pins its own payload set. `tools/lib/pinned.mjs` resolves the signature list from the fixture's transaction records first (the payload set itself), falls back to the declared `signatures` array, and throws when a document pins nothing rather than resolving to an empty list. This distinction is measured, not assumed: only **298 of the 1,029** payload-bearing transactions appear in the `getSignaturesForAddress` page, because a transaction that reaches Whirlpool only through a CPI does not list Whirlpool in its own account keys. Pinning the page instead of the payloads would therefore re-derive a different, smaller sample while still reporting success. Two defects on this path were found and fixed on 2026-10-28 (the fixture carried no `signatures` array at all, so the documented command harvested zero and crashed; and the harvester pinned the page), covered by `test/pinned.test.mjs`.

Because the public RPC rate-limits, a re-derivation can also come back **partial** — 37 of 40 transactions fetched — and still write a file and exit 0. `--verify <fixture>` closes that gap: it compares the re-derivation against the fixture and exits non-zero unless every pinned transaction returned byte-identical payloads (`tools/lib/rederive-verify.mjs`, 5 tests). Measured against live mainnet: a 15-transaction subset re-derived completely (15/15, 17 payloads, byte-identical, exit 0); the same command on a tampered payload exited 1 with `payload 0 dataHex differs`.

**Remaining limits:** one Anchor program (Whirlpool); events and (at that point) accounts were still untested; other own decoder paths remain to be migrated; no outside user has adopted sememe yet. But the "50 payloads, not 1,000 transactions" limit is closed: agreement holds across 1,119 real payloads from 1,029 transactions sampled from 40,013 mainnet transactions, with zero value or byte discrepancies.

## Second real program: Jupiter AMM v6 (and two defects it exposed)

Testing against only one program hid a whole class of defects: Whirlpool's enums are simple and its transactions rarely use Anchor event CPIs. On 2026-10-29, sememe pulled Jupiter AMM v6 (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) from mainnet (slot 462867554, 19 instructions, 6 events, fingerprint `sha256:37fa69c115f5883314374e01c4aa8f242778f7aebccd75f5064d6afb0277afee`), harvested **18,193 transactions** across **48 finalized blocks** (slots 462867935..462867982), and decoded every payload referencing the program (313 transactions, **773 payloads**).

Initial run against the existing codec: **only 35 of 773 payloads decoded**. Two real defects were exposed and fixed:

1. **Enum minSize lower bound was inverted:** `minSize` used the *largest* enum variant as the lower bound for an element in a vector. Jupiter's `Swap` enum has 204 variants; variant 47 (`WhirlpoolSwapV2`) needs 85 bytes, so the hostile-length pre-check required at least 85 bytes per element for every `route` instruction. Real payloads carry smaller variants (e.g. 1 byte for unit variants), so **342 payloads were rejected** with `"vector length 1 needs 85 byte(s) but 25 remain"` — even though the payloads themselves decode byte-exact. Fixed: `minSize` takes the *smallest* variant as the lower bound, and options bound at 1 byte (the `None` tag).
2. **Anchor `emit_cpi!` event payloads arrive like instructions:** Anchor programs emit events through a self-CPI with instruction data `EVENT_IX_TAG_LE (8) ++ event_discriminator (8) ++ borsh(fields)`. In a transaction (top-level or CPI) these look identical to instructions, but the discriminator table did not know `EVENT_IX_TAG` (`0x1d9acb512ea545e4`, hex `e445a52e51cb9a1d`), so **396 payloads were rejected** with `"unknown instruction discriminator e445a52e51cb9a1d"`. Added `decodeEventData`, `encodeEventData`, `eventIndex`, and transparent dispatch in `decodeData`/`decodePayload`: instructions match first, event self-CPIs match second.

**Measured after the fix (`tools/coverage.mjs`):**
- **773/773 payloads decoded** (377 instructions + 396 Anchor event self-CPIs).
- **773/773 round-trip byte-exact** (0 codec errors, 0 unknown discriminators, 0 trailing bytes).
- Instructions observed: `route_v2` (153), `route` (102), `shared_accounts_route_v2` (39), `set_token_ledger` (30), `route_with_token_ledger` (26), `shared_accounts_route` (18), `create_idempotent_associated_token_account` (5), `shared_accounts_route_with_token_ledger` (4).
- Events observed: `SwapEvent` (205), `SwapsEvent` (188), `FeeEvent` (3).
- **Naming cross-check:** compared against the independent bitquery IDL in `solana-tx-remix/idl/multi/jupiter-amm/amm.json`: **768/768 shared discriminators agree on the name** with 0 name disagreements; the remaining 5 payloads are `create_idempotent_associated_token_account`, which is on-chain but absent from the older bitquery copy.

Covered by `test/jupiter-v6.test.mjs` (9 tests) using real pinned mainnet fixtures. Whirlpool qualification re-run: 1,119/1,119 byte-exact, 33 trailing, 0 regressions. Runs: `npm test` (58 tests pass).

## Third real program, family-distant: Kamino Lend (and a gap in the coverage measure)

Whirlpool and Jupiter AMM v6 are both swap venues from the same family. On 2026-10-29 sememe pulled Kamino Lend (`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`, a lending market) from mainnet (slot 462900393, legacy `anchor:idl` account, fingerprint `sha256:8a9a5d124ac3a2b50ef096f1fff56557367ee9cb8d08a17bde8a61dd373da4b5`), harvested **142,981 transactions** across **324 finalized blocks** (slots 462905866..462909439) and extracted **1,432 payloads** from 400 payload-bearing transactions.

**The finding: this program's on-chain IDL stores no discriminators at all.** 66 instructions, 5 events, 0 discriminators. A decoder indexes by discriminator, so the index built from the stored IDL is empty and **0 of 1,432 real payloads decoded** — every one refused with "unknown instruction discriminator".

That also exposes a gap in the 20-program coverage measure, which classified a program as *usable* whenever its IDL named at least one instruction. Kamino Lend was counted usable (it was one of the eleven legacy-Anchor pulls) although its schema could not decode a single byte. "Names instructions" is not "can decode".

**Fix:** `src/discriminators.mjs` fills the gaps with Anchor's own rule — `sha256("global:" + snake_case(name))[0..8]` for instructions, `sha256("event:" + name)[0..8]` for events. Stored discriminators are never overwritten, and a stored value that disagrees with the derivation is reported as a conflict rather than silently replaced.

**The rule is verified, not assumed:** against IDLs that *do* store their discriminators, the derivation reproduces **Whirlpool 72/72** and **Jupiter AMM v6 24/25**. The single exception is instructive: Jupiter's `create_idempotent_associated_token_account` stores `5368c096…`, while the name-derived value is `bdbcecfa…` — and 5 real mainnet payloads carry `5368c096…` and round-trip byte-exact, so the stored value is the true one. A name is not proof of a wire discriminator, which is exactly why the derivation only fills gaps.

**Measured after the fix (`tools/coverage.mjs`):**
- **1,432/1,432 payloads decoded and round-trip byte-exact** (0 codec errors, 0 unknown discriminators, 0 trailing bytes).
- **Naming cross-check** against Kamino's own published IDL (`@kamino-finance/klend-sdk`): **1,432/1,432 named by both sources, 0 disagreements**.
- Instructions observed: `refreshReserve` (520), `refreshReservesBatch` (290), `refreshObligation` (268), `depositReserveLiquidityAndObligationCollateralV2` (54), `depositReserveLiquidity` (51), `borrowObligationLiquidityV2` (47), `withdrawObligationCollateralAndRedeemReserveCollateralV2` (45), `repayObligationLiquidityV2` (43), `flashBorrowReserveLiquidity` (36), `flashRepayReserveLiquidity` (36), `redeemReserveCollateral` (33), `initObligation` (5), `initObligationFarmsForReserve` (3), `initUserMetadata` (1).

Covered by `test/klend-derived.test.mjs` (6 tests) using real pinned mainnet fixtures; `test/discriminators.test.mjs` (7 tests) pins the rule and the Jupiter exception. `decodePayload` now reports `discriminatorSource` (`stored` / `derived` / `stored+derived`) and any derivation conflicts, so a consumer can tell a name-derived match from a stored one. Whirlpool and Jupiter re-runs: unchanged, 0 regressions.

**A second, unrelated defect fixed along the way:** `tools/harvest.mjs` computed the slot range with `Math.min(...slots)`. A 142,981-transaction harvest collects far more slots than the call stack accepts, so the run died with `RangeError: Maximum call stack size exceeded` *after* all RPC work and before the file was written. The range is now reduced in a loop (`tools/lib/slot-range.mjs`).

**Remaining limits at that point:** three programs, still no outside user; accounts were still undecoded (now closed below); the derivation is Anchor-specific (a non-Anchor program needs its own scheme); and the coverage measure's "usable" definition should be tightened to require a decodable schema, not just named instructions.

## Fourth program: OpenBook v2, checked against anchor-ts's own sighash

Kamino Lend left one weak spot: the derivation rule was verified against programs that *store* discriminators (Whirlpool, Jupiter) and then *applied* to a program that stores none (Kamino), whose own published SDK happens to hardcode them. A reader could still say: you checked your rule against yourself.

OpenBook v2 (`opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb`, a central limit order book — a third program family after the swap AMMs and the lending market) closes that. Its on-chain IDL was pulled on 2026-10-29 at slot 462921401 (legacy `anchor:idl` account, fingerprint `sha256:d12a2e16314b418a173cc6da755746396e2b15caf9e28ccb4913aa335050913f`): **29 instructions, 8 events, 0 discriminators** — the same premise as Kamino Lend.

**The oracle is an independent implementation of Anchor's sighash:** `@coral-xyz/anchor` (anchor-ts 0.29.0) computes `sha256("global:" + snake_case(name))[0..8]` at runtime from the same IDL, in code this repository shares nothing with. Fixture `test/fixtures/openbook-anchor-ts-discriminators.json` records its 29 instruction + 8 event discriminators; the derived values match **29/29 and 8/8, byte for byte** (`test/openbook-v2.test.mjs`). Events were also reproduced by the event rule, 8/8.

**Measured on real traffic (`tools/coverage.mjs`):** a harvest of **224,894 transactions** across 900+ finalized blocks (slots 462476178..462929711) yielded **600 payload-bearing transactions with 600 payloads**:

- **600/600 decoded and round-trip byte-exact**, 0 codec errors, 0 unknown discriminators, 0 trailing bytes.
- **Without derivation: 0/600** — the discriminator index built from the published bytes alone is empty, exactly as for Kamino Lend.
- **Naming cross-check** against the independently published IDL (`openbook-dex/openbook-v2`, `idl/openbook_v2.json`, fetched from GitHub): **600/600 named by both, 0 disagreements**; instruction sets identical (29/29 both sides).
- Instructions observed: `placeTakeOrder` (562), `cancelOrder` (10), `consumeEvents` (7), `placeOrders` (7), `settleFunds` (4), `consumeGivenEvents` (3), `cancelAllOrders` (3), `deposit` (2), `cancelAllAndPlaceOrders` (2).

Covered by `test/openbook-v2.test.mjs` (6 tests) and pinned fixtures (`openbook-v2-idl.json`, `openbook-anchor-ts-discriminators.json`, `openbook-v2-published-idl.json`, `harvest-openbook-v2-2026-10-29.json`). Suite: **82/82**. Disabling the fill in `src/discriminators.mjs` fails the new tests (falsification), restoring it passes.

**Remaining limits after four programs:** still no outside user; both derivation checks (Kamino SDK, anchor-ts) are Anchor-specific — a non-Anchor program needs its own scheme; and the sample remains family-clustered. OpenBook's on-chain and published IDLs are also both legacy shapes, so the naming cross-check shares the Anchor rule on both sides; the byte-exact round-trip against 600 real payloads is what cannot be satisfied by a wrong discriminator.

## Fifth program: Marinade liquid staking (a staking program, and a published SDK that stores nothing either)

Marinade (`MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`, liquid staking — a staking program, not a swap AMM, lending market or order book) is one of the five programs in the strict coverage table that can only decode because the tool reconstructs the missing discriminators. Its on-chain IDL was pulled on 2026-10-29 at slot 462985426 (legacy `anchor:idl` account, fingerprint `sha256:61ccc0c1a5995dd4aaaa0ec0108e88343642f8da4f74603c67472c8ae42ea14e`): **29 instructions, 26 events, 0 discriminators** — the same premise as Kamino Lend and OpenBook v2, now on a fourth program family.

**Two independent confirmations, one per open question:**

- **Is the rule right?** anchor-ts (0.29.0) computes Anchor's sighash at runtime from the same IDL in code this repo shares nothing with. Fixture `test/fixtures/marinade-anchor-ts-discriminators.json` records its 29 instruction + 26 event discriminators; the derived values match **29/29 and 26/26, byte for byte** — this time including the events (26 of them, four times the OpenBook event set).
- **Is the interface the one the program ships?** the naming cross-check uses `marinade_finance.json` from `marinade-finance/marinade-ts-sdk`, an artifact fetched from GitHub that this machine's store never sees. **29/29 instruction names identical, 0 only-on-one-side**, and the coverage run reports **623/623 payloads named by both sources, 0 disagreements**.

**Measured on real traffic:** a harvest of **236,290 mainnet transactions** across 560 finalized blocks (slots 462439010..462984538) yielded **600 payload-bearing transactions with 623 payloads**:

- **623/623 decoded and round-trip byte-exact**, 0 codec errors, 0 unknown discriminators, 0 trailing bytes.
- **Without derivation: 0/623** — the discriminator index built from the published bytes alone is empty, exactly as for Kamino Lend and OpenBook v2.
- Instructions observed (14 distinct): `liquidUnstake` (164), `deposit` (150), `mergeStakes` (136), `updateActive` (125), `setValidatorScore` (24), `updateDeactivated` (6), `stakeReserve` (5), `partialUnstake` (5), `claim` (3), `configLp` (1), `withdrawStakeAccount` (1), `removeLiquidity` (1), `removeValidator` (1), `addValidator` (1).

Covered by `test/marinade.test.mjs` (6 tests) and pinned fixtures (`marinade-liquid-staking-idl.json`, `marinade-anchor-ts-discriminators.json`, `marinade-finance-published-idl.json`, `harvest-marinade-liquid-staking-2026-10-29.json`); measurement in [research/coverage-marinade-liquid-staking-2026-10-29.json](research/coverage-marinade-liquid-staking-2026-10-29.json). Suite: **114/114**. Falsification: flipping one byte of the derived discriminator fails 2 of the 6 new tests (the byte-exact round-trip and the anchor-ts comparison), restoring it passes.

**Remaining limits after five programs:** still no outside user; no Marinade *account* decoding yet (the account branch covers Whirlpool/OpenBook/Kamino); the derivation is still Anchor-specific; and this harvest recorded **0 event payloads** — Marinade's 26 events were verified as discriminators against anchor-ts but none appeared in the sampled traffic, so the event path on this program is confirmed by the oracle, not by real bytes.

## Sixth program: Meteora Vault (a yield vault, and a measured interface drift)

Meteora Vault (`24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` — strategy rotation over token vaults, a fifth program family: not a swap AMM, lending market, order book or staking program) is one of the five programs in the strict coverage table that can only decode because the tool reconstructs the missing discriminators. Its on-chain IDL was pulled on 2026-10-29 at slot 463051650 (legacy `anchor:idl` account, fingerprint `sha256:945b541c0a3f2d81d049016ec21c8afd49329de78d76453c99dd42dbc41a5e94`): **14 instructions, 8 events, 0 discriminators** — same premise, fifth family.

**The interface drift finding (new):** the independent published copy (`idl.ts` shipped in MeteoraAg/vault-sdk) is version **0.9.5**, while the on-chain account is **0.7.2**. The inventories are not identical: the on-chain copy carries `collectDust` and `withdraw2`, which the published copy dropped; the published copy carries 7 instructions the on-chain account never heard of (`claimRewards`, `getUnlockedAmount`, `initializeIdleVault`, `migrateVault`, `transferAdmin`, `transferFeeVault`, `updateLockedProfitDegradation`). Every on-chain **event** name exists in the published copy. This is pinned as a measured fact in `test/meteora-vault.test.mjs` so a future pull that changes the drift fails loudly — "same interface" is not asserted where it is not true.

**Two independent confirmations:**

- **Is the rule right?** anchor-ts (0.29.0) computes Anchor's sighash at runtime from the same IDL in code this repo shares nothing with. Fixture `test/fixtures/meteora-vault-anchor-ts-discriminators.json` records its 14 instruction + 8 event discriminators; the derived values match **14/14 and 8/8, byte for byte**.
- **Does real traffic only use names both copies know?** **1,290/1,290 payloads named by both sources, 0 disagreements**, and the two instructions actually observed (`withdraw`, `deposit`) exist in both interface copies — the drift above is inventory drift, not a name under shipped bytes.

**Measured on real traffic:** a harvest of **325,087 mainnet transactions** across 428 finalized blocks (slots 463049519..463051719) yielded **603 payload-bearing transactions with 1,290 payloads**:

- **1,290/1,290 decoded and round-trip byte-exact**, 0 codec errors, 0 unknown discriminators, 0 trailing bytes.
- **Without derivation: 0/1,290** — the discriminator index built from the published bytes alone is empty.
- Instructions observed: `withdraw` (654), `deposit` (636). Honest limit: vault traffic is two high-volume flows, not a tour of all 14 instructions; **0 event payloads**, so the event path on this program is confirmed by the oracle (8/8 against anchor-ts), not by real bytes — same limit as Marinade.

Covered by `test/meteora-vault.test.mjs` (7 tests) and pinned fixtures (`meteora-vault-idl.json`, `meteora-vault-anchor-ts-discriminators.json`, `meteora-vault-published-idl.json`, `harvest-meteora-vault-2026-10-29.json`); measurement in [research/coverage-meteora-vault-2026-10-29.json](research/coverage-meteora-vault-2026-10-29.json). Falsification: disabling the derivation fill fails 2 of the 7 new tests (byte-exact round-trip and the anchor-ts comparison), restoring it passes.

**Remaining limits after six programs:** still no outside user; the derivation is still Anchor-specific; **one of the five derivation-only programs remains individually unproven against real payloads (Meteora DAMM v1)** — Kamino Lend, OpenBook v2, Marinade and Meteora Vault now each are; no event bytes observed on this program.

## Accounts: state, not just calls (three programs, 39 real accounts)

Every proof above ends instructions/events and says the same remaining limit: *accounts are still undecoded*. That limit is now closed for the same three programs.

`src/account.mjs` decodes an account's bytes against the same stored IDL:

```bash
node bin/sememe.mjs account whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc \
  '<base64 from getMultipleAccounts>' --store /tmp/sememe-demo
```

The 8-byte Anchor account discriminator picks the account type (no `--name` needed), the struct is read from the IDL — inline in `accounts` for legacy IDLs, via `types` for newer ones — and the decoded value must re-encode to the account's own bytes.

**The account discriminator is derived the same way instructions are, and it is verified by an independent implementation.** Fixture `test/fixtures/account-discriminators-anchor-ts.json` records `BorshAccountsCoder.accountDiscriminator` computed by anchor-ts (0.29.0) for **all 29 account names across 4 IDLs**; sememe's `sha256("account:" + name)[0..8]` matches **29/29, byte for byte**. Whirlpool stores its account discriminators (12/12, so stored = derived, 0 conflicts); OpenBook v2 and Kamino Lend store none, so all 6 + 10 are derived — without derivation **0 of their accounts identify at all** (falsification test in `test/account.test.mjs`).

**Measured on real mainnet accounts** (`tools/account-harvest.mjs` → owner-filtered `getMultipleAccounts`, pinned as fixtures; `tools/accounts.mjs` decodes them from a live store):

| program | accounts | identified | decoded | re-encoded byte-exact | trailing bytes |
|---|---|---|---|---|---|
| Whirlpool | 27 | 27 | 27 | 27 | 0 |
| OpenBook v2 | 4 | 4 | 4 | 4 | 0 |
| Kamino Lend | 8 | 8 | 8 | 8 | 0 |
| **total** | **39** | **39** | **39** | **39** | **0** |

Types covered include `Whirlpool`, `Oracle`, `TickArray`, `DynamicTickArray` (Whirlpool), `Market`, `OpenOrdersAccount`, `BookSide`, `EventHeap` (OpenBook v2, including its 90 KB book-side accounts), and `Obligation`, `Reserve`, `LendingMarket`, `UserMetadata` (Kamino Lend).

**Values are checked against anchor-ts, not just round-tripped.** Round-tripping through sememe's own encoder would prove only that decode and encode agree with each other. Instead, anchor-ts decoded every pinned account and the hash of its normalised value is pinned in `test/fixtures/account-values-golden-2026-10-29.json`; the suite recomputes the hash from sememe's own decode. **39/39 agree**, and the live cross-check with the independently published OpenBook IDL (`tools/accounts.mjs --cross-check`) reports 4/4 compared with 0 disagreements.

**What the byte-exactness gate actually proves is itself falsified:** dropping the struct's first field, or flipping a discriminator byte, must not produce "decoded + trailing 0 + byte-exact" — both are asserted to fail (`test/account.test.mjs`), and foreign program bytes must identify as nothing.

Run: `npm test` (the account commit brought the suite to 108; **114** after the fifth program above), plus `node tools/accounts.mjs --accounts test/fixtures/accounts-<program>-2026-10-29.json --store <store> --program <id>` to re-measure from a live pull.

**Remaining limits:** still no outside user; **zero trailing bytes were observed**, so the report path for account bytes the IDL does not describe is implemented but unexercised by real data; `repr(C)`/`packed` (zero-copy) accounts are not decoded; account *discriminators* are derived for three Anchor programs — a non-Anchor program's account framing still needs its own scheme, exactly as for instructions; and 39 accounts from traffic of three programs is a convenience sample, not an inventory of what accounts exist on chain.

## Free and paid

- Free, MIT: all acquisition channels, normalization, fingerprint store, checks, decode and encode APIs, CLI, daemon, lock files, and fully offline resolution. No account or quota.
- Paid later: managed team registries, curated coverage packs for programs without a public interface, and enterprise approval and audit workflows. A decode call is never sold.

## Evidence and limits

Checked on 2026-10-25: about 99 first-party decoder or discriminator sites and four provenance-free vendored IDLs exist across my own repositories — an **estimate from notes, not a counted figure**. A computed scan on 2026-10-27 ([research/decoder-sites-2026-10-27.json](research/decoder-sites-2026-10-27.json), `node tools/decoder-sites.mjs`) found **42 (file, class) sites across 35 files in 5 own repositories** (plus 7 own fork checkouts holding 407 sites that are someone else's code, and 394 in third-party checkouts, which are not mine to replace). The two figures use different counting units, so do not treat 99 and 42 as measuring the same thing; until one unit is fixed and re-counted, the honest statement is that the number of my own decoder sites is *somewhere in that range and not yet pinned down*. Jupiter maintains its own parser, and a static public IDL catalog has users, while earlier registry and deserializer attempts stalled. Helius sells parsed events and streams as a paid product.

The largest risk is coverage. If on-chain acquisition works for fewer than half of the programs I actually touch, sememe is only an import-and-lock tool and the venture depends on paid curation. A first selected sample now tests this **before any product implementation**: on 2026-10-27, a batch mainnet RPC query at finalized slot 462035811 found an IDL with a nonempty instruction list at one of two known account addresses for **15/20 programs (75%)**; 5/20 had neither account, 0 RPC errors. Excluding the two deliberately non-Anchor SPL negative controls: **15/18 (83.3%)**. Four succeeded via Program Metadata, eleven via legacy Anchor. This is a family-clustered convenience sample concentrated in Raydium/Meteora, **not** a representative estimate of all Solana programs or even a systematic inventory of my own production workloads, nor evidence that third parties need sememe. 'Usable' here means decodable JSON with at least one named instruction and correct program binding where declared; it does not prove full ABI fidelity or transaction decoding. **Correction 2026-10-29:** it also does not prove that a decoder can *use* the schema — Kamino Lend, one of the eleven legacy-Anchor successes, stores no discriminators at all (0 of 71 entries), so its schema decoded 0 of 1,432 real payloads until Anchor's rule filled the gaps.

The strict figure **has now been measured** over the same frozen 20 IDs and the same RPC shape (commit `dcb0d3`, [research/coverage-strict-2026-10-29.json](research/coverage-strict-2026-10-29.json)):

| definition | count | share of 20 |
|---|---|---|
| IDL present with a named instruction (the old 'usable') | 15/20 | 75% |
| **decodable from published bytes alone** (the program stored its own discriminators) | **10/20** | **50%** |
| decodable after Anchor's rule fills a missing discriminator | 15/20 | 75% |

The middle row is the honest headline: **half** of the sample's usable programs publish an interface that decodes as-is; the other five (Kamino Lend, OpenBook v2, Marinade, Meteora DAMM v1, Meteora Vault) publish names and layouts but no wire discriminators, and only become decodable because the tool can reconstruct them from the name. That reconstruction is verified per program, but it is the tool's inference, not the program's published interface — and it is Anchor-specific. **Four of the five are now individually proven against real mainnet payloads** (Kamino Lend 1,432/1,432, OpenBook v2 600/600, Marinade 623/623, Meteora Vault 1,290/1,290, each byte-exact with 0 without derivation); Meteora DAMM v1 remains. See [frozen 20 IDs](programs-20.json), [raw classification with slot and account addresses](coverage-result.json), and [selection/chronology limitations](research/selection-method.md). The 20 IDs were committed before the full batch run, but the detailed selection-method note came later; one exploratory Whirlpool RPC check preceded the freeze. Do not call the whole study blind or fully preregistered.

## Next qualification

1. Reproduce the classification with `npm ci && npm test && node tools/measure.mjs programs-20.json another-run.json` (or set `SOLANA_RPC_URL` to another mainnet RPC). The script checks canonical Program Metadata and legacy Anchor IDL accounts in one finalized batch, separates RPC failures from missing accounts, and checks PDA derivation against independently pinned fixtures from `auroraxo/idl-drift`. It is **not** a pull/store/decode implementation. An incomplete RPC run is not zero coverage; absences at these two addresses do not mean no interface exists elsewhere.
2. **Whirlpool pull + content fingerprint has landed, the instruction decoder decodes real mainnet bytes, one own consumer reads the stored artifact for BOTH checking and producing, and the decoder is verified against an independent oracle across 1,000+ transactions** (see sections above): `solana-tx-remix` uses the pinned IDL for its single-program Whirlpool path (verifier + emitter), and `tools/tx-diff.mjs` verifies 1,119 real mainnet payloads from 1,029 transactions (sampled across 40,013 mainnet transactions in 148 finalized blocks) with 0 naming disagreements, 0 value disagreements, 0 byte mismatches, and 33 unexplained trailing-byte payloads (2.95%). Still to do, in order: migrate the remaining own decoder paths; then seek an outside user. The selected-sample threshold does not validate other program families. The `41 paths` figure above is an unverified note estimate; the computed scan in [research/decoder-sites-2026-10-27.json](research/decoder-sites-2026-10-27.json) reports **42 (file, class) decoder sites across 35 files in 5 own repositories**, of which 36 sit in `solana-tx-remix` + `sememe` — the counting unit matters and the two numbers are not interchangeable.
3. **Account decoding has landed** (see "Accounts: state, not just calls"): 39 real mainnet accounts across three programs, 39/39 re-encoded byte-exact, values checked against anchor-ts, 29/29 account discriminators matching anchor-ts's own computation. Still open: `repr(C)`/`packed` accounts, non-Anchor account framing, and the report path for account bytes the IDL does not describe (no real data has exercised it yet — 0 trailing bytes observed).
4. Test a less family-clustered, independently selected sample and seek an outside user actually importing an interface before claiming this is a venture. A favorable fraction or self-run tests alone are not adoption.
