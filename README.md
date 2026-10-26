# sememe

A local meaning layer for Solana bytes. `sememe pull <program>` fetches and verifies a program interface; every process on the machine can then decode instructions, accounts, and events offline.

**Status: RFC stage (October 2026). No implementation yet.**

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

1. Measure on-chain acquisition across 20 real programs, including Whirlpool, Kamino, OpenBook, Marinade, Jupiter route targets, Raydium, and Pump.fun.
2. If coverage clears the bar, build pull plus fingerprint storage for Whirlpool.
3. Replace my 41 hand-rolled Whirlpool decoder paths and compare 1,000 real transactions with zero semantic diff.
