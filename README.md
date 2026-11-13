# sememe

A local meaning layer for Solana bytes. `sememe pull <program>` fetches and verifies a program interface; every process on the machine can then decode instructions, accounts, and events offline.

**Status: v0.4.24 — published on the npm registry AND as a git tag. Pull/store plus an offline decoder for instructions, Anchor event self-CPIs and account state, verified against real mainnet programs; union decode across a program's on-chain IDL and its adopted first-party published copy (`sememe adopt` + `sememe decode --union`); the fingerprint lockfile ships (`sememe lock` + `sememe verify`); the decode path installs zero runtime dependencies. The ecosystem-wide measured coverage is 88.8% (18,967/21,350 payloads across 6 finalized blocks, 2026-11-13; 96.4% on the curated watchlist, 63.8% outside it; byte-exact re-encode on 93.1% of decoded). The honest limits ride with every number: zero external users so far — publish is not consumption — one machine, no audit.**

Everything below the fold is what you run. The full measurement and qualification history — every number, artifact, defect found and fixed, and every honest limit — was moved verbatim to [docs/measured-history.md](https://github.com/auroraxo/sememe/blob/main/docs/measured-history.md) on 2026-11-13; nothing was deleted.

## The idea

"What do these bytes mean?" is currently either a paid cloud feature or a decoder rebuilt inside every repository. Vendored IDL files are snapshots without provenance, a fingerprint, or a freshness check.

sememe is a local, content-addressed schema store with a verification contract:

- **pull:** fetch an interface from an on-chain IDL, a curated catalog, or a local file.
- **validate:** fingerprint the canonical form, check discriminator uniqueness, cross-check the chain where possible, and tolerate Anchor IDL format changes.
- **resolve (now implemented for instruction data):** decode and encode locally from the stored IDL, with strict errors instead of guesses. A program without a trustworthy source stays explicitly unverifiable.
- **store:** keep records under `~/.sememe/`; `sememe.lock` pins exact fingerprints per project (**ships** — see *Working now: pin the answers*).
- **resolve:** decode and encode locally, with strict errors instead of guesses. A program without a trustworthy source stays explicitly unverifiable.

## Quickstart: the copy-paste 1,000-transaction check (2026-11-04)

The whole product, from a fresh clone, in one command a stranger can paste:

```bash
git clone https://github.com/auroraxo/sememe && cd sememe
node tools/stranger-decode.mjs \
  --store test/fixtures/traffic-sample-store-2026-11-04 \
  --harvest test/fixtures/harvest-whirlpool-2026-10-28.json \
  --limit 1000
```

Output (exit 0 on pass, 1 on disagreement, 2 on usage/IO):

```json
{"status":"pass","transactionsChecked":1000,"payloadsChecked":1089,"decoded":1089,"decodeErrors":0,"disagreements":0,"noInterface":0,"byteExactRate":100,"programs":1,"rpcEncoding":null,"chainParsedInstructions":0,"missingBytes":0,"networkAttempts":0}
```

What that command proves, per payload, through the product's own entry points (`decodeUnionPayload`, plus the native/token/raydium tables):

1. **The payload decodes** (or is refused with a named reason — a refusal is a non-zero exit, not a silent skip).
2. **Re-encoding the decoded value reproduces the bytes**: byte-exact for the whole payload, or for the described prefix when the wire carries trailing bytes the interface does not describe (`roundTripByteExact` / `describedRoundTripByteExact`). A payload that can do neither is a **disagreement** and fails the run.
3. **Zero network calls were attempted** — enforced by `tools/lib/network-guard.mjs`, which is loaded before anything else and recorded in the report's `networkAttempts: 0`. Offline is a property of the run, not of the prose.

The same command against the multi-program traffic sample (15 programs, `pump.fun`/PumpSwap short forms included) is:

```bash
node tools/stranger-decode.mjs \
  --store test/fixtures/traffic-sample-store-2026-11-04 \
  --sample test/fixtures/traffic-sample-2026-11-04.json \
  --limit 1000 --absent verified
```

Measured on that sample (2026-11-04): 1,000 checked transactions, 6,337 payloads, 6,337 decoded, 0 decode errors, 0 disagreements, 0 no-interface, 100% byte-exact across 15 programs, 0 network attempts. `--absent error` (the default) refuses the witnessed short forms on purpose; `verified` applies only forms a chain witness covers, `report` names the absent fields without evidence — the same switch the product CLI exposes.

## Install (as a consumer, not a contributor)

```bash
npm install github:auroraxo/sememe#v0.4.24   # tagged release; no npm account needed
```

```js
import { decodePayload } from 'sememe';

const result = await decodePayload('./store', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', payload);
// result.name, result.args, result.roundTripByteExact, result.idl.fingerprint
```

The decode path installs **zero runtime dependencies**: `sememe` itself has none on its entry, and every file it reaches imports only `node:` builtins. Beyond the entry, the package exports `sememe/native` (System + ComputeBudget, derived at import from the pinned upstream sources), `sememe/token` (SPL Token + Token-2022, derived the same way from the pinned interface crates), `sememe/raydium` (Raydium AMM v4, derived from its pinned program source), `sememe/ata` (SPL Associated Token Account, derived from its pinned interface + processor), `sememe/lighthouse` (the Lighthouse first-party IDL copy, hash-checked against its pinned upstream commit at import), `sememe/store` (read/verify receipts), `sememe/pull` (acquisition) and the low-level surfaces a consumer may need directly: `sememe/codec`, `sememe/canonical`, `sememe/discriminators`. Two audit surfaces let a consumer falsify the table it was handed instead of trusting it: `sememe/native-corpus` (the real mainnet System/ComputeBudget harvests the decoder was qualified against, re-hashed on every read) and `sememe/native-audit` (re-derive the native tables from the pinned vendored Rust and byte-compare the shipped artifacts — the same audit the suite runs).

The pull is the one path that needs a package too, because deriving the Program Metadata PDA needs ed25519: install `@solana/web3.js` next to sememe before it. `@solana/web3.js` is declared as an *optional peer* precisely so a decoder-only consumer is never asked to install it. The CLI refuses `sememe pull` and `sememe gap` without it, with that instruction, and still runs every other subcommand. (Measured 2026-11-05: `sememe gap` probes the same on-chain IDL addresses as `sememe pull`, so it needs the peer too — the sentence here used to name only `sememe pull`; `tools/measure-release-surface.mjs` now derives the peer-needing commands from the import graph and fails this README if the claim drifts again.)

The **library** refuses the same way: importing `sememe/pull` or `sememe/gap` without the peer throws `PeerDependencyMissingError` (code `peer_dependency_missing`) whose message is that exact instruction — not Node's raw `ERR_MODULE_NOT_FOUND` stack trace. (Measured 2026-11-06 from a bare tarball install with the peer absent: both subpaths used to surface `Cannot find package '@solana/web3.js' imported from …` with no install command, while the CLI, which wrapped the same failure, was the only surface that named the fix; `test/acquisition-peer-surface.test.mjs` pins it on the working tree and `test/peer-tag-journey.test.mjs` pins it on the PINNED install — the fix reached main on 2026-11-06 but the front-page pin still named v0.4.5, whose bytes still leaked the raw loader error, so this sentence described an install a stranger did not receive. v0.4.6 carries it.) The entry and every decode-only subpath still import zero packages, so this refusal never reaches a decoder-only consumer.

**From an install (not a clone), the CLI is `npx sememe …`** — npm exec resolves the package's own `bin` from `node_modules`; the bare command `sememe` is not on your `PATH` after a plain `npm install`, and `node bin/sememe.mjs` works only inside a clone of the repository (both measured 2026-11-05 from a real tarball install). The consumer journey from the install, verbatim:

```bash
npm install github:auroraxo/sememe#v0.4.24 @solana/web3.js   # acquisition needs the peer
npx sememe pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --store ./store
npx sememe decode whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc 2b04ed0b1ac91e62a40d0100000000000100000000000000af331ba8327fbb35b1c4feff00000000010001010000000601 --store ./store
```

`./store` is the local content-addressed store the error `no sememe store at ./store: run "sememe pull" first` tells you to create — the `pull` above is that creation step; the vendored programs (System, ComputeBudget, SPL Token, Token-2022, Raydium AMM v4, SPL Associated Token Account) need no store at all: `npx sememe decode-native 11111111111111111111111111111111 <payload>` answers offline from the pinned upstream tables. If you ever point the decoder at a store directory that does not exist yet, the refusal names the fix; `npx sememe` is the form of that fix that runs where you are. Measured 2026-11-05 from the packed tarball of this tree: install (zero deps) → `npx sememe pull` (live mainnet) → `npx sememe decode` (byte-exact, live-pulled object byte-identical to the fixture store object `0b886e37…660f`).

Publishing to the npm registry changed on 2026-11-12: the `sememe` name is now live on registry.npmjs.org (first shipped as 0.4.21; the measured registry install of `sememe@0.4.22` into an empty app decoded the Whirlpool fixture payload `swap_v2`, `roundTripByteExact: true`). `npm install sememe` and `npm install github:auroraxo/sememe#v0.4.24` deliver the same product files from the same code: the files allowlist already ships none of this repository's tests, fixtures or qualification harness (pinned by `test/package.test.mjs`), so the git tag remains the release artifact — `test/package.test.mjs` (the contract above), `tools/e2e-package-consumer.mjs` (a real install into an empty directory) and `test/install-surface.test.mjs` (the shipped README's install commands run verbatim from the packed tarball) keep both channels honest.

## Working now: pin the answers (`sememe lock` + `sememe verify`, 2026-11-05)

The idea section promises "`sememe.lock` pins exact fingerprints per project" — this is that file, and it shipped the same day the promise was measured against the tree (the README said it; no implementation answered; `test/lock.test.mjs` was written first and went 0/11 red on the pre-lock tree).

From a clone (after `npm ci`), the full sequence, verbatim — the `pull` creates the store these commands pin (a fresh machine has no `/tmp/sememe-demo` yet; measured 2026-11-05: the lock without the pull died with `no sememe store at /tmp/sememe-demo`, exit 1):

```bash
node bin/sememe.mjs pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --store /tmp/sememe-demo
node bin/sememe.mjs lock --store /tmp/sememe-demo --out /tmp/sememe-demo.lock
node bin/sememe.mjs verify --store /tmp/sememe-demo --lock /tmp/sememe-demo.lock
```

From an install (the peer is needed for the `pull` step only), the same journey, verbatim — the `pull` creates the store these commands pin (a fresh machine has no store yet; measured 2026-11-05: the lock without the pull died with `no sememe store at ./store`, exit 1):

```bash
npx sememe pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --store ./store
npx sememe lock --store ./store --out ./sememe.lock
npx sememe verify --store ./store --lock ./sememe.lock
```

`lock` snapshots every program's newest verified receipt into one canonical-JSON document (fingerprint + source + slot + receipt name, one commit-able file); every receipt is re-checked through the store reader first, so a store the reader refuses produces NO lock, never a lock over damage. `verify` re-checks the store against the pin and refuses drift by name — `drifted` (the store now answers with a different fingerprint, both quoted), `missing` (a pinned program has no receipt), `unverified` (an object fails the re-hash), `relabelled` (a DECLARED origin changed), `unbound` (the store declares an origin this lock does not pin, so the gate cannot say whether that label changed — the lock predates origin pinning; the repair is `sememe lock`). An **extra** store program — one the lock does not pin, because the lock pins minimums, not store equality — is **reported, never a violation for being there**; but if its receipt is DAMAGED, that is a violation like any other, marked `scope: "extra"` so the repair is not mistaken for pin drift (the pin is fine; the store's receipt for an unpinned program has to be re-pulled). `--mode error` (verify's default) exits 1 on any violation, so the CI gate is `npx sememe verify` after checkout.

**Measured 2026-11-07 (`verify` must not call clean a store the reader refuses):** a store holding Whirlpool (locked) and Jupiter pulled *afterwards*, so Jupiter is an extra, with Jupiter's object rewritten so it no longer re-hashed to its receipt — the store reader refuses that program, and `sememe decode` on it exits 1 with "object and receipt disagree, refusing to decode". On the published `v0.4.10` install: `sememe lock` exited **1** (no lock written) while `sememe verify` exited **0** with **violations 0** — a green CI gate over a program the reader refuses. The cause was structural, not a typo: `writeLock` re-checked **every** receipt, `checkLock` re-checked only the **pinned** ones, so the shared helper was shared but only ever called on one side. Both paths now re-check the extras through the same helper, and only their FAILURES are reported. See [Working now: `verify` agrees with `lock`](https://github.com/auroraxo/sememe/blob/main/docs/measured-history.md#working-now-verify-agrees-with-lock-about-a-store-whose-extra-program-is-damaged-2026-11-07) and [research/extra-damage-2026-11-07-before.json](research/extra-damage-2026-11-07-before.json) (the published install: 3 contract violations) / [research/extra-damage-2026-11-07.json](research/extra-damage-2026-11-07.json) (this tree: 0).

What the lock does NOT do: it is not a freshness check against the chain (the pin says "this is what I answered", not "this is what the program is now"); it does not cover vendored programs (System/ComputeBudget/SPL Token/Token-2022/Raydium AMM v4/SPL Associated Token Account have no receipts, they are pinned from upstream sources instead); and it cannot stop you from re-pulling — it makes every re-pull that changes an answer visible.

## Where the numbers come from

Every claim above is pinned by a test and backed by a committed artifact. If you want to know **why** a number is what it is, and what was measured wrong before it was measured right:

- [docs/measured-history.md](https://github.com/auroraxo/sememe/blob/main/docs/measured-history.md) — the unabridged record: per-program verification (9+ programs, real mainnet payloads), the ecosystem coverage measurement and its corrections, acquisition-gap closings (ATA, Lighthouse, Manifest, Archer, DiabLokxis, pfeeU, pump.fun, HADRo), the dialect gate and raw-LE engine, short-form and struct-absent rules with chain witnesses, and the registry-channel measurements. Sections are named by date.
- `research/` — the JSON artifacts the README used to quote inline; the history file links them by path.
- `npm test` — 970 tests: the quickstart output line, the documented commands against the pinned tag, the install channels, the journey from a bare `node_modules` install, and the measurement artifacts themselves are all pinned. A hand-edited number in this README goes red.

## Free and paid

- Free, MIT: all acquisition channels, normalization, fingerprint store, checks, decode and encode APIs, CLI, daemon, lock files, and fully offline resolution. No account or quota.
- Paid later: managed team registries, curated coverage packs for programs without a public interface, and enterprise approval and audit workflows. A decode call is never sold.
