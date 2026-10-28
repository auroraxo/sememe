# sememe

A local meaning layer for Solana bytes. `sememe pull <program>` fetches and verifies a program interface; every process on the machine can then decode instructions, accounts, and events offline.

**Status: pull/store plus a first offline decoder, both runnable (October 2026), with one own repository reading it for both checking and producing recipes (`solana-tx-remix`), no external users.** The 20-program coverage qualification does not show demand or general ecosystem coverage. Lockfiles, catalog import and daemon are still proposals.

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

**Limits of this evidence:** it covers one Anchor program's instruction data on one sample of mainnet traffic. Account and event layouts are untested, `repr(C)`/`packed` account types are not decoded yet, the mainnet sample is small and self-harvested (50 payloads, not 1,000 transactions), and byte-exact agreement with a reference codec shows layout fidelity — not that any real workflow has been migrated or that anyone outside this machine uses sememe. Run `npm test` (26 tests) and `SEMEME_ORACLE_PATH=<dir>/node_modules node tools/crosscheck.mjs --store <store>` to reproduce. The mainnet-payload tests no longer depend on a live store: the IDL snapshot in `test/fixtures/whirlpool-idl.json` is re-fingerprinted against its receipt on every run, so they execute on a fresh checkout and in CI instead of skipping.

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

## Free and paid

- Free, MIT: all acquisition channels, normalization, fingerprint store, checks, decode and encode APIs, CLI, daemon, lock files, and fully offline resolution. No account or quota.
- Paid later: managed team registries, curated coverage packs for programs without a public interface, and enterprise approval and audit workflows. A decode call is never sold.

## Evidence and limits

Checked on 2026-10-25: about 99 first-party decoder or discriminator sites and four provenance-free vendored IDLs exist across my own repositories — an **estimate from notes, not a counted figure**. A computed scan on 2026-10-27 ([research/decoder-sites-2026-10-27.json](research/decoder-sites-2026-10-27.json), `node tools/decoder-sites.mjs`) found **42 (file, class) sites across 35 files in 5 own repositories** (plus 7 own fork checkouts holding 407 sites that are someone else's code, and 394 in third-party checkouts, which are not mine to replace). The two figures use different counting units, so do not treat 99 and 42 as measuring the same thing; until one unit is fixed and re-counted, the honest statement is that the number of my own decoder sites is *somewhere in that range and not yet pinned down*. Jupiter maintains its own parser, and a static public IDL catalog has users, while earlier registry and deserializer attempts stalled. Helius sells parsed events and streams as a paid product.

The largest risk is coverage. If on-chain acquisition works for fewer than half of the programs I actually touch, sememe is only an import-and-lock tool and the venture depends on paid curation. A first selected sample now tests this **before any product implementation**: on 2026-10-27, a batch mainnet RPC query at finalized slot 462035811 found an IDL with a nonempty instruction list at one of two known account addresses for **15/20 programs (75%)**; 5/20 had neither account, 0 RPC errors. Excluding the two deliberately non-Anchor SPL negative controls: **15/18 (83.3%)**. Four succeeded via Program Metadata, eleven via legacy Anchor. This is a family-clustered convenience sample concentrated in Raydium/Meteora, **not** a representative estimate of all Solana programs or even a systematic inventory of my own production workloads, nor evidence that third parties need sememe. 'Usable' here means decodable JSON with at least one named instruction and correct program binding where declared; it does not prove full ABI fidelity or transaction decoding. See [frozen 20 IDs](programs-20.json), [raw classification with slot and account addresses](coverage-result.json), and [selection/chronology limitations](research/selection-method.md). The 20 IDs were committed before the full batch run, but the detailed selection-method note came later; one exploratory Whirlpool RPC check preceded the freeze. Do not call the whole study blind or fully preregistered.

## Next qualification

1. Reproduce the classification with `npm ci && npm test && node tools/measure.mjs programs-20.json another-run.json` (or set `SOLANA_RPC_URL` to another mainnet RPC). The script checks canonical Program Metadata and legacy Anchor IDL accounts in one finalized batch, separates RPC failures from missing accounts, and checks PDA derivation against independently pinned fixtures from `auroraxo/idl-drift`. It is **not** a pull/store/decode implementation. An incomplete RPC run is not zero coverage; absences at these two addresses do not mean no interface exists elsewhere.
2. **Whirlpool pull + content fingerprint has landed, the instruction decoder decodes real mainnet bytes, and one own consumer reads the stored artifact for BOTH checking and producing** (see "One own decoder path is migrated" and "Both halves of that consumer now read the artifact" above): `solana-tx-remix`'s verifier decodes Whirlpool arguments from the pinned IDL, cross-checks it against its old generated-codec path (7 instructions, 24 fields, 0 disagreements), and its flagship recipe now verifies on a fresh clone — and its emitter now produces that recipe from the same artifact. Still to do, in order: migrate the remaining own decoder paths; diff on 1,000 transactions; then seek an outside user. The selected-sample threshold does not validate other program families. The `41 paths` figure above is an unverified note estimate; the computed scan in [research/decoder-sites-2026-10-27.json](research/decoder-sites-2026-10-27.json) reports **42 (file, class) decoder sites across 35 files in 5 own repositories**, of which 36 sit in `solana-tx-remix` + `sememe` — the counting unit matters and the two numbers are not interchangeable.
3. Test a less family-clustered, independently selected sample and seek an outside user actually importing an interface before claiming this is a venture. A favorable fraction or self-run tests alone are not adoption.
