# sememe

A local meaning layer for Solana bytes. `sememe pull <program>` fetches and verifies a program interface; every process on the machine can then decode instructions, accounts, and events offline.

**Status: first runnable pull/store prototype (October 2026), no external users.** The 20-program coverage qualification does not show demand or general ecosystem coverage. Decode/encode, lockfiles, catalog import and daemon are still proposals.

## The idea

"What do these bytes mean?" is currently either a paid cloud feature or a decoder rebuilt inside every repository. Vendored IDL files are snapshots without provenance, a fingerprint, or a freshness check.

sememe is a local, content-addressed schema store with a verification contract:

- **pull:** fetch an interface from an on-chain IDL, a curated catalog, or a local file.
- **validate:** fingerprint the canonical form, check discriminator uniqueness, cross-check the chain where possible, and tolerate Anchor IDL format changes.
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

**Limit:** This is acquisition and content-addressed storage, not an independent audit of the on-chain ABI, transaction decoder, offline resolver, freshness guarantee or authority check. Fetch responses are trusted to the configured RPC; first-party repo parity has not been established. The remaining proposed shape is `sememe resolve`, `decode-tx`, `lock`, and `diff` plus an optional local daemon. A later Rust core/TypeScript SDK may replace this Node-based prototype; neither exists yet.

## Free and paid

- Free, MIT: all acquisition channels, normalization, fingerprint store, checks, decode and encode APIs, CLI, daemon, lock files, and fully offline resolution. No account or quota.
- Paid later: managed team registries, curated coverage packs for programs without a public interface, and enterprise approval and audit workflows. A decode call is never sold.

## Evidence and limits

Checked on 2026-10-25: about 99 first-party decoder or discriminator sites and four provenance-free vendored IDLs exist across my own repositories. Jupiter maintains its own parser, and a static public IDL catalog has users, while earlier registry and deserializer attempts stalled. Helius sells parsed events and streams as a paid product.

The largest risk is coverage. If on-chain acquisition works for fewer than half of the programs I actually touch, sememe is only an import-and-lock tool and the venture depends on paid curation. A first selected sample now tests this **before any product implementation**: on 2026-10-27, a batch mainnet RPC query at finalized slot 462035811 found an IDL with a nonempty instruction list at one of two known account addresses for **15/20 programs (75%)**; 5/20 had neither account, 0 RPC errors. Excluding the two deliberately non-Anchor SPL negative controls: **15/18 (83.3%)**. Four succeeded via Program Metadata, eleven via legacy Anchor. This is a family-clustered convenience sample concentrated in Raydium/Meteora, **not** a representative estimate of all Solana programs or even a systematic inventory of my own production workloads, nor evidence that third parties need sememe. 'Usable' here means decodable JSON with at least one named instruction and correct program binding where declared; it does not prove full ABI fidelity or transaction decoding. See [frozen 20 IDs](programs-20.json), [raw classification with slot and account addresses](coverage-result.json), and [selection/chronology limitations](research/selection-method.md). The 20 IDs were committed before the full batch run, but the detailed selection-method note came later; one exploratory Whirlpool RPC check preceded the freeze. Do not call the whole study blind or fully preregistered.

## Next qualification

1. Reproduce the classification with `npm ci && npm test && node tools/measure.mjs programs-20.json another-run.json` (or set `SOLANA_RPC_URL` to another mainnet RPC). The script checks canonical Program Metadata and legacy Anchor IDL accounts in one finalized batch, separates RPC failures from missing accounts, and checks PDA derivation against independently pinned fixtures from `auroraxo/idl-drift`. It is **not** a pull/store/decode implementation. An incomplete RPC run is not zero coverage; absences at these two addresses do not mean no interface exists elsewhere.
2. **Whirlpool pull + content fingerprint has landed.** Next replace one real decoder path in my own Whirlpool workflow with the stored artifact, measure its decoded output against the existing path, then expand to 41 paths and 1,000 transactions only if the first comparison is exact. The selected-sample threshold does not validate other program families.
3. Test a less family-clustered, independently selected sample and seek an outside user actually importing an interface before claiming this is a venture. A favorable fraction or self-run tests alone are not adoption.
