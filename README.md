# sememe

A local meaning layer for Solana bytes. `sememe pull <program>` fetches and verifies a program interface; every process on the machine can then decode instructions, accounts, and events offline.

**Status: RFC stage (October 2026). No product implementation or external users yet. A reproducible 20-program on-chain coverage *qualification* harness is in progress; the numeric result has not been established.**

## The idea

"What do these bytes mean?" is currently either a paid cloud feature or a decoder rebuilt inside every repository. Vendored IDL files are snapshots without provenance, a fingerprint, or a freshness check.

sememe is a local, content-addressed schema store with a verification contract:

- **pull:** fetch an interface from an on-chain IDL, a curated catalog, or a local file.
- **validate:** fingerprint the canonical form, check discriminator uniqueness, cross-check the chain where possible, and tolerate Anchor IDL format changes.
- **store:** keep records under `~/.sememe/`; `sememe.lock` pins exact fingerprints per project.
- **resolve:** decode and encode locally, with strict errors instead of guesses. A program without a trustworthy source stays explicitly unverifiable.

## Shape

```bash
sememe pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
sememe resolve ./payload.bin --program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
sememe decode-tx <signature>
sememe lock
sememe diff <program>
```

The planned core is Rust, with a TypeScript SDK over existing Solana codecs and an optional local daemon. Codama remains the compiler and format; sememe supplies acquisition, verification, and distribution.

## Free and paid

- Free, MIT: all acquisition channels, normalization, fingerprint store, checks, decode and encode APIs, CLI, daemon, lock files, and fully offline resolution. No account or quota.
- Paid later: managed team registries, curated coverage packs for programs without a public interface, and enterprise approval and audit workflows. A decode call is never sold.

## Evidence and limits

Checked on 2026-10-25: about 99 first-party decoder or discriminator sites and four provenance-free vendored IDLs exist across my own repositories. Jupiter maintains its own parser, and a static public IDL catalog has users, while earlier registry and deserializer attempts stalled. Helius sells parsed events and streams as a paid product.

The largest risk is coverage. If on-chain acquisition works for fewer than half of the programs I actually touch, sememe is only an import-and-lock tool and the venture depends on paid curation. That coverage test comes before implementation.

## Next qualification

1. **Freeze the sample before measuring:** 20 distinct mainnet program IDs with a reproducible selection rule and links to first-party program-ID sources (including Whirlpool, Kamino, OpenBook, Marinade, Jupiter route targets, Raydium, and Pump.fun). Record exclusions, not just successful programs. Do not label unavailable RPC or an undecodable IDL as coverage.
2. Run `npm ci && npm test`, then `node tools/measure.mjs programs-20.json coverage-result.json` (or set `SOLANA_RPC_URL` to another mainnet RPC). The script requires exactly 20 unique IDs, queries canonical Program Metadata and legacy Anchor IDL accounts in a batched finalized RPC call, checks ownership/program binding and a nonempty instruction schema, and keeps RPC failures separate from missing/undecodable accounts. Account derivation is checked against independently pinned PDA fixtures from `auroraxo/idl-drift`; this is a measurement harness, **not** sememe's planned pull/store/decode implementation. Public endpoints may rate-limit or reject bulk account reads; an incomplete run does not count as zero coverage.
3. If fewer than 10 of the 20 pass, revise the on-chain-first thesis, do not substitute a more favorable sample. If at least 10 pass, build pull plus fingerprint storage for Whirlpool and replace my 41 hand-rolled Whirlpool decoder paths; compare 1,000 real transactions with zero semantic diff. A favorable coverage fraction alone is not adoption.
