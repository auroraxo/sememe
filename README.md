# sememe

A local meaning layer for Solana bytes. `sememe pull <program>` fetches and verifies a program interface; every process on the machine can then decode instructions, accounts, and events offline.

**Status: pull/store plus an offline decoder for instructions, Anchor event self-CPIs and account state, all runnable (October 2026), verified against nine real mainnet programs (Whirlpool, Jupiter AMM v6, Kamino Lend, OpenBook v2, Marinade, Meteora Vault, Meteora DAMM v1, Meteora DAMM v2/cp-amm and pump.fun), with union decode across a program's on-chain IDL and its adopted first-party published copy (`sememe adopt` + `sememe decode --union`, measured 915/996 on real pump.fun traffic), plus five programs that publish no IDL at all — the two token programs (SPL Token, Token-2022), the two native programs (System, ComputeBudget) and Raydium AMM v4, all five with wire tables DERIVED from pinned upstream Rust — and all 12,572 unbiased real-mainnet payloads now have an interface to decode against, lifting coverage from 55.5% to 98.6% strict / 100% verified (the last strict refusal, Token-2022's token-metadata fallback, decodes since 2026-11-03) — and one own repository reading it for both checking and producing recipes (`solana-tx-remix`), no external users.** The 20-program coverage qualification does not show demand or general ecosystem coverage. Lockfiles, catalog import and daemon are still proposals.

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

The stranger-facing truth this pins down: **the 1,000-transaction decode is one command, offline, and fails loudly.** What it does not prove is that an outside person has run it — and that is now **measured, not asserted** (`tools/measure-foreign-run.mjs` -> `research/foreign-run-2026-11-05.json`): verdict `not-distributed-not-consumed`, i.e. zero non-owner signals on every channel that was read — 0 non-owner stars/forks/issues/PRs on this repo, 0 non-owner comments on the two outbound threads (`step-finance-oss/step-ingestooor#1` and `jup-ag/rfq-webhook-toolkit#96`, both open), 0 foreign-authored threads containing this project's slug. The first external run therefore remains the open gate. The measurement has limits and names them: the broad mention sweep covers 92 of 93 results (GitHub's search index hides one result in every ordering — measured, not assumed), a registry `404` for the bare name `sememe` on npm/crates.io/PyPI means **no install channel is published yet**, never "nobody used it", and the code-index absence is only claimed for the indexed part of GitHub (the sweep's self-reference control passes). Reproduce with `npm test` (includes `test/stranger-decode.test.mjs`, which runs this tool against both fixtures and falsifies it three ways: tampered payload, missing store, and a mutation of the pass/fail logic). The funnel a stranger walks before that first run is measured separately (2026-11-05, `tools/measure-stranger-funnel.mjs` -> `research/stranger-funnel-2026-11-05.json`): a fresh GitHub clone ran both quickstart commands verbatim (1,089 and 6,337 payloads, all decoded byte-exactly, exit 0), the published tag `v0.3.0` installed into an empty app with no npm account, and its entry decoded 1,119/1,119 real payloads byte-exactly from `node_modules/sememe` — the harness (tools/test/research) does not travel into the install. The quickstart block itself is pinned by `test/quickstart-funnel.test.mjs`, which caught and fixed one defect on 2026-11-05: the documented output line was the pre-2026-11-04 schema (missing `rpcEncoding`, `chainParsedInstructions`, `missingBytes`) — a stranger comparing her terminal to the README saw two different products. The README now documents the line the tool actually prints, and a hand-edited documented line goes red.

## Your own transactions: raw RPC responses (the shape you already hold)

The two commands above decode sememe's fixtures. A repository, archive, dashboard or indexer does not hold sememe fixtures — it holds **raw RPC responses**, overwhelmingly with the default `encoding: "base64"`, where the transaction is its wire bytes and only the chain's own parser can read it. sememe now reads that shape directly (legacy, v0 and v1 transactions, outer and inner instructions) and **verifies each transaction's ed25519 signatures before decoding it**, so a damaged or forged byte is refused by name (`wire-signature-invalid`) instead of decoded wrongly:

```bash
node tools/stranger-decode.mjs \
  --store test/fixtures/traffic-sample-store-2026-11-04 \
  --rpc-response your-getBlock-or-getTransaction-response.json \
  --absent verified
```

Accepts a `getBlock` response (`result.transactions`), a `getTransaction` response (`result.transaction`), or an archive document carrying a `transactions` array — each entry in the `["<base64 wire bytes>", "base64"]` shape the RPC returns. Exit codes: 0 pass, 1 a decode disagreement, an unreadable/damaged transaction or a decode error, 2 usage/IO. A transaction whose bytes cannot be parsed or verified is counted under `transactionsUnreadable` with its reason in `unreadableReasons` and fails the run — never silently skipped.

Measured 2026-11-04 on `test/fixtures/foreign-archive-wire-4blocks.json` (real mainnet, contiguous slots 464588080–464588083, 1,947 transactions in their raw base64 wire shape): the first 1,000 transactions carry 6,355 payloads across 115 programs, 4,646 decoded byte-exactly (100%), 0 decode errors, 0 disagreements, 0 unreadable, 0 network attempts. The 1,709 payloads the store has no interface for are reported by program, not dropped. The wire parser itself was validated against the chain's own `encoding:"json"` parser for all 648 transactions of slot 464588080: per-payload, byte-for-byte identical rows (3,528 payload rows, 0 mismatches), pinned in `test/rpc-response-ingest.test.mjs`.

**Honest limits:** the store answers only for the programs it carries (no-interface payloads are counted, not decoded); signature verification covers the static signers the message declares; v1 transactions are parsed per the upstream `MessageV1` layout pinned on 2026-11-04 and verified against the json encoding of the same block; and no third party has run this on their own archive yet — that remains the gate this command exists to make runnable.

### The shape a foreign repository's own test fixtures hold (`encoding:"json"`)

The paragraph above measured what an RPC *returns by default*. But foreign repositories that keep transaction fixtures do not keep that shape: they keep what the chain's parser already read — `encoding:"json"` — and some hold a **flattened dialect** where `instructions` and `accounts` sit at the file level (37 of the 156 fixtures in [step-finance-oss/step-ingestooor](https://github.com/step-finance-oss/step-ingestooor)). Measured on that entire 156-fixture set and the fixture of [CryptGodSon/Solana-Explorer](https://github.com/CryptGodSon/Solana-Explorer) (both MIT): instruction `data` as base58, every instruction carrying `programId` spelled out, address-table keys expanded, and **1,193 instructions already `parsed` by the chain with no bytes left in the document at all**.

Before this, `--rpc-response` read only the base64 shape: pointed at a foreign repository's own fixture it exited 2 (`not-an-rpc-response`). The integration could not read a single artifact a foreign repository actually holds — because the one shape it accepted was the shape sememe's own harvester produces. The same command now reads both shapes, plus the flattened dialect:

```bash
node tools/stranger-decode.mjs \
  --store test/fixtures/traffic-sample-store-2026-11-04 \
  --rpc-response their-own-getTransaction-fixture.json
```

Or sweep a whole directory tree of fixtures with one command:

```bash
node tools/stranger-decode.mjs \
  --store test/fixtures/traffic-sample-store-2026-11-04 \
  --fixtures-dir path/to/foreign/crates/parsers/tests \
  --out report.json
```

Measured 2026-11-04 across all 156 fixtures of `step-finance-oss/step-ingestooor` (commit 001cf39, MIT; research artifact `research/step-ingestooor-full-sweep-2026-11-04.json`): **156 files (119 standard getTransaction, 37 flattened dialect), 806 payload rows, 493 decoded byte-exactly (100%), 0 unreadable transactions, 0 disagreements, 0 network attempts**. The 306 payloads the store has no interface for are quantified by program across 70 gap programs (top: Raydium Concentrated Liquidity `L2TExM…` 42, Jupiter DCA `DCA265…` 20, Jito Tip `j1o2qR…` 14, Flash Trade `FLASH6…` 12). Seven payloads refuse with named reasons (3 stale interface, 4 unwitnessed short forms). Pinned in `test/step-ingestooor-full-sweep.test.mjs` (5 tests, red on pre-tree, four mutations each individually red).

Measured 2026-11-04 on the SAME 156 fixtures after closing the measured acquisition gap (`research/acquisition-gap-2026-11-04.json`: 34 of the 70 gap programs publish an on-chain IDL sememe had never pulled): the 34 IDLs were pulled in two batched probes (`tools/batch-pull.mjs`, slots 465308534/465308538, same write path as `sememe pull`) into `test/fixtures/traffic-sample-store-2026-11-04-pulled/`, and the 13 of them that also have a first-party published copy in the foreign repo were adopted next to the pull (union decode arbitrates by bytes, naming-convention differences `closeDca`/`close_dca` and one discriminator-preserving rename decode instead of misreading as interface conflicts — `src/union.mjs`, pinned with 6 new tests and 2 mutations in `test/union.test.mjs`). Result (`research/step-ingestooor-full-sweep-pulled-2026-11-04.json`, pinned in `test/batch-pull.test.mjs`): **noInterface 306 → 129, decoded 493 → 661 (byte-exact 100%, 0 disagreements), decodeErrors 7 → 16 — every remaining refusal named** (deployed-newer discriminators the published IDL does not list, stale IDL layouts against successfully executed transactions, unwitnessed short forms). The pull alone did NOT decode the 177 payloads: 152 decode with the on-chain IDL, 25 refuse for named reasons, 16 more decode only through the union with the published copies.

Measured on the seven committed fixtures (six from step-ingestooor, one from Solana-Explorer, verbatim under `test/fixtures/foreign-repo-json-2026-11-04/` with both MIT licenses): 7 transactions, 160 payload rows of which 56 carry bytes — 48 decoded byte-exactly (100%), 8 named `noInterface` (programs outside the store), and **104 chain-parsed rows counted as `missingBytes`, never fed to the decoder as empty payloads**: a chain-parsed instruction has no bytes to decode, and turning that missing document field into a decode refusal would be a lie about what was measured. Zero disagreements, zero decode errors, zero network attempts. Pinned in `test/foreign-repo-json-ingest.test.mjs` (red against the pre-fix tree; four mutations of the new code each individually red).

**Honest limits of this path:** the json encoding carries **no message bytes, so no signature can be verified against them** — the ed25519 self-verification of the base64 path cannot apply, and a structurally-valid value mutation inside an argument passes decode+re-encode by design (only the wire path's signature check covers value-level tampering). The encoding is detected per transaction; an unresolvable `programIdIndex` is refused by name rather than attributed to nothing. And the same gate as before: no third party has run this against their own repository — the command exists so they can.

## The idea

"What do these bytes mean?" is currently either a paid cloud feature or a decoder rebuilt inside every repository. Vendored IDL files are snapshots without provenance, a fingerprint, or a freshness check.

sememe is a local, content-addressed schema store with a verification contract:

- **pull:** fetch an interface from an on-chain IDL, a curated catalog, or a local file.
- **validate:** fingerprint the canonical form, check discriminator uniqueness, cross-check the chain where possible, and tolerate Anchor IDL format changes.
- **resolve (now implemented for instruction data):** decode and encode locally from the stored IDL, with strict errors instead of guesses. A program without a trustworthy source stays explicitly unverifiable.
- **store:** keep records under `~/.sememe/`; `sememe.lock` pins exact fingerprints per project.
- **resolve:** decode and encode locally, with strict errors instead of guesses. A program without a trustworthy source stays explicitly unverifiable.

## Install (as a consumer, not a contributor)

```bash
npm install github:auroraxo/sememe#v0.4.2   # tagged release; no npm account needed
```

```js
import { decodePayload } from 'sememe';

const result = await decodePayload('./store', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', payload);
// result.name, result.args, result.roundTripByteExact, result.idl.fingerprint
```

The decode path installs **zero runtime dependencies**: `sememe` itself has none on its entry, and every file it reaches imports only `node:` builtins. Beyond the entry, the package exports `sememe/native` (System + ComputeBudget, derived at import from the pinned upstream sources), `sememe/token` (SPL Token + Token-2022, derived the same way from the pinned interface crates), `sememe/raydium` (Raydium AMM v4, derived from its pinned program source), `sememe/store` (read/verify receipts), `sememe/pull` (acquisition) and the low-level surfaces a consumer may need directly: `sememe/codec`, `sememe/canonical`, `sememe/discriminators`. Two audit surfaces let a consumer falsify the table it was handed instead of trusting it: `sememe/native-corpus` (the real mainnet System/ComputeBudget harvests the decoder was qualified against, re-hashed on every read) and `sememe/native-audit` (re-derive the native tables from the pinned vendored Rust and byte-compare the shipped artifacts — the same audit the suite runs).

The pull is the one path that needs a package too, because deriving the Program Metadata PDA needs ed25519: install `@solana/web3.js` next to sememe before it. `@solana/web3.js` is declared as an *optional peer* precisely so a decoder-only consumer is never asked to install it. The CLI refuses `sememe pull` and `sememe gap` without it, with that instruction, and still runs every other subcommand. (Measured 2026-11-05: `sememe gap` probes the same on-chain IDL addresses as `sememe pull`, so it needs the peer too — the sentence here used to name only `sememe pull`; `tools/measure-release-surface.mjs` now derives the peer-needing commands from the import graph and fails this README if the claim drifts again.)

**From an install (not a clone), the CLI is `npx sememe …`** — npm exec resolves the package's own `bin` from `node_modules`; the bare command `sememe` is not on your `PATH` after a plain `npm install`, and `node bin/sememe.mjs` works only inside a clone of the repository (both measured 2026-11-05 from a real tarball install). The consumer journey from the install, verbatim:

```bash
npm install github:auroraxo/sememe#v0.4.2 @solana/web3.js   # acquisition needs the peer
npx sememe pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --store ./store
npx sememe decode whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc 2b04ed0b1ac91e62... --store ./store
```

`./store` is the local content-addressed store the error `no sememe store at ./store: run "sememe pull" first` tells you to create — the `pull` above is that creation step; the vendored programs (System, ComputeBudget, SPL Token, Token-2022, Raydium AMM v4) need no store at all: `npx sememe decode-native 11111111111111111111111111111111 <payload>` answers offline from the pinned upstream tables. If you ever point the decoder at a store directory that does not exist yet, the refusal names the fix; `npx sememe` is the form of that fix that runs where you are. Measured 2026-11-05 from the packed tarball of this tree: install (zero deps) → `npx sememe pull` (live mainnet) → `npx sememe decode` (byte-exact, live-pulled object byte-identical to the fixture store object `0b886e37…660f`).

Publishing to the npm registry itself is deliberately not done: the files allowlist already ships none of this repository's tests, fixtures or qualification harness (pinned by `test/package.test.mjs`), and no registry name squatting is part of the plan. The git tag is the release artifact; `test/package.test.mjs` (the contract above), `tools/e2e-package-consumer.mjs` (a real install into an empty directory) and `test/install-surface.test.mjs` (the shipped README's install commands run verbatim from the packed tarball) keep it honest.

## Working now: pull a program's on-chain IDL

```bash
npm ci
npm test
node bin/sememe.mjs pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --store /tmp/sememe-demo
# optional: --rpc https://your-mainnet-rpc.example
```

The CLI fetches the canonical Program Metadata and legacy Anchor IDL accounts at a finalized RPC slot, checks account owner/program binding and JSON instruction shape, prefers canonical when both exist, and stores normalized JSON by SHA-256 under `<store>/objects/`. A receipt under `<store>/receipts/` records program ID, source account address, slot, fingerprint and instruction count. Repeating the pull of identical content does not rewrite the stored object; corrupt files are refused rather than overwritten. A public Whirlpool pull succeeded on 27.10. at slot 462039125 with 66 named instructions and fingerprint `sha256:0b886e375b112206a846a061f076f7db02a4b01b25cd593cd03caa490d86660f` (own run; no outside use).

### Before you pull: ask why an interface is missing (`sememe gap`)

When a consumer hits `no stored IDL for program X`, running `sememe pull` blindly is the wrong reflex: many programs on Solana publish no IDL at all, so a pull will simply fail repeatedly and leave the consumer guessing whether the RPC failed, the address is wrong, or the program was closed. `sememe gap` probes both on-chain IDL addresses (Program Metadata and legacy `anchor:idl`) and returns the exact diagnosis, with the fix that actually applies:

```bash
node bin/sememe.mjs gap DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M
```

```json
{
  "program": "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M",
  "verdict": "pullable",
  "source": "anchor",
  "instructions": 12,
  "next": "sememe pull DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M"
}
```

Pointed at a program that publishes nothing at either address (for example `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`, the largest single gap in the 156-fixture set, 42 payloads, Lighthouse):

```json
{
  "program": "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
  "verdict": "no-interface-published",
  "next": "this program publishes no on-chain interface at either address — pulling it can never succeed. Use sememe adopt <program> <file> with a first-party published copy, or a pinned upstream derivation."
}
```

The five possible verdicts, all mutually exclusive:
- `pullable`: an on-chain interface exists that your local store does not have yet -> `sememe pull` is the fix.
- `no-interface-published`: neither address answers -> pulling it forever will never help. Use `sememe adopt` with a first-party published copy, or a pinned upstream derivation.
- `present-undecodable`: an account exists at one of the addresses, but its schema cannot be decoded (malformed, or declares another program).
- `vendored`: one of the programs sememe answers via pinned upstream wire tables (System, ComputeBudget, SPL Token, Token-2022, Raydium AMM v4) — there is no on-chain IDL to store.
- `unknown`: the RPC failed. **An RPC failure is never recorded as an absence** (the crates.io 403 lesson: a client-side failure that reads as missing data). The CLI exits 3 (`no-verdict`) in this case so scripted callers know the chain's state is unmeasured.

Measured 2026-11-04 over all 70 gap programs of the foreign 156-fixture set (`research/acquisition-gap-2026-11-04.json`): **34 programs publish an on-chain IDL (177 payloads)** — never-pulled gaps, not derivation work — and **36 publish nothing (129 payloads)**.

#### Closing a measured gap in one command (`tools/batch-pull.mjs`)

When the gap report says 34 programs are pullable, pulling them one CLI process each is 34 RPC round-trips at 34 different slots. The batch tool probes them in batched `getMultipleAccounts` calls (25 programs = 50 keys per request; the public endpoint rejects larger batches) and stores each IDL through the SAME write path the single-program CLI uses:

```bash
node tools/batch-pull.mjs --gap research/acquisition-gap-2026-11-04.json \
  --store my-store \
  --out research/batch-pull-2026-11-04.json
```

The artifact records, per program: verdict (`stored` / `undecodable` / `unknown`), source account, slot, fingerprint, instruction count, and — honestly — whether the stored IDL carries its own discriminators or needs Anchor's derivation rule (measured: 12 of the 34 carry stored discriminators, 22 need the rule). An RPC failure is `unknown` and exits 3 (`no-verdict`), never an absence; a hand-edited gap report is refused before any probe runs (its rows must sum to its own headline).

**What a pull does NOT promise:** the pulled IDL describes the program AS PUBLISHED, not as deployed. Measured on the 156-fixture sweep: after pulling all 34, 152 of the 177 payloads decode byte-exactly, but 25 refuse with named reasons — 19 discriminators the deployed program emitted that the published IDL does not list, 6 stale argument layouts — in transactions that SUCCEEDED on chain. Where a first-party published copy exists (the foreign repo ships 13 of them), adopting it next to the pull and decoding through the union closes most of those; see the union section below.

**Limit:** This is acquisition and content-addressed storage, not an independent audit of the on-chain ABI, offline resolver, freshness guarantee or authority check. Fetch responses are trusted to the configured RPC; first-party repo parity has not been established. `resolve`, `decode-tx`, `lock`, `diff` and the optional local daemon remain proposals. (Account and event decoding are NOT proposals: they ship — `decodeStoredAccount` for account state and Anchor `emit_cpi!` event self-CPIs are both on the entry; this sentence said otherwise until 2026-11-05, and the contradiction was measured and pinned by `test/release-surface.test.mjs`.) A later Rust core/TypeScript SDK may replace this Node-based prototype; neither exists yet.

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

## Seventh program: Meteora DAMM v1 (last derivation-only program, and a case-style finding)

Meteora DAMM v1 (`Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` — Meteora's constant-product/stable AMM, a sixth program family) is the fifth and last program in the strict coverage table that can only decode because the tool reconstructs the missing discriminators. Its on-chain IDL was pulled on 2026-10-29 at slot 463068495 (legacy `anchor:idl` account, fingerprint `sha256:dd60d3d367986a1d2ad574df3ea5855c5a9801fdaa6fdea57b898deafb95fdba`): **26 instructions, 18 events, 0 discriminators** — same premise as Kamino Lend, OpenBook v2, Marinade and Meteora Vault.

**Two new findings:**

- **Case-style difference between interface copies is not a disagreement.** The on-chain copy names instructions in camelCase (`claimFee`, `removeBalanceLiquidity`), the published `MeteoraAg/damm-v1-sdk` copy in snake_case (`claim_fee`, `remove_balance_liquidity`). Anchor's rule hashes `snake_case(name)`, so the two copies produce identical wire bytes while differing in spelling convention. `tools/coverage.mjs` now counts these apart: `caseOnlyDifference` (cosmetic) versus `nameDisagreement` (survives snake_casing, therefore a real conflict). Before this fix the DAMM run reported 13 false "name disagreements" that were 13× `claimFee`/`claim_fee`. Measured now: **643/643 named by both copies, 0 real disagreements, 13 case-only differences.**
- **The published copy stores its own discriminators, and the rule reproduces them.** Unlike the on-chain account, the published `idl.json` carries discriminator arrays written by the program's own IDL generator: **30/30 instructions and 19/19 events match the Anchor rule byte for byte**, computed from names this repository never touched. That is confirmation of the rule from a second source that *stores* rather than *derives*.

**Measured on real traffic:** a harvest of **152,097 mainnet transactions** across finalized blocks (slots 463065616..463068621) yielded **602 payload-bearing transactions with 643 payloads**:

- **643/643 decoded and round-trip byte-exact**, 0 codec errors, 0 unknown discriminators, 0 trailing bytes.
- **Without derivation: 0/643** — the discriminator index built from the published bytes alone is empty.
- **Two independent oracles agree:** anchor-ts (0.29.0) computes the sighash at runtime — **26/26 instructions + 18/18 events byte-exact**; the published sdk's own stored discriminators — **30/30 + 19/19 byte-exact**.
- Instructions observed: `swap` (630), `claimFee` (13). Honest limit: two flows in the traffic, not a tour of all 26 instructions; **0 event payloads**, so the event path on this program is confirmed by both oracles (18/18 each), not by real bytes — same limit as Marinade and Meteora Vault.
- **Inventory drift pinned:** the published copy (0.5.7) carries 4 instructions the on-chain 0.5.2 account does not (`claim_protocol_fee2`, `close_operator_account`, `create_operator_account`, `zap_protocol_fee`); every on-chain instruction exists in the published copy after snake_casing.

Covered by `test/meteora-damm-v1.test.mjs` (7 tests) and pinned fixtures (`meteora-damm-v1-idl.json`, `meteora-damm-v1-anchor-ts-discriminators.json`, `meteora-damm-v1-published-idl.json`, `harvest-meteora-damm-v1-2026-10-29.json`); measurement in [research/coverage-meteora-damm-v1-2026-10-29.json](research/coverage-meteora-damm-v1-2026-10-29.json). Suite: **128/128**. Falsification: disabling the derivation fill fails 2 of the 7 new tests (byte-exact round-trip and the anchor-ts comparison), restoring it passes.

**Remaining limits after seven programs:** all five derivation-only programs are now individually proven against real mainnet payloads (**Kamino Lend 1,432/1,432, OpenBook v2 600/600, Marinade 623/623, Meteora Vault 1,290/1,290, Meteora DAMM v1 643/643**, each byte-exact with 0 decodable without derivation); still no outside user; the derivation is still Anchor-specific; no event bytes observed on the last three programs.

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

Run: `npm test` (the account commit brought the suite to 108; **114** after the fifth program, **128** after the seventh), plus `node tools/accounts.mjs --accounts test/fixtures/accounts-<program>-2026-10-29.json --store <store> --program <id>` to re-measure from a live pull.

**Remaining limits:** still no outside user; **zero trailing bytes were observed**, so the report path for account bytes the IDL does not describe is implemented but unexercised by real data; `repr(C)`/`packed` (zero-copy) accounts are not decoded; account *discriminators* are derived for three Anchor programs — a non-Anchor program's account framing still needs its own scheme, exactly as for instructions; and 39 accounts from traffic of three programs is a convenience sample, not an inventory of what accounts exist on chain.

## Eighth and ninth programs: Meteora DAMM v2 and pump.fun (and a tuple-struct codec fix)

On 2026-10-30 `solana-tx-remix` carried three CPI labels that read `(unknown)` because
the consumer assumed the programs published no on-chain IDL: **Meteora DAMM v2**
(`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, `cp-amm`) and **pump.fun**
(`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`). One sememe pull per program
falsified the assumption:

| program | on-chain source | slot | instructions | events | stored discriminators |
|---|---|---|---|---|---|
| cp-amm | `anchor:idl` @ `F1hSvut...` | 463372654 | 38 | 23 | 38/38 ix, 23/23 ev (100%) |
| pump.fun | `anchor:idl` @ `AYgC53t...` | 463372656 | 47 | 28 | 47/47 ix, 28/28 ev (100%) |

Every stored value matches Anchor's derivation rule byte for byte (38/38, 47/47, 23/23,
28/28), so no gaps had to be filled. Both programs are from the frozen 20-ID set
(indexes 16 and 11) where they were previously classified "usable"; this measurement
proves they actually decode real mainnet bytes.

**Measured on real traffic:** two fresh mainnet harvests (2026-10-30, slots
463380807..463380978) collected **2,890 payloads across 1,661 payload-bearing
transactions** (cp-amm: 1,894 payloads / 809 tx from 22,272 transactions; pump.fun:
996 payloads / 852 tx from 4,459 transactions):

- **cp-amm decodes every payload:** **1,894/1,894 decoded (100%)**, 0 codec errors, 0
  unknown discriminators; **1,888/1,894 round-trip byte-exact**, 6 payloads with
  trailing bytes (all `swap`, 2 with 8 zero bytes, 4 with 1 zero byte) — the deployed
  swap accepts bytes its own interface file does not declare. That residual is now
  measured rather than noted: see *Three wire forms, one interface* below.
- **pump.fun with the on-chain IDL alone:** **669/996 decoded (67.2%)**, 327 refused
  (326 unknown instruction discriminators across five instructions, 1 unknown event
  discriminator); **581 byte-exact**, 88 with trailing bytes.
- **The published first-party IDL names the 326 missing instructions:**
  `buy_exact_quote_in_v3` (107), `buy_v3` (2), `multi_hop_curve_swap` (1), `sell_v3`
  (194), `sweep_creator_fee` (22) — all absent from the on-chain account, all present
  in `pump-fun/pump-public-docs` `idl/pump.json`. The on-chain account is simply stale.
- **Neither source alone describes the deployed program:** with the published copy,
  **880/996 decode** (782 instructions + 98 events); the remaining 116 refusals come
  from `buy` carrying a `partial_fill` argument the deployed program does not always
  send. With the **union** of both, **914/996 decode (91.8%)**, 82 refused.
- **Refusal does not predict on-chain failure:** of 116 refused payloads, **32 were
  part of transactions that SUCCEEDED on-chain** (and 84 failed); of 880 decoded
  payloads, **715 were from transactions that FAILED on-chain** (slippage, etc.). A
  decoder refusal is evidence about the IDL, not about whether the program executed.
- **TradeEvent has an unexplained tail:** every one of the 87 TradeEvents decoded
  under the published IDL carries exactly **8 trailing zero bytes** (`count: 8, hex:
  "0000000000000000"`) no declared field explains.

**Codec defect found and fixed:** Anchor describes a Rust tuple struct (`pub struct
OptionBool(pub bool)`) as `{"name":"OptionBool","type":{"fields":["bool"],"kind":"struct"}}`
— bare types, no `{name, type}` pairs. sememe's struct branch demanded a `name` on
every field and threw `OptionBool: malformed struct field` on **18 payloads** under
the on-chain IDL and **145 payloads** under the published IDL before the fix. The fix
adds tuple-struct support in both decode and encode, matching Anchor's own
representation (`{"0": value}`). Falsification: `test/tuple-struct.test.mjs` fails
against the pre-fix tree (1 pass / 3 fail; the 1 is the fixture-shape guard), passes
4/4 post-fix. After the fix, on-chain decodes 651 → 669; published decodes 851 → 880.

Covered by `test/tuple-struct.test.mjs` (4 tests) and `test/traffic-coverage.test.mjs`
(10 tests); fixtures `test/fixtures/cp-amm-idl.json`, `pump-idl.json`,
`pump-published-idl.json`, `harvest-cp-amm-2026-10-30.json`,
`harvest-pump-2026-10-30.json`. The numbers above are reproduced, not written:
`node tools/traffic-coverage.mjs` emits
[research/traffic-coverage-2026-10-30.json](research/traffic-coverage-2026-10-30.json),
and a test fails if the committed file differs from what the tool computes
(measured: one hand-edited number fails it, restoring passes). Suite: **154/154**
(up from 140).

## Working now: union decode — two verified sources, one payload, disagreement reported

The pump.fun measurement above produced three numbers for the same 996 payloads:
669 (on-chain copy alone), 880 (published copy alone), 914 (a hand-merged union
inside a measurement tool). The union was the only view that described the deployed
program, and it did not exist outside that tool. It does now:

```bash
sememe adopt 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P idl/pump.json --store <dir> --origin pump-fun/pump-public-docs
sememe decode --union 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P <payload> --store <dir>
```

- **`adopt` stores a first-party published copy** content-addressed exactly like a
  pull: canonical bytes, sha-256 fingerprint, write-once object, receipt. The
  receipt says `source: published`, `slot: null` and carries the `origin` the
  caller declared. That distinction is deliberate: `pull` gets its authority from
  the chain, `adopt` is **provenance of bytes, not proof the bytes describe the
  deployed program** — and the decode result must keep saying which source
  answered.
- **The adopted copy can never become the default source.** It sorts before every
  real slot in the single-source reader's filename ordering, so plain
  `sememe decode` reads exactly what it read before this feature existed — the
  pre-existing 154 tests pass unchanged, and a test pins the selection
  explicitly (falsified by mutation M4: letting the adopted receipt win turns it
  red).
- **Both sources are verified by the same reader** (`src/store-read.mjs`): receipt
  program binding, object presence, re-hash against the receipt, address
  agreement. A tampered adopted object is refused **by name in the union path
  too** — not silently dropped in favour of the surviving source (falsified by
  mutation M5).

**The arbitration is decided by bytes, not by preference**, strongest evidence first:

1. both sources decode the same name and args → `agree`;
2. both decode, one re-encodes the **whole** payload and the other does not → the
   full-round-trip source wins (`byte_evidence_full_roundtrip`);
3. neither explains everything, one leaves **strictly fewer** unexplained bytes →
   that source wins (`byte_evidence_fewer_unexplained_bytes`);
4. evidence does not decide → the on-chain primary stands and the drift is
   **reported with the differing field paths** — never absorbed;
5. one source refuses → the other answers, but only with byte evidence behind it
   (`primary_refused` / `secondary_refused`);
6. **two different names for the same bytes → refusal**, not a coin flip
   (`name_conflict`); the same for a secondary source that names bytes it cannot
   reproduce (`union_fallback_refused`).

**Measured, product path, the same 996 pump.fun payloads**
(`node tools/union-coverage.mjs` →
[research/union-coverage-2026-10-30.json](research/union-coverage-2026-10-30.json),
recomputed in CI — a committed-report mismatch fails the suite):

| verdict | payloads | what it means |
|---|---|---|
| `agree` | 546 | both sources decode identical arguments |
| `fallback_secondary` | 246 | 245 payloads of the five stale on-chain instructions + the `SweepBondingCurveFeeEvent` payload the hand-merged union refused |
| `primary_only` | 35 | the published copy's layout is taller than the bytes sent (truncated), the on-chain copy decodes them |
| `layout_drift` | 88 | both decode, arguments differ — reported with field paths, winner chosen by byte evidence |
| refused by both | 81 | the on-chain copy lacks the instruction entirely AND the published copy cannot decode these bytes |
| **decoded** | **915/996 (91.9%)** | 915 re-encode their described prefix byte-exactly; **828 re-encode the WHOLE payload** |

The **+1 over the hand-merged 914** is a real difference, not noise: that merge
added *instructions* only, so the published-only event `SweepBondingCurveFeeEvent`
(`742b4dbd117a482b`) was refused; the product union carries both sources whole.

The 88 drifts are two real, measured disagreements — the reason the union exists:

- **CreateEvent (1 payload):** the published copy declares `depth: u8`, the
  on-chain copy does not. On-chain leaves 1 byte unexplained; the published copy
  re-encodes the **whole** payload, so byte evidence picks it, and the winning
  decode carries `depth`.
- **TradeEvent (87 payloads):** the published copy declares an additional
  `creator_fee_unclaimed: u64`. On-chain leaves 16 bytes unexplained, published
  leaves 8 (the known 8-byte zero tail neither explains) — strictly-fewer-
  unexplained-bytes picks the published copy, and the tail stays visible under
  `drift.trailingBytes` instead of being laundered into a clean decode.

**Falsification:** `bash tools/union-mutations.sh` breaks each rule on purpose —
M1 name conflict, M2 fallback without byte evidence, M3a/M3b the two
byte-evidence arbitration rules, M4 adopted-as-default, M5 tamper check — and
requires exactly the named test to go red in every case, control run green. The
measurements are pinned twice: `test/union-coverage.test.mjs` deep-equals the
committed report against what the tool computes right now, and asserts each
headline count with a message saying what a regression would mean. Suite:
**169/169** (up from 154).

**Limits, stated:** one program, one harvest window, both sources are mine (on-chain
pull + first-party published copy), no outside user. Account decoding still reads a
single receipt — union arbitration is not wired for accounts. An adopted receipt's
`origin` is a declared label, not a verified origin.

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

The middle row is the honest headline: **half** of the sample's usable programs publish an interface that decodes as-is; the other five (Kamino Lend, OpenBook v2, Marinade, Meteora DAMM v1, Meteora Vault) publish names and layouts but no wire discriminators, and only become decodable because the tool can reconstruct them from the name. That reconstruction is verified per program, but it is the tool's inference, not the program's published interface — and it is Anchor-specific. **All five are now individually proven against real mainnet payloads** (Kamino Lend 1,432/1,432, OpenBook v2 600/600, Marinade 623/623, Meteora Vault 1,290/1,290, Meteora DAMM v1 643/643, each byte-exact with 0 decodable without derivation). See [frozen 20 IDs](programs-20.json), [raw classification with slot and account addresses](coverage-result.json), and [selection/chronology limitations](research/selection-method.md). The 20 IDs were committed before the full batch run, but the detailed selection-method note came later; one exploratory Whirlpool RPC check preceded the freeze. Do not call the whole study blind or fully preregistered.

## The stale copies in my own repositories, measured

The claim this repository opens with — "vendored IDL files are snapshots without provenance, a fingerprint, or a freshness check" — was an assertion from notes. `tools/vendored-drift.mjs` turns it into a number for the IDL copies checked into my own repositories, by pulling the on-chain artifact for each program the copy names and comparing the two.

Measured on 2026-10-30 (`research/vendored-drift-tx-remix-2026-10-30.json`):

| vendored copy | instructions | on-chain | missing from the vendored copy |
|---|---|---|---|
| `solana-tx-remix/idl/multi/jupiter-amm/amm.json` | 17 | 19 | `create_idempotent_associated_token_account`, `withdraw_token_account_excess_lamports` |
| `solana-tx-remix/idl/multi/dflow/dflow.json` | 17 | 18 | `withdraw_fees` |
| `solana-tx-remix/idl/multi/jupiter-order_engine/order_engine.json` | 1 | 1 | — |
| `solana-tx-remix/idl/multi/jupiter-rfq_v2/rfq_v2.json` | 1 | 1 | — |
| `aquifer`, `bisonfi`, `solfi`, `spl/token-2022` | 2 / 3 / 1 / 44 | — | no on-chain Anchor IDL exists for these programs |

**Every vendored copy that HAS an on-chain IDL is strictly stale.** That is the whole claim, measured rather than asserted — and the staleness is not academic: `create_idempotent_associated_token_account` appears in **real mainnet traffic**, so a decoder built on the vendored copy emitted `(unknown)` for a successful instruction, and `(unknown)` is the one state every label check deliberately skips.

The four programs with no on-chain IDL are not a gap in the store: they are native or shank-origin programs that publish no Anchor IDL account at all. For those the checked-in file is the only description available, and it is kept.

The tool distinguishes three defects, because they are not the same defect: a **stale** copy (has an on-chain IDL, and it differs), an **unbound** copy (declares no program address, so it binds nothing — the `bisonfi.json` failure mode `solana-tx-remix` already documents), and a copy for a program that has no on-chain IDL at all.

### The measurement tool misclassified 396 payloads as "unknown to both" (measured 2026-10-30)

The traffic column of that report split payloads the vendored copy cannot name into three buckets: named by the on-chain copy as an instruction, an Anchor `emit_cpi!` event self-CPI, or unknown to both copies. The published numbers were **773 payloads, 5 unnamed by the vendored copy, 0 event self-CPIs, 396 unknown to both**.

That was wrong, and it was wrong in the direction that looks like a coverage finding. Anchor event payloads are `EVENT_IX_TAG (8) ++ event_discriminator (8) ++ borsh(body)`, so the discriminator that identifies the event sits at bytes **8..16** — the tool looked up bytes **0..8**, which is the *tag*, in the event table. The tag is never an event discriminator, so the lookup always missed: all 396 tagged Jupiter payloads were published as "unknown to both copies" while the event bucket stayed empty, even though this repository's own decoder names every one of them (README above: *773/773 payloads decoded — 377 instructions + 396 Anchor event self-CPIs*). The measurement and the decoder contradicted each other, and the report was the wrong one.

The fix looks up bytes 8..16 when the payload starts with the event tag, and the tag constant is now imported from the decoder (`EVENT_IX_TAG_HEX` in `src/codec.mjs`) instead of being written out a second time. Regenerated against the same committed harvest:

| | payloads | unnamed by vendored | event self-CPIs | unknown to both |
|---|---|---|---|---|
| before | 773 | 5 | 0 | 396 |
| after | 773 | 5 | **396** | **0** |

The finding that mattered is unchanged: the vendored Jupiter copy still cannot name `create_idempotent_associated_token_account`, which appears in **5 real mainnet payloads**. What changed is that the other 396 payloads are no longer charged to a defect that does not exist — a decoder that names them was always in the room.

The falsification is committed: `test/vendored-drift.test.mjs` pins the classification against the real committed harvest (396 event self-CPIs, 0 unknown to both, 5 unnamed by the vendored copy) and against a synthetic three-payload case (one tagged event, one shared instruction, one genuinely unknown). Against the pre-fix tool the synthetic test fails (`eventSelfCpiPayloads` 0 instead of 1) and the real-data assertions fail with it.

## A second consumer reads the artifact for every program it names

`solana-tx-remix` migrated its single-program Whirlpool path first. Its multi-program path kept reading the vendored copies — and the measurement above is what that cost: `(unknown)` on a real Jupiter instruction, in a transaction that was otherwise described in full.

Both of that consumer's entry points now resolve labels through one resolver (`buildStoredResolver` in its `src/dispatch.mjs`) that layers the stored artifacts over the vendored copies. The overlay is additive per program, so the vendored copy still describes the programs the store does not cover.

Two things it does not paper over, both measured:

- A **stored** discriminator wins over a **derived** one, and the disagreement is reported. Jupiter AMM v6 stores `5368c096` for `create_idempotent_associated_token_account` where Anchor's rule derives `bdbcecfa`; five real payloads carry `5368c096` and re-encode byte-exactly. The stored value is the one that survives contact with the chain.
- Every reader of the store re-hashes the object against its receipt. The consumer's multi-program loader did not at first, and its acceptance harness caught the difference: a tampered Jupiter object (valid JSON, one instruction renamed) was **accepted** by the multi path while the single path refused the identical damage. One store with two readers must verify with one strength.

### The producer's own reader was the weak one (measured 2026-10-30)

The sentence above was true of `solana-tx-remix` and false of `sememe`. A probe against `sememe`'s own reader (`src/decode.mjs`, `findStoredIdl`) built a store from the committed Whirlpool snapshot, renamed one instruction in the object — still valid JSON, still a decodable IDL — and decoded a **real mainnet `swap_v2` payload** against it:

```
INTACT decode  -> swap_v2                       | fingerprint sha256:0b886e3...
TAMPERED decode-> totally_honest_name            | roundTripByteExact true
```

The reader took the receipt's fingerprint as a label, printed it as the provenance of bytes it had never checked, and reported the tampered name as a decode result. `roundTripByteExact: true` is the sting: the damage was *only* in the name, so every byte-level check passed. The consumer refused the identical damage; the library that produced the store accepted it.

Four checks now stand between a receipt and a decode (`src/decode.mjs`, `findStoredIdl`):

1. the receipt's `program` field must be the program asked for (a receipt swapped in from another program's file is refused by name);
2. the receipt's fingerprint must be a well-formed sha256;
3. the object must exist, parse as JSON, and carry an instruction list;
4. `sha256(canonicalJson(idl) + '\n')` must equal the claimed fingerprint — **the check that was missing**, plus a separate refusal when the object's own `address` names another program.

Every one of the five is pinned by a test that asserts the refusal *and its reason*, in `test/store-integrity.test.mjs`. Each was falsified by mutation: removing the re-hash check, the program-binding check, the missing-object message, the address check or the unparsable-JSON message turns exactly one of them red, and restoring it turns it green. The pre-fix behaviour is reproducible from the same test file by deleting the re-hash block.

The CLI now refuses too: `sememe decode` on a tampered store exits 1 with `object and receipt disagree, refusing to decode`, naming both hashes. Before the fix the same command printed the tampered instruction name and exited 0.

The falsification is a committed control: `solana-tx-remix`'s `neg/idl-name-stored-only.ts` relabels the newly-named instruction to a name the stale vendored copy carries, and the verifier answers `bytes resolve to create_idempotent_associated_token_account ... recipe claims create_token_account` — exit 1.

## Native programs: the two every transaction carries, pinned from the runtime (2026-10-31)

System and ComputeBudget have no IDL account to pull — their interface lives in the Solana runtime itself. Sememe decoded neither; its first consumer (`solana-tx-remix`) carried a hand-transcribed copy of both instruction tables instead, which is exactly the per-repository hand-build this repository exists to replace. The cost of that copy was not hypothetical, it was measured: over a real mainnet harvest, **the hand table could name 0 of 63 on-chain `CreateAccountWithSeed` payloads**, because it reads a 4-byte string length header while the chain carries a u64 (bincode fixint) length word — every later field sat 4 bytes off, so the payload never matched the declared shape.

`src/native.mjs` now decodes both programs from a pinned interface, with the provenance chain written into the file: the upstream enum (anza-xyz/solana-sdk, pinned by commit), the runtime's acceptance rule (anza-xyz/agave: borsh `try_from_slice_unchecked`, where an unclaimed tag is `InvalidInstructionData`), and the corroboration (`@solana/web3.js`'s own layouts, read as the same u64 length word). Three facts the pins settle and a hand copy is free to get wrong:

- **Tag 0 of ComputeBudget is wire-rejected.** The runtime refuses the reserved `Unused` variant; `@solana/web3.js@1.98.4` still *encodes* legacy `requestUnits` as tag 0 + (u32, u32). This decoder refuses tag 0 with `wire-rejected` instead of copying the SDK's opinion.
- **System has 14 variants, not 12.** `UpgradeNonceAccount` (12) and `CreateAccountAllowPrefund` (13) exist upstream; a 12-entry table answers `null` on those bytes.
- **The string header is u64.** web3.js writes it as u32 length + u32 zero padding; read as one word, that *is* the bincode fixint length. The defect was dropping the padding word, not a layout disagreement.

Measured against real mainnet traffic (1,828 System payloads + 1,348 ComputeBudget payloads, harvested 2026-10-31, [reports](research/native-coverage-system-2026-10-31.json)):

| decoder | System named | ComputeBudget named |
|---|---|---|
| hand-written table (the one being replaced) | 1,765 / 1,828 | 1,348 / 1,348 |
| sememe pinned table | **1,828 / 1,828, all byte-exact re-encodes** | **1,348 / 1,348 (1,321 byte-exact)** |

The 27 ComputeBudget payloads that are not byte-exact all carry trailing bytes after the declared argument. Chain adjudication (9 fetched directly, byte-identical to the harvest) shows the bytes are real and the runtime tolerates the remainder — every one sits in a transaction that failed at a *later* instruction. They decode with `trailing: { count: n }` reported, and are refused under `--trailing error`, the same contract the IDL decoder uses.

Falsification: the new test file (`test/native.test.mjs`, 10 tests) was run against the old hand-written table, adapted to the same API surface with the table itself verbatim: **7/10 fail, 3/10 pass, and the three that pass are the designed ones** — the false-positive guard (a System `Transfer`, the one case the old table decoded correctly), the dependency-free import check, and the report test. Against the pre-module tree the file fails outright. A committed coverage report is re-derived from the committed fixture on every test run, so hand-editing the numbers goes red.

CLI: `sememe decode-native <program> <payload>` decodes with the pinned interface; `sememe native-provenance [program]` prints the pinned sources, the encoding rules and the measured traffic.

### The token tables are derived too (2026-11-02)

The same argument applies to the two token programs, and the stake is higher:
**SPL Token and Token-2022 publish no IDL account at either pullable address**,
yet they carry 43% of real watched mainnet traffic. Their interface is the
upstream Rust interface crate, and their wire rule lives in hand-written
`pack()`/`unpack()` pairs rather than in a Borsh enum — so the derivation reads
upstream's own text:

- `vendor/spl-token/<commit>/…` and `vendor/spl-token-2022/<commit>/…` carry the pinned
  interface files (Apache-2.0, LICENSE included) of `solana-program/token@737788ff` and
  `solana-program/token-2022@5251dcc0`; their sha256 is the pin.
- `src/token-interface.mjs` derives each variant's wire shape from the upstream TEXT: the
  tag is the integer upstream `pack()` writes and `unpack()` matches (explicit tags, so
  `WithdrawExcessLamports` is 38 and `UnwrapLamports` 45 — the declaration index would
  say 25 and 26), the arg sequence is the pack arm's byte-write sequence, and the
  `COption` encoding is upstream's own `pack_pubkey_option`/`pack_u64_option` (1 tag byte
  + payload, not a bincode option wrapper). It refuses on any surprise: a tag in only one
  of the two arms, an upstream byte write no pinned rule covers, a field upstream does not
  declare, a variant upstream declares that this table does not name. The variant list
  itself is derived from upstream's enum — so a new upstream instruction fails loudly
  instead of decoding as "unknown".
- `tools/token-interface.mjs` writes `interface/token-<program>.json` (28 variants for SPL
  Token, 48 for Token-2022); `--check` fails when the committed artifact differs from a
  fresh derivation.
- `src/token.mjs` RE-DERIVES at load and refuses to decode unless the committed artifact
  equals the derivation byte for byte — the same two-check contract as the native tables.
  It ships as `sememe/token`; the CLI is `sememe decode-token <program> <payload>` and
  `sememe token-provenance [program]`.

Measured on the unbiased traffic sample (four contiguous finalized blocks, 12,572 watched
payloads): the two token programs' 5,402 payloads went from **0 decoded** (no interface
acquirable at all) to **5,401 decoded**, one refusal (a `spl-token-metadata` fallback
instruction — a different upstream crate, refused by name rather than force-fitted) and
422 payloads with explained trailing bytes. Overall coverage on that sample moved from
**55.5% to 98.5%**; the denominator never moved, the product gained a decode path.
(A later step — adopting Jupiter Lend's published Liquidity IDL, see below — moved
it to 98.6%; the Raydium AMM v4 derivation, also below, took no-interface to 0. The
token-metadata fallback, one step further, closed the last token refusal.)

Falsification (`test/token-interface.test.mjs`, 8 tests, each a mutation in a temp copy of
the repo): swap two args in the artifact → load refused; edit the vendored Rust → load
refused with both sha256s named; delete `vendor/spl-token-2022` → load refused. The
measured-wire test pins the real numbers (a 1,000,000-amount Transfer, a TransferChecked
amount-then-decimals pair, a SetAuthority byte that decodes to `MintTokens`) and pins the
refusal reasons for an unknown tag, a truncated payload and an invalid option tag.

Limits: Token-2022's 15 extension dispatch tags are named at the top level only — their
sub-instruction bytes report as trailing, because the extension crates are separate
interfaces this table does not vendor. Upstream's `Batch` (tag 255) unpacks but
the processor refuses it — the table records the wire shape, not a runtime guarantee.
(The `spl-token-metadata` fallback crate IS vendored now — see the next section.)

Limits: Linux-mainnet measured only; the strict-20 coverage study does not include the native programs (they were never part of the sample, so no coverage number moved); the runtime acceptance rule is checked against the agave source at one point in time, not against a live validator; no outside user yet.

### The rows are derived, not typed (2026-10-31, later the same day)

Even a pinned, measured table is still a table someone typed — and this repository's whole
premise is that a copy that can drift is the defect. The native tables were the last
hand-transcribed rows in sememe. They are now DERIVED:

- `vendor/anza-solana-sdk/<commit>/…` carries the two pinned interface files from upstream
  (Apache-2.0, LICENSE included), fetched at the pinned commit; their sha256 is the pin.
- `src/native-interface.mjs` parses each pinned `pub enum` — declaration order is the wire
  selector, struct-variant field order is the wire order, the tuple type is the arg type —
  and refuses on any surprise (wrong variant count, unknown type, duplicate name, an
  undeclared unit variant). It is dependency-free like the rest of the decode core.
- `tools/native-interface.mjs` writes the derived tables to `interface/native-<program>.json`;
  `--check` fails when the committed artifact differs from a fresh derivation.
- `src/native.mjs` RE-DERIVES at load and refuses to decode unless the committed artifact
  equals the derivation byte for byte. Two callers, one derivation: an edited artifact and
  a swapped vendored file both fail loudly at import, before a single byte is decoded.

Falsification (`test/native-interface.test.mjs`, 7 tests, each a mutation in a temp copy of
the repo): swap two rows in the artifact → load refused; change `SetComputeUnitLimit(u32)`
to `(u64)` in the vendored Rust → load refused with both sha256s named; delete `vendor/` →
load refused. Removing the load-time equality check turns the first two into silent passes.
A separate pin asserts the three argument names a hand copy actually got wrong upstream —
`micro_lamports`, `from_seed`, `from_owner` (the in-flight camelCase transcription had all
three).

The consumer's copy is gone too: `solana-tx-remix/src/native.mjs` is now a thin facade over
this module (its own hand table removed), and its acceptance suite gained check 7, which
re-measures every defect the hand table had against committed traffic — 63/63 seeded creates
named and byte-exact (hand table: 0/63), variants 12/13 nameable, tag 0 refused, upstream
argument names — plus a run of `native-interface.mjs --check`.

## Harvesting from the local mailbox instead of RPC (2026-10-31)

`tools/harvest-reeflog.mjs` writes the same document `tools/harvest.mjs` writes, but reads the instruction bytes from a local [reeflog](https://github.com/auroraxo/reeflog) mailbox (its account envelope carries `instructions[]` verbatim — program ids resolved against the canonical account list, data base58 as served) instead of paying `getSignaturesForAddress`/`getBlock`/`getTransaction`. The source is in the document (`rpc: none (local reeflog journal)`), and the row accounting keeps the debts the network harvester does not have: rows without an envelope and envelopes without instructions are counted separately, never dropped, and a journal with zero enriched rows exits non-zero instead of writing a zero-payload success document.

**Zero RPC is enforced, not asserted:** `tools/lib/network-guard.mjs` replaces `globalThis.fetch` with a function that records the attempt and rejects; the harvester imports it *first* (pin: `test/harvest-reeflog.test.mjs` fails if the import order changes), and the run exits 1 if `guard.attempts` is ever non-empty.

**Live proof** (`tools/e2e-reeflog-harvest.mjs`, report: [research/reeflog-harvest-e2e-report.json](research/reeflog-harvest-e2e-report.json)): a fresh 45-second mainnet window for Whirlpool — 456 journal events, 452 account envelopes held — harvested for **156 payloads across 137 transactions with 0 network attempts**. Two directions checked against independently fetched chain transactions: **10/10 sampled payload-bearing transactions byte-identical** (`JSON.stringify` of the payload records, same order, same key order), and **10/10 sampled no-target transactions corroborated** (the chain shows no Whirlpool instruction either — a real contradiction there would mean the extractor drops bytes, and it is a named check). 0 different, 0 unavailable.

The equivalence is pinned by mutation, twice: swapping `dataBase58`/`dataHex` in `payloadsFromEnvelope` turns 2 unit tests red, and turns the live run red at `mailbox_bytes_equal_chain_bytes` (8 of 10 sampled different). A third defect this harness caught before any of it: the first version of the e2e requested `maxSupportedTransactionVersion: 0`, which rejects every v1 transaction with rpc error -32015 — the retry loop misreported those as rate limiting (2/12 sampled), while `harvest.mjs` has requested version 1 all along. The harness now reports permanent client errors as what they are.

**Limits:** the mailbox is my own reeflog daemon, not a third-party producer; the sample is 10 + 10 transactions from one 45-second window; the envelope is fetched by reeflog's own `hydrate --accounts` pass (the cost moved to the mailbox, it did not disappear).

## Tenth program: the Jupiter RFQ stack, and the first live "the wire changed shape" firing (2026-11-01)

The suite already said what would count as a serious finding: in `test/decode.test.mjs` the unexplained-bytes guard reads *"a non-zero tail would mean the IDL is missing a real field, which is a different and more serious finding than padding."* Until now every observed tail was zero padding. **The Jupiter RFQ stack now fires that exact case — and the first measurement of it was wrong in a way worth recording.**

**`rfq_v2` (`fd3nMFYTQjX1yr5ER8u7tPdHJB7qt8RpDpNtLQX2Br5`) — the path is whole.** 40 payloads across slots 463374166–463994162 (21,179 pinned transactions, 0 missing): **40/40 named `fill_exact_in`, 40/40 byte-exact round-trip, 0 payloads with a trailing byte.**

**`order_engine` (`2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1`) — the live wire has two forms, and only one is described anywhere.**

| wire form | payloads | described bytes | trailing | full round-trip |
|---|---|---|---|---|
| 32 bytes | 82 | 32/32 | 0 | 82/82 byte-exact |
| 40 bytes | 59 | 32/32 (the described prefix) | **8, undeclared** | 0/59 |

Both forms are `fill`, both are accepted by the same deployed program, and they **coexisted** in the overlapping window (slots 463951326–463985613). After the last 32-byte payload (slot 463985613) the wire carries **only** the 40-byte form — 45 consecutive payloads.

The 8 extra bytes are structured, not padding: **a constant 4-byte tag `0x06942069` (little-endian, present in 59/59) plus 4 varying bytes that are pairwise distinct across all 59 payloads**. The described 32-byte prefix re-encodes byte-exact on every single one, so this is not a decoder bug on the three arguments the sources do describe.

Why the gap is real and not stale-pull noise:

- The program's **own on-chain IDL account** (`GJwPa6DAFzYKNddAgxwzKzuDgnE4NeaWkKPN9FFqkmkb`, owner = the program itself) declares `fill` with **three** arguments (`input_amount: u64`, `output_amount: u64`, `expire_at: i64` = 24 bytes). A fresh `sememe pull` at slot 464073733 returns **the same fingerprint** (`sha256:f13a31e6…`) as the receipt pinned at slot 463089384 — the description did not change.
- The **first-party source** ([jup-ag/rfq-webhook-toolkit](https://github.com/jup-ag/rfq-webhook-toolkit) @ `3aa4fce`) declares the same three arguments in `programs/order-engine/src/lib.rs`, and `git log --all -S` finds no history with a fourth.
- The **vendored copy** in `solana-tx-remix/idl/multi/jupiter-order_engine/order_engine.json` has the identical single instruction and the identical discriminator `[168,96,183,163,92,10,40,160]`.
- The bytes are **accepted**: all 141 payload-bearing transactions succeeded on chain (`txErr: null`).
- Hypotheses tested and **rejected**: tail equals a declared argument (BE/LE), equals `expire_at` (raw or ×1000), equals the slot (raw or ×1000), equals a window of the transaction signature, or is a price-like ratio of `output_amount`/`input_amount` (spread ~10×). The varying 4 bytes are client-emitted and not derivable from the payload, the signature, the slot, or the declared args.
- **The rejection is now reproducible, not remembered.** `tools/tail-hypotheses.mjs` re-derives every count from the committed fixture ([research/rfq-order-engine-tail-2026-11-01.json](research/rfq-order-engine-tail-2026-11-01.json), human-readable table in [research/rfq-order-engine-tail-2026-11-01.md](research/rfq-order-engine-tail-2026-11-01.md)). New and stronger this round: the **entire affine class** `tail ≡ A·base + B (mod 2³²)` is refuted for base ∈ {slot, expire_at, input_amount, output_amount} — A and B are derived from the first two payloads with an invertible delta, never fitted to the verdict. One refutation covers the constant offset, every seconds→milliseconds→microseconds rescaling, and every scaling of a declared argument. The SHA-256-prefix and CRC-32 checksum interpretations are refuted per-payload as well. Two measured bands constrain what remains: the varying u32 (LE) never uses the u32 space — its top byte is only `0xAC`/`0xAD` across all 59 payloads (16 high bits confined to [0xACAB, 0xADCC], ~0.004% of the space) while the low 16 bits are fully distinct; and the varying value does not correlate with slot, amounts, or expire_at (|r| ≤ 0.17). The field stays **unidentified**: whatever it is, it is not a single word carried in this instruction, and the strongest surviving hypothesis is a value derived from state outside the instruction bytes (the fixture does not pin the surrounding transaction), or a field of an interface revision whose description was never published.

**The correction, stated plainly.** A first, narrower 30-block harvest saw only the 40-byte form (32 payloads, all with undeclared bytes) and I concluded *"every live fill carries 8 undeclared bytes"*. A 140-block scan **falsified that**: the 32-byte form is real and ran alongside the 40-byte form. The committed fixture is the wide scan, and every number above is derived from it. The difference matters for the product — the finding is not "the decoder misses a field", it is **"the deployed program's wire changed shape and no interface description followed"**. A decoder built only from the published interfaces now refuses 100% of the recent live traffic on this program.

**Both remaining hypotheses were refuted on chain (2026-11-01), and the finding's shape changed.** The 14:00 study left two explanations standing: a value derived from state outside the instruction bytes, or a field of an interface revision that was never published. Two read-only probes (public RPC, every fetch counted in the reports) closed them:

- **No published revision.** A fresh pull of *both* published IDL surfaces — the canonical `anchor:idl` account and the program-owned metadata account — reproduces the receipt fingerprint `sha256:f13a31e6…` (measured at slot 464182250). Nothing on chain declares a 4th argument, so "a revision nobody published" cannot explain bytes that are on the wire **now**, in every transaction.
- **Nothing outside the instruction carries it.** For 6 fills spread across the slot range: **0** matches of the varying u32 (or the assembled `tag<<32|word` u64) in the transaction's balance surface (pre/post lamport and token balances, raw and `mod 2³²`), **0** in any sibling instruction's bytes (outer + inner), **0** in every touched account's data (`getMultipleAccounts` over the transaction's own account list), and **0** in the program's own state accounts (`getProgramAccounts`: 1 account, 1078 bytes — the compressed IDL itself; the program is stateless).
- **The attribution that decides it:** every one of the **59** long-form fills was attributed from the chain to counterparty `MfDuWeqS…`, and every one of the **82** short-form fills to a *different* counterparty, `7rhxnLV8C7…` — **141/141 resolved, zero overlap** ([research/order-engine-counterparty-2026-11-01.json](research/order-engine-counterparty-2026-11-01.json)). The 8 undeclared bytes are **one counterparty's own extension of a shared protocol instruction**, not a protocol change and not protocol state.

**Who that counterparty is, measured (2026-11-02).** "Counterparty = the `maker` account" was an inference from the instruction's account list; two premises behind it were still unchecked, and both now have chain measurements ([research/order-engine-maker-identity-2026-11-02.json](research/order-engine-maker-identity-2026-11-02.json), `tools/order-engine-maker-identity.mjs`, all 141 fixture transactions re-fetched, payloads byte-identical to the fixture 141/141):

- **The makers are key-holding clients.** Both maker addresses are on-curve (an exact ed25519 decompression test — an off-curve address *cannot* hold a key, which would have made "client" wrong), system-owned, carry 0 bytes of data, and **sign** their transaction (141/141). The takers sign too (141/141). The maker never pays the fee: the fee payer is the taker in 110 transactions and the undeclared co-signer in 31 (107 distinct fee payers — not one service wallet).
- **The account list carries more than the IDL declares.** The IDL declares **11** accounts for `fill`; the wire carries **12** (52 transactions) or **13** (89 transactions) — never 11. The extra accounts are constant in role: one variable slot (the order_engine program itself, or an off-curve derived address) plus `pAEmG7…`, which appears in **141/141** transactions and **signs every one of them** — a co-signing party the IDL does not mention at all. An account list is a carrier of meaning on Solana, and this channel was unmeasured until now.
- **The limit that travels with the verdict:** three parties sign each fill (taker, maker, co-signer), so *which* of them constructed the 8-byte extension is **not** proven by the correlation with `MfDuWeqS…` — the builder among the three signers is explicitly not claimed. The 4 varying bytes still have no identified meaning: sha256 of the referenced account, sha256 of the signature, the slot, both amounts, `expire_at` and the account's address boundaries were all tested against the 59 payloads and refuted (0/59 hits).

So the honest headline is narrower than "the wire changed shape": the deployed program accepts a counterparty-appended tail that no interface source describes. `trailing.count` remains the only place this surfaces for a decoder built from published interfaces, and it must not be normalized away.

**What this changes in the product.** "Unexplained bytes" used to mean padding, and permissive `trailing: 'report'` was a courtesy. It is now a **live-drift signal**: `trailing.count` is the only place this surfaces, and it must not be normalized away. Two behaviours are pinned as measured, not as desired — permissive mode keeps **serving** both forms (the chain accepted them; refusing would be a decoder defect, not a safety property), and strict mode **refuses only** the 40-byte form instead of pretending a field exists that no source declares.

The committed fixtures (`test/fixtures/harvest-{rfq-v2,order-engine}-2026-11-01.json` plus the two on-chain IDL receipts) make this re-measurable: `test/rfq-stack.test.mjs` (8 tests) re-derives every number above from the fixtures. If a future interface description accounts for the extra field, `trailing` drops to 0 and the test goes **red**, so the number gets re-measured instead of going quietly stale. The counter-test pins the fixture itself: editing the committed IDL to declare a 4th `u64` argument fails the suite, because "the interface now covers 40 bytes" is a **new claim that needs new evidence** (a re-pull of the on-chain account), not a fixture edit.

**Limits:** 141 payloads from one program id in one slot range; the extra field's *name and type* are still unknown — what is measured is that 8 structured bytes exist, are stable per payload, and are undeclared by every available interface source, and that the varying word is drawn from a narrow band that no interpretation recorded so far produces. The upstream SDK decodes `fill` with 3 args, so if a 4th field exists it is one the SDK also does not name.

### Reported to the first party (2026-11-02): jup-ag/rfq-webhook-toolkit#96

Both wire findings above were delivered to the first-party repository as [issue #96](https://github.com/jup-ag/rfq-webhook-toolkit/issues/96): the undeclared co-signer account (present in 141/141 fills, signs all of them, pays the fee in 31/141) and the 40-byte form with its constant `0x06942069` tail tag. The issue carries one-click reproductions for each claim (fill tx `3iTpfkc7…` for the account list, `3cQfqyqaD…` for the payload), the fixture and report paths, and the limits stated as limits: which of the three signers builds the 8 bytes is not proven, the 4 varying bytes stay unidentified, and the 19 refuted interpretations remain named. The earlier, separate stale-IDL address finding is tracked as [#95](https://github.com/jup-ag/rfq-webhook-toolkit/issues/95).

This is delivery, not adoption: no response exists yet, and neither issue makes sememe's first outside user — that threshold stays "a third party imports the artifact and 1,000 transactions decode without disagreement."

## Eleventh program, third wire form: cp-amm's `swap` accepts three shapes (2026-11-02)

The RFQ finding above is a program whose wire changed shape with **no** interface following. cp-amm is the opposite shape of problem, and it resolves the residual that the 30.10. traffic-coverage note left open: that note said the deployed `swap` *"reads further than its own interface file"*. **That sentence was wrong in an important way, and the measurement says so.**

**The interface describes exactly one shape.** The program's own on-chain IDL account (`anchor:idl` @ `F1hSvutXSc9iAvB9bQPmjNDwiN2tCXzazTEEvDgNCBMa`) declares `swap` with one argument, `SwapParameters { amount_in: u64, minimum_amount_out: u64 }` — 8-byte discriminator + 16 bytes = **24 bytes, the only length it can describe**. The upstream source agrees ([MeteoraAg/damm-v2](https://github.com/MeteoraAg/damm-v2) @ `5398b5c`, `programs/cp-amm/src/instructions/swap/ix_swap.rs`): `pub struct SwapParameters { pub amount_in: u64, pub minimum_amount_out: u64 }`.

**The chain carries three shapes.**

| wire form | bytes | described by the IDL | trailing | accepted on-chain |
|---|---|---|---|---|
| 24 B | 477 (30.10.) / 284 (02.11.) | 24/24 | 0 | yes |
| 25 B | 4 / 3 | 24/24 (the described prefix) | **1 zero byte, undeclared** | yes, 7/7 |
| 32 B | 2 / 0 | 24/24 (the described prefix) | **8 zero bytes, undeclared** | yes, 2/2 |

Measured over two independent mainnet windows — the committed harvest of 30.10. (slots 463380931..463380978, 48 blocks, 1,894 payloads) and a **fresh harvest of 02.11.** (slots 464398786..464398809, 24 blocks, 5,633 transactions fetched, 0 missing, 1,001 payloads) — so the wide form is not a one-window artifact: it appears in both, three days apart, and **still appears today**.

**The extra bytes are not read, they are tolerated — and the program's own source proves it.** The deployed program does not use Anchor's dispatcher; it has a hand-written fast entrypoint (`programs/cp-amm/src/entrypoint.rs`) that does:

```rust
let swap_parameters = unwrap_or_return!(
    SwapParameters::deserialize(
        &mut &instruction_data[crate::instruction::Swap::DISCRIMINATOR.len()..]
    )
);
```

`deserialize` here is borsh's **slice** reader: it reads the two `u64` it needs and leaves the rest of the buffer alone. Anchor's own `deserialize` has the same property, which is why sememe's permissive `trailing: 'report'` mode exists at all. So the deployed program does **not** parse bytes past its own struct — it accepts a payload with bytes appended. The 30.10. wording ("reads further than its own interface file") overstated it, and the correction matters for the product: **an over-long payload is not evidence of a missing field**, and a decoder must not invent one. A missing field would carry information; these bytes carry none.

**The 25-byte form is a `swap2` body under the `swap` discriminator.** Its body is **byte-identical** to what the interface's *other* instruction would encode: `swap2` takes `SwapParameters2 { amount_0: u64, amount_1: u64, swap_mode: u8 }`, and re-encoding the same two amounts through `swap2` with `swap_mode = 0` reproduces the 25-byte body exactly — verified on every 25-byte payload, in both windows. The 32-byte form is the same idea with 8 bytes of zero padding (the trailing bytes are **zero in 9/9** wide payloads — padding, not a field). So a client that switched from `swap` to `swap2` and kept sending under the old discriminator produces exactly these shapes.

**Where they come from, measured on chain** ([research/cp-amm-wire-forms-2026-11-02.json](research/cp-amm-wire-forms-2026-11-02.json), `tools/cp-amm-wire-forms.mjs`, every fetch counted, 0 failures):

- **9 wide payloads, 12 IDL-exact controls** — a control group, so "the wide form comes from somewhere else" is a contrast and not a sample of one.
- **8 of 9 wide payloads are top-level** (8 of 12 controls likewise) — the wide form is **not** a CPI-only artifact; the same mix appears in both groups. One wide payload is a CPI, invoked by `4X3dGCFh63SyE2bNZdGUV7Rj5ukK1XgrxesoxyKQNiRN`.
- **7 distinct fee payers among 9 wide payloads** — not one service wallet or one bot; and **zero overlap** with the controls' fee payers.
- **9/9 wide payloads were accepted on-chain** (`txErr: null`), against 8 of 12 controls that failed on-chain — which is the repo's own rule from the RFQ section: *decode refusal is evidence about the IDL, not about whether the program executed*, applied in the other direction here.
- The wide payloads carry the **declared 14 accounts** (top-level) or 18 (the CPI case) — the account list is not the carrier.

**The interface has not moved.** A fresh `sememe pull` of the program's on-chain IDL today (slot 464399566) returns fingerprint `sha256:e80f49b1…` — **byte-identical** to the fingerprint of the fixture pulled on 30.10. So "the published interface is stale" is refuted by a measurement, not assumed; the description has not changed in three days while the chain kept sending all three shapes.

**What this changes for sememe.** The residual is now a named, reproducible *tolerance* finding instead of an open question:

- The permissive mode is **right** for this case, and now for a measured reason: the program accepts these payloads, so refusing them would be a decoder defect. `trailing.count > 0` stays the place where the fact surfaces.
- The **strict** mode refuses only the wide forms — and refuses them *as undeclared*, not by inventing a field for the extra bytes. The test pins exactly that: the 25-byte body must equal a `swap2` body, and every trailing byte must be zero.
- A consumer who wants the narrower meaning can read the 25-byte form as `swap2`/`swap_mode = 0` — that is a **client-side interpretation** the interface does not license, and sememe does not perform it silently.

**Falsification.** `test/cp-amm-wire-forms.test.mjs` (6 tests) re-derives every number above from the two committed fixtures and the committed IDL, and pins the observed wire-length set as exactly `{24, 25, 32}` / `{24, 25}` so a new shape goes red instead of widening the finding silently. The committed report is cross-checked against the fixtures (no hand-edited numbers). Mutation ladder, each mutation red on its own check: editing the report's wide count (1 fail), making one trailing byte non-zero (2 fail), marking a wide payload as failed on-chain (1 fail), introducing a new wire length 26 (3 fail) — restored tree green 6/6. Suite 244 → **250/250**.

**Limits.** Two windows and one program id; 9 wide payloads total, so the *frequency* is not established (1.24% of `swap` payloads in 30.10., 1.05% in 02.11. — small samples on both sides). The 32-byte form did not appear in the fresh window, so it may be rarer now or slot-bound; that is stated, not resolved. The claim that the extra bytes are *tolerated* rests on the upstream source of the deployed program at one commit (`5398b5c`) — the deployed **binary** was not disassembled, and the on-chain IDL is not proof of what the binary does. No third party is involved; this is a measurement about a program's wire, not an adoption claim.

## Coverage measured on unbiased traffic (2026-11-02)

Every qualification above measured programs that were CHOSEN — usually programs
already in the store. The sample and the store therefore shared a selection
bias, and a favorable fraction measured against them is not a coverage number.
This section measures the other way round.

**The sample.** `tools/traffic-sample.mjs` takes the newest finalized mainnet
blocks (four contiguous slots, 2,214 transactions) and inventories EVERY
instruction in them, without asking the store anything. Programs outside the
watched list are counted but their bytes are not stored (fixture size limit), so
the denominator cannot silently shrink. The fixture is committed
(`test/fixtures/traffic-sample-2026-11-02.json`, captured 2026-11-02T15:50Z),
together with a store built for exactly this sample
(`test/fixtures/traffic-sample-store/`: ten on-chain pulls plus four adopted
first-party published copies).

**The measurement.** `tools/traffic-coverage-report.mjs` runs every payload
through the product's own entry points — `decodeUnionPayload`, `decodePayload`,
and the native, token and Raydium decoders — and asks one question per payload:
could sememe have NAMED it? The four outcomes are kept apart on purpose.

**First run, same day, same sample (kept for the record):** decoded 6,983,
refused 171, no-interface 5,418 — 55.5% coverage, with 99.7% of the gap on SPL
Token + Token-2022, which publish no IDL account at either pullable address.
That measurement named the fix, and the fix shipped the same day: the two token
wire tables are now DERIVED from the pinned upstream Rust crates
(`solana-program/token@737788ff`, `solana-program/token-2022@5251dcc0`, both
Apache-2.0, both vendored with license + sha256 pin) — the System/ComputeBudget
pattern, one level up: the wire rule lives in the crates' hand-written pack()
and unpack() pairs, so the derivation reads the pack arm's byte-write sequence
cross-checked against the unpack arm's tag set, and refuses any upstream write
it cannot pin. The decoder ships as `sememe/token` (artifact + load-time
derivation check, same two-check contract as the native tables).

| outcome (current) | count | meaning |
| --- | --- | --- |
| decoded | 12,401 | an available interface named it |
| refused | 171 | an interface exists and the bytes were refused (source lag in the pump programs' wire forms) |
| no-interface | **0** | no payload in this sample lacks an interface |

**98.6% coverage** (12,401/12,572 watched payloads), with 11,708/12,401 = 94.4%
of the decoded payloads re-encoding byte-exactly. What the 700 non-byte-exact
decodes are, measured: 419 legacy `GetAccountDataSize` payloads carry two extra
bytes the legacy program itself ignores (upstream's own comment says so), and
three Token-2022 extension dispatches carry their sub-instruction bytes, which
this table reports as trailing instead of inventing a field for them. The
trailing count is part of the result, not a failure hidden by it.

**What the number means now.** The acquisition gap this measurement existed to
expose is **empty for this sample**: every watched payload now sits on a program
that has an interface sememe can decode against, so `acquisitionQueue` carries
no entry. "Refused" (171) is source lag in interfaces that exist — PumpSwap's
undeclared discriminator form and pump.fun's unexplained event tail are the bulk
of it, both already reported to the first parties. The denominator never moved:
same sample, same product entry points, one new decode path per gap.

Empty is a property of these four blocks, not of the ecosystem. The coverage
illusion the card names is **measured, not removed**: one window, one RPC, no
outside user. A different window can put a program back in the queue, and the
queue is derived from the rows, so that would show up as a row first.

**The union path is a coverage lever, not a decode nicety.** Adopting the
first-party published copy `pump-fun/pump-public-docs` `idl/pump_amm.json` moved
PumpSwap from 82.0% to 96.4% (487/505 decoded) in one step: its on-chain IDL is
stale, and the published copy covers 9 of the 10 discriminators seen in the
window. The tenth (`e445a52e51cb9a1d`, 226 payloads) is declared by neither
copy.

**An adopted copy may now stand alone (2026-11-03).** The second half of the
acquisition gap was **Jupiter Liquidity** (`jupeiUmn…`, 7 payloads): no IDL at
either on-chain surface — measured at capture time, re-measured against live
mainnet at slot 464744781 (both `null`), so the only verified interface is a
published copy. Adopting the first-party
[`jup-ag/jupiter-lend`](https://github.com/jup-ag/jupiter-lend)
`target/idl/liquidity.json` at commit `0ab370a0` (26 instructions,
`sha256:8ed1e22661ab…`) into the committed fixture store closed it — **7/7
payloads decoded byte-exact through `decodeUnionPayload`**, and Jupiter
Liquidity left the acquisition queue.

Adopting it alone was not enough, because of a defect in the reader:
`decodeUnionPayload` required a *primary* source, and a store with no on-chain
receipt for the program has none — so the union path refused with
`unionDecode needs a primary source` and reported "no interface" about a store
that held exactly one, while plain `decodePayload` on the same bytes answered
7/7. Two entry points, two answers, and the coverage measurement used the wrong
one. **The rule now: an adopted copy may stand alone when there is no on-chain
pull to displace — it may still never displace one** (the on-chain receipt stays
primary whenever it exists, pinned by the existing M4 test). The verdict carries
`view.adoptedOnly: true` plus `idl.source` / `idl.slot: null`, so a consumer can
see that no chain slot answered. Refusals still refuse: a payload no stored
source explains is refused **by name**, with the adopted-only provenance
visible rather than laundered into a decode.

Covered by `test/jupiter-liquidity-acquisition.test.mjs` (5 tests: the
capture-time verdict still says `acquirable: false`; the store still holds no
on-chain receipt; all 7 byte-exact with `adoptedOnly: true`; **delete the
adopted receipt and the gap comes back by name** — the number moved because an
interface was added, not a counter; the committed report and queue reflect the
closure) plus the adopted-only union tests in `test/union.test.mjs`.

**The last gap closed by derivation: Raydium AMM v4 (2026-11-03).** The final
9 payloads sat on a program that publishes no interface at all — no IDL account
either pullable address, measured at capture time and re-measured live. Unlike
Jupiter Liquidity there was no first-party copy to adopt: its wire is not an
Anchor 8-byte discriminator but a hand-written `pack()`/`unpack()` pair over a
**sparse u8 tag set** (19 declared variants, 12 reachable on the wire, 7 refused
by upstream with `unimplemented!()`). So the interface was derived from the
program's own source, exactly as the token tables were derived from their
crates: `vendor/raydium-amm@91739d8d` (Apache-2.0, license + sha256 pin on both
files), `src/raydium-interface.mjs` for the rules, `interface/raydium-<program>.json`
as the reviewable artifact, `src/raydium.mjs` for the two-check load and decode.

The derivation reads upstream's own text rather than transcribing it: the wire
tag is the literal integer the `pack()` arm pushes, cross-checked against the
`unpack()` arm that binds that same integer; the args are the arm's byte-write
sequence, cross-checked against the reads by count and width; a trailing
optional group carries upstream's own `rest.len() >= N` threshold (**there is no
option byte**, so a C-style read would misparse every real payload); a branch
carries upstream's own discriminator values from the `AmmParams` enum. Because
the seven refused variants have no `pack()` arm to read a number from, their
tags come from their declaration position — which is checked against all twelve
reachable variants first, so an upstream reorder fails the derivation instead
of handing a refused tag a wrong name.

Measured on the same sample, same entry points: **9/9 payloads decode and
re-encode byte-exact** (`SwapBaseIn` ×2, `SwapBaseInV2` ×7), `no-interface`
**9 → 0**, and `acquisitionQueue` is empty. The decoder ships as `sememe/raydium`
with `sememe decode-raydium` / `sememe raydium-provenance`, and `sememe decode`
on this program now points at it instead of telling the user to pull a receipt
that can never exist.

Falsification (`test/raydium-interface.test.mjs`, 12 tests, mutations in temp
copies): a tampered artifact, a tampered `instruction.rs`, a tampered `state.rs`
and a missing `vendor/` all refuse the load; removing the load-time equality
check turns all four into silent passes (measured: 9 of 12 tests go red).
Refusals are pinned by reason — unknown tag, each refused variant, truncated
u64/pubkey/fees, unmatched discriminator, wildcard rejection — and the optional
group round-trips in both directions with half a group refused as
`partial-optional` rather than guessed.

**Limits.** One four-block window (~20 seconds of mainnet), one RPC. The
acquisability check ran at capture time and reflects that moment. The token
tables are derived from upstream's interface crates at one pin each; a tagged
upstream release that changes a pack() arm refuses the load loudly instead of
decoding stale. Token-2022 extension sub-instructions (the 15 extension
dispatch tags) are named at the top level only; their sub-instruction bytes
report as trailing. The spl-token-metadata fallback interface (8-byte
discriminators, own crate) is vendored and derived like the others — see below.
Traffic outside the watched list (181 further programs, 4,842 instructions) is
counted in the report but excluded from the denominator, because their bytes are
not stored. A coverage number over one window is a window, not the ecosystem —
this one can only be compared with another measurement of the same kind. The
Raydium table is derived at one pin of one repository; a tagged upstream change
to a `pack()` arm refuses the load loudly rather than decoding stale. Reproduce:
`npm test` (the report is pinned twice — as a deep-equal against
what the tool computes, and as explicit assertions), or
`node tools/traffic-coverage-report.mjs`.

## Short wire forms: 171 of 172 refusals were chain-accepted (2026-11-03)

The 172-payload refusal column above is 172 separate facts about an
*interface*, not about the chain. This section asked which side was right, one
shape at a time.

**The method.** `tools/short-form-wire-forms.mjs` groups the refused payloads by
`(program, discriminator, wire length)` and, for each group, pulls a FINALIZED
mainnet transaction witness with `maxSupportedTransactionVersion: 1`, resolves
versioned account keys through their address lookup tables, reads the
instruction data as base58 (that is how `encoding:"json"` carries it — the
first version of this tool read it as base64 and compared nonsense), and
requires three independent things before it will say the chain executed the
payload: the transaction's `err` is `null`, the witness bytes are byte-IDENTICAL
to the fixture payload, and the program's own `Program log: Instruction: ...`
line matches the name the decode will report. A control group of already-decoded
shapes runs alongside, so a witness fetch that silently failed would show up as
a wrong answer rather than as evidence. Report:
[`research/short-form-wire-forms-2026-11-03.json`](research/short-form-wire-forms-2026-11-03.json).

**The result.** The five refused shapes are:

| program | discriminator | wire bytes | payloads | instruction | field the wire does not carry |
| --- | --- | --- | --- | --- | --- |
| Pump.fun bonding curve | `e1f7501ed5b38488` | 24 | 152 | `buy_exact_quote_in_v3` | `partial_fill` |
| PumpSwap | `c62e1552b4d9e870` | 24 | 17 | `buy_exact_quote_in` | `track_volume` |
| Pump.fun bonding curve | `07051dc4f5176550` | 24 | 1 | `buy_v3` | `partial_fill` |
| PumpSwap | `66063d1201daebea` | 24 | 1 | `buy` | `track_volume` |
| Token-2022 | `d2e11ea258b84d8d` | 131 | 1 | not named | — |

**171 of 172 payloads were executed by the chain** with bytes identical to the
fixture. **0 were genuine chain-rejected refusals.** The stored interfaces
over-describe the wire: they declare one `OptionBool` more than the deployed
program reads, and a payload that ends where that field would start is refused
as truncated. The published first-party IDL knows all four discriminators; it is
the trailing option tag it expects that the 24-byte form does not carry. The
fifth shape (Token-2022, tag 210) is not a short form and stays refused.

**Why this is not simply "decode whatever ends on a field boundary."**
Byte-exact re-encoding — the evidence that makes trailing bytes trustworthy —
does NOT carry over. A payload truncated by a capture bug also ends on a field
boundary and also re-encodes byte-exactly to the shortened bytes. Offline, on
bytes alone, "the program accepts a shorter form" and "this payload was cut
short" are indistinguishable. So `src/codec.mjs` keeps the default strict, and
the opt-in comes in two flavours:

| `--absent` | behaviour | risk |
| --- | --- | --- |
| `error` (default) | refuse, as before | none — and the 171 stay unnamed |
| `report` | decode any payload ending on a field boundary, name the absent fields | names truncated payloads too |
| `verified` | decode only shapes with a chain witness | evidence can go stale |

`verified` is the product form of the measurement: the witnesses travel with
the decoder as `src/short-forms.mjs`, keyed on program + discriminator + exact
length, and a decode whose absent set differs from the measured one is REFUSED
rather than decoded and labelled unverified — stale evidence is not spent on a
shape nobody measured. A 16-byte truncation of the 24-byte form, which ends on a
field boundary and re-encodes exactly, is accepted under `report` and refused
under `verified`; that asymmetry is the whole point, and it is a test
(`test/short-form-decoding.test.mjs`).

**Coverage, same sample, same entry points, one opt-in** (after the token-metadata
fallback landed, which closed the last strict refusal — see below):

| outcome | strict | `--absent verified` |
| --- | --- | --- |
| decoded | 12,401 | 12,572 (+171) |
| refused | 171 | **0** |
| no-interface | 0 | 0 |
| coverage | 98.6% | **100%** |
| byte-exact | 11,708 | 11,879 (+171, every short form re-encodes exactly) |

The denominator did not move; the strict measurement is unchanged and still
committed, because a gain that only exists when you relax the decoder is a
finding to measure, not a number to replace. Reproduce:
`node tools/traffic-coverage-report.mjs --absent=verified`
([`research/short-form-coverage-2026-11-03.json`](research/short-form-coverage-2026-11-03.json)).

**What is still open.** The strict-verified gap is closed for this sample: after the
token-metadata fallback below landed, the last strict refusal decodes, so
`--absent=verified` reports 0 refusals on this window. The acquisition queue is empty
*for this sample* (the Raydium closure above removed the last entry, and a different
window can put a program back); and the short-form table covers one four-block window —
a longer window may well find a short form nobody has witnessed, which must refuse
under `verified` until a witness exists.

## The last refusal was the program's own fallback: Token-2022 token-metadata (2026-11-03)

One payload in the unbiased sample refused every path sememe had: a Token-2022
instruction whose first byte is `0xd2`, 112 bytes long. It was not source lag and not
an acquisition gap — it was a decode path sememe did not have.

**What the program does.** Token-2022's processor tries the ONE-BYTE token selector
first (`decode_instruction_type(input)`); when that byte is not a token variant it
falls through to `TokenMetadataInstruction::unpack(input)` and, if that fails too, to
`TokenGroupInstruction::unpack`. The token-metadata instructions therefore carry
**EIGHT-BYTE discriminators** (`sha256("spl_token_metadata_interface:<action>")[..8]`)
and never match the token table's 1-byte tags. sememe's refusal was a true statement
about the token table and a false one about the program.

**What landed.** `vendor/spl-token-metadata-interface/7038969e` (Apache-2.0, byte-
identical to crates.io `spl-token-metadata-interface` 1.0.1 — the version Token-2022's
own `Cargo.lock` pins; the directory name is the crate's upstream git sha) plus two
modules and one artifact, honouring the same two-check contract as every other table:

- `src/token-metadata-interface.mjs` derives the table FROM the vendored source:
  the discriminator from upstream's own `#[discriminator_hash_input("...")]` string,
  the argument order from each struct's Borsh field declaration, and the wire rules
  (string = u32 LE length + bytes, enum = 1-byte variant index, option = 1 tag byte,
  `MaybeNull<Address>` = 32 transparent bytes where all-zero is `None`).
  It refuses on anything it cannot pin: an unknown field type, a variant upstream
  declares that the table does not name, a discriminator collision.
- The **discriminator rule is anchored by upstream's own literal**: `state.rs`
  hardcodes the `TokenMetadata` account discriminator `[112,132,90,90,11,88,157,87]`,
  and upstream's own test derives it from `sha256("<NAMESPACE>:token_metadata")`. The
  derivation recomputes it and throws if it differs — so the hash rule cannot drift
  silently while the five instruction discriminators ride along with it.
- `src/token-metadata.mjs` loads it with the two-check contract (fresh derivation must
  byte-equal the committed artifact) and decodes; `src/token.mjs` reaches it exactly
  where upstream does — the 1-byte selector is consulted FIRST, and only a payload
  whose first byte is not a token variant gets there. Legacy SPL Token has no such
  branch and still refuses.
- `interface/token-metadata.json` + `tools/token-metadata-interface.mjs [--check]`.

**Strictness, verified rather than assumed.** Upstream's `unpack` calls
`try_from_slice`, which REFUSES a payload with unexplained trailing bytes — and it does
so in the upstream crate itself: a trailing byte is a `BorshIoError`. sememe mirrors
that (trailing bytes are a refusal, not a reported count), so the decoder never claims
the chain accepts bytes the chain rejects.

**The falsifier is the program, not a second reading of the source.**
`tools/token-metadata-oracle.mjs` builds a Rust program
(`tools/token-metadata-oracle/`) against the exact pinned crates —
`spl-token-metadata-interface 1.0.1`, `spl-discriminator 0.5.2`, `solana-nullable 1.3.0`,
`borsh 1.8.1` — and asks them: it packs every variant, unpacks the observed mainnet
payloads, and reports which inputs it refuses
([`research/token-metadata-oracle-2026-11-03.json`](research/token-metadata-oracle-2026-11-03.json)).
`test/token-metadata.test.mjs` then compares sememe's table against that output:
all five discriminators (produced by upstream's own `SplDiscriminate` derive macro),
all ten re-encodes, and all nine refusal reasons agree.

**Measured, same sample, same product entry points:** Token-2022 goes from 1,597/1,598
(the one refusal was this payload) to **1,598/1,598**; strict coverage 12,400 →
**12,401 decoded** / 172 → **171 refused**; `--absent=verified` 12,571 →
**12,572 / 0 refusals = 100%**. The denominator never moved.

**Tests: 10 new** (`test/token-metadata.test.mjs`, 306 → 316). The mutation ladder:
tampered artifact → load refused; tampered vendored `instruction.rs` → load refused;
deleted `vendor/spl-token-metadata-interface` → load refused; a hand-mutated
`RemoveKey` field order (bool moved behind the string) is caught by the artifact check
AND by the oracle comparison. Refusals stay named: unknown 8-byte discriminator,
truncated discriminator, forged Borsh string length, trailing byte, invalid bool byte,
undeclared `Field` tag.

**Known limits, kept explicit.** This is the instruction path only — the `TokenMetadata`
account (the TLV account those instructions mutate) is a different structure and is not
decoded. The `TokenGroup` fallback (`spl-token-group-interface`) is the third branch in
that same processor and is still not vendored, so a group instruction would refuse by
name; it has no payload in this window, so this is a stated boundary rather than a
measured gap.

## The interface's other half: the account list, checked against the wire (2026-11-03)

Everything before this section verifies BYTES. An instruction is bytes AND an
account list, and the account list is where a real first-party program diverged
from its own interface: jup-ag's `order_engine` declared 11 accounts for `fill`
while every observed fill carried 12 or 13 — and the extra account SIGNS every
fill (reported as [jup-ag/rfq-webhook-toolkit#96](https://github.com/jup-ag/rfq-webhook-toolkit/issues/96)).
A consumer that builds its signer/authority reasoning from the interface alone is
blind to an account that signs.

So the interface sememe stores now answers that question too, offline, from the
same receipt-verified store:

- `src/account-list.mjs` — `checkAccountList(instruction, observedAccounts)`:
  compares an instruction's declared account list with the list one transaction
  passed. Verdicts: `missing-declared-accounts`, `declared-signer-not-signing`,
  `fixed-address-mismatch`, `undeclared-signing-account`, and the informational
  `remaining-accounts` (extras that do NOT sign — Anchor's legitimate
  `remaining_accounts`).
- `src/conformance.mjs` — `checkTransaction(tx, store)`: every instruction of an
  RPC `json`-shaped transaction (top level and CPI) checked against the stored
  interface. The signer flags are derived from `message.header`'s counts —
  `accountKeys` in that encoding carries addresses only — and a shape this file
  cannot read is REFUSED (`ConformanceRefusal`), never reported as conforming.
- `sememe conform <tx.json> --store <dir>`: the CLI entry; exit 1 on any
  disagreement.
- `tools/account-list-conformance.mjs`: the live measurement (program's own
  signature page → `getTransaction` → every instruction checked).

Four rules came out of the measurement, each from a case the first version got
wrong, each pinned by a test that fails without its rule (19/20 on the stripped
tree, 21/21 with it):

1. **The optional flag has two spellings.** OpenBook v2's legacy IDL marks
   `openOrdersAdmin` `isOptional: true, isSigner: true`; live traffic passes it
   unsigned in 40/40 of one sample because the admin is not needed. Reading only
   `optional` (the new spec) turned the account being ABSENT into 40 violations.
2. **A declared signer that does not sign is a violation at depth 0 only.**
   Whirlpool `swap_v2` invoked via CPI by the Titan router: the inner
   instruction's `token_authority` is signed for inside the CPI stack
   (`invoke_signed` PDA seeds), which never appears in the top-level
   `numRequiredSignatures`. At depth > 0 the signer flag is not observable from
   the header, so such a position is a named note (`cpi-signer-not-observable`),
   not a violation. At depth 0 the header IS the authority and the check stands.
3. **Anchor's absent-optional placeholder is the program's own id.** Comparing
   that position's signer flag manufactures a violation out of the convention.
4. **A declared-OPTIONAL signer arriving unsigned is absent, not violating**
   (the same account being absent, reached through a different shape).

**The measurement** ([research/account-list-conformance-2026-11-03.json](research/account-list-conformance-2026-11-03.json),
2026-11-03T21:26Z, 170 RPC calls, 0 failures, 236 instructions from 137
transactions of 6 programs, every row committed so the summaries re-derive from
them):

| program | instructions | verdicts |
|---|---|---|
| Whirlpool | 57 | 40 conforms, 17 remaining-accounts, 0 violations |
| Jupiter v6 | 22 | 13 unknown-instruction, 2 conforms, 7 undeclared-signing-account |
| OpenBook v2 | 43 | 36 conforms, 7 remaining-accounts, 0 violations |
| PumpSwap | 56 | 25 remaining-accounts, 31 unknown-instruction |
| pump.fun | 18 | 7 remaining-accounts, 10 unknown-instruction, 1 conforms |
| jup-ag order\_engine | 40 | **40 undeclared-signing-account** |

The contrast is the finding. Jupiter's signing extras sit inside routes of 14–43
extra accounts and belong to 6 distinct caller wallets per 7 fills — the router
passing the user's authority through, a legitimate `remaining_accounts` shape
that happens to sign. order\_engine's signing extra is ONE CONSTANT address
(`pAEmG7…`) in 40/40 fills, always at the LAST position, signing every fill and
paying the fee in 31/141 of the November-1 sample: a hidden authority the
published interface does not name. Same verdict kind, opposite meanings — which
is why the report commits the rows, not just the counts.

The `unknown-instruction` rows (54 total) are honest, not noise: pump.fun and
PumpSwap's IDLs store all their discriminators (88/88 and 65/65 agree with
Anchor's derivation), but the sampled fills carry NEWER instruction revisions
than the stored pull (the `*_v2`/`*_v3` families measured in the short-form
section above). A stale pull shows up here as unknown-instruction instead of a
wrong decode — that is the check doing its job.

**Known limits:** the signer observation is the transaction-level view — a CPI
can sign for its PDAs and the header cannot see it (rule 2 handles the
consequence, not the visibility); a program that legitimately accepts several
account-list shapes produces one verdict per transaction, and only repeated
agreement/disagreement across a sample means anything; writability disagreements
are reported per position but never decide a verdict (the runtime enforces from
the transaction, not the IDL); a failed transaction can have been rejected FOR
one of these reasons, and `executed` is carried so a reader can tell.

## The largest publish-nothing gap decodes in its own dialect: shank (2026-11-04)

The acquisition-gap classification left one program standing at the top of the
list: `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95` (Lighthouse, 42 payloads in
the 156-fixture foreign sweep) publishes **no IDL account at either address**.
`sememe pull` can never fetch it — so the biggest single remaining gap was not
an acquisition question but a dialect question: its interface exists as a
file in the upstream repository (`Jac0xb/lighthouse`, MIT), generated by
[shank](https://github.com/metaplex-foundation/shank), and it is NOT an Anchor
IDL.

**What was actually different, measured rather than assumed.** Shank IDLs
change two things sememe had hard-coded:

1. **Dispatch is a 1-byte variant selector, not an 8-byte sighash.** Each
   instruction carries `discriminant: { type: "u8", value: N }` — Lighthouse's
   18 instructions are discriminants 0..17 (`MemoryWrite=0` …
   `AssertBubblegumTreeConfigAccount=17`). sememe's `withDerivedDiscriminators`
   ran Anchor's `sha256("global:<name>")` over these and filled all 18 with
   sighashes that match no real wire — a table that would REFUSE every
   Lighthouse payload while looking fully populated. The rule now: a stored
   shank discriminant is copied verbatim, counted as a stored value (not an
   Anchor derivation), and never checked against the sighash rule; the two
   schemes are independent.
2. **The lighthouse family encodes lengths as LEB128, not Borsh's u32.**
   `CompactU64`, `CompactBytes` and the six `*Assertions` vector types are
   referenced by the IDL but never defined in it — their wire form is pinned
   upstream in `lighthouse_common::CompactU64`/`LEB128Vec` and mirrored by the
   program's own generated JS client (`clients/js/src/hooked.ts`). sememe now
   hooks exactly those names, **only** inside a shank-dialect IDL, and only
   when the IDL does not define the name itself: an Anchor IDL that mentions
   `CompactU64` still refuses it (`unknown defined type`), and a name the IDL
   defines wins over the hook. Nothing is inferred from a value's shape.

**What landed.** `src/shank.mjs` (dialect detection, discriminant extraction,
the LEB128 hook table) wired into `src/codec.mjs` and
`src/discriminators.mjs`; the first-party IDL adopted into the store through
`sememe adopt` (`test/fixtures/shank-lighthouse-2026-11-04/lighthouse.json`,
receipt fingerprint `sha256:461e28fd…`, origin
`Jac0xb-lighthouse-4c579479c986`), so the decode goes through the product's
own store path like every other program.

**Measured, same sweep, same instrument**
([`research/step-ingestooor-full-sweep-shank-2026-11-04.json`](research/step-ingestooor-full-sweep-shank-2026-11-04.json),
2026-11-04T15:44Z, 156 fixtures, 806 payloads, 0 network attempts): decoded
661 → **703**, acquisition gap 129 → **87**, byte-exact 654 → **696**, rate
**100%**, disagreements **0**, decode errors unchanged at 16. Exactly one
program row moved — Lighthouse 0 → **42/42 decoded**, both of its observed
instructions (`AssertAccountInfoMulti` 21, `AssertTokenAccountMulti` 21)
round-tripping byte-exactly; the refusal reasons of every other program are
byte-identical to the previous run.

**Tests: 11 new** (9 in `test/shank-discriminants.test.mjs`, 2 in
`test/shank-sweep-report.test.mjs` pinning the committed report against the
byProgram sum and the store receipt hash). The ladder, run against the
pre-fix tree `4174bb3`: **7/9 RED** — T1–T5 and T8 fail exactly because the
shank support is missing (T8's error on the old tree is the refusal this work
fixes: `unknown instruction discriminator 0605020053bb5016 (18 known, e.g.
7f92fad78d80cfee…)` — i.e. the old table holds 18 invented Anchor sighashes
and none of the real 1-byte selectors); T6 and T9 are the false-positive
guards and pass on **both** trees (Anchor 8-byte sighashes fill and decode
unchanged; an Anchor IDL mentioning a shank-named type still refuses).

**Known limits, kept explicit.** This is one program from one upstream
repository — shank is a tool family, and the dialect was pinned from
Lighthouse's own generated client, not from every shank-generated IDL that
exists; a shank IDL whose hooked type is defined in its own `types` follows the
IDL, and one with a different hooked set is unknown until pinned the same way.
The two observation dialects (json/flat fixtures) carry no message bytes, so
the ed25519 verification path still does not apply to this payload family.
Lighthouse publishes no on-chain interface: the store copy is only as honest
as its upstream source (first-party, fingerprinted, origin-labelled) — if
upstream changes the wire, sememe will refuse by name, not decode wrongly.

## The remaining 35 publish-nothing programs, classified against foreign sources (2026-11-04)

With Lighthouse decoded under shank, exactly **35 programs (87 payloads)** remained
in the `no-interface-published` set. Rather than polishing the coverage headline,
`tools/classify-publish-nothing.mjs` measured where an interface for each one
could come from, scanning the foreign repository's own committed source
(`step-finance-oss/step-ingestooor @001cf39`, MIT; committed artifact:
`research/publish-nothing-classification-2026-11-04.json`, pinned in
`test/classify-publish-nothing.test.mjs`):

| Category | Programs | Payloads | Nature |
|---|---|---|---|
| `first-party-foreign-idl` | **7** | **22** | First-party Anchor/Shank IDL in foreign repo (`crates/idl-gens/idls/`) declaring the program address |
| `dedicated-foreign-parser` | **9** | **32** | Custom hand-written Rust parser under `crates/parsers/src/` (Solend: 10, Saber: 5, Stake Pool: 4, etc.) — no published IDL exists |
| `core-runtime-program` | **3** | **5** | Core Solana runtime / sysvar programs (`Stake111...`, `Ed25519SigVerify...`, `noopb9bk...`) — no IDL by protocol design |
| `unrepresented-source-gap` | **16** | **28** | Appears in test fixture traces; neither an IDL nor a dedicated parser in the foreign repo |
| **Total** | **35** | **87** | Partition verified without remainder (pinned in `test/classify-publish-nothing.test.mjs`) |

### Seven first-party copies adopted, sweep re-measured

The 7 first-party foreign IDLs were swept into the store via
`tools/adopt-foreign-first-party.mjs` through `sememe adopt` (`test/fixtures/traffic-sample-store-2026-11-04-pulled/`,
receipts source `first-party`, origin naming repo, commit and file; artifact:
`research/adopt-foreign-first-party-2026-11-04.json`, pinned in `test/adopt-foreign-first-party.test.mjs`):
Lulo (`FL3X2p...`), NX Lending (`NXFiKi...`), Solayer Restake (`sSo1iU...`),
Solayer AVS (`endoLN...`), Reward Options (`RopsJ7...`), Titan (`T1TANp...`),
Step Staking (`Stk5NC...`).

Re-measurement of the full 156-fixture foreign set with identical flags
(`--absent error`, `research/step-ingestooor-full-sweep-classified-2026-11-04.json`,
pinned in `test/classified-sweep-report.test.mjs`):

- **decoded:** 703 → **724** (+21 payloads decoded)
- **gap (`noInterface`):** 87 → **65** (-22 payloads; 21 decoded, 1 refused by name)
- **byteExactFull:** 696 → **716** (+20 full byte-exact)
- **byteExactDescribed:** 7 → **8** (+1 Titan swap described exact)
- **byteExactRate:** 100% (every decoded payload re-encodes byte-for-byte)
- **decodeErrors:** 16 → **17** — the single non-decoded payload is **REFUSED BY NAME**:
  `T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT: Venue: unknown variant index 40` (an honest
  refusal on an unrepresented enum variant, not a silent mis-parse).
- **disagreements:** 0 (still completely diff-free)
- Exactly the 7 adopted programs moved in `byProgram`; the remaining 28 programs
  sum to exactly 65 payloads.

The true acquisition gap for this sweep is now **65 payloads** across 28 programs —
all of which have NO published IDL (9 dedicated custom parsers, 3 core runtime,
16 unrepresented trace programs).

### The 16 unrepresented trace programs, measured against external sources (2026-11-04)

The 16 programs (28 payloads) were labeled `unrepresented-source-gap` because they
appeared in the foreign repository ONLY inside `crates/parsers/tests/**` transaction
traces (local premise check: 16/16 verified trace-only via `git grep HEAD`). Rather
than assuming they have no interface anywhere, `tools/measure-unrepresented-external.mjs`
scanned GitHub's code index for the literal program address, with a positive control
(`bitquery/solana-idl-lib solfi/solfi.json` declares `SoLFiHG9Tfgt...` -> 1 index match,
file readable and declares program -> control resolved; artifact:
`research/unrepresented-external-sweep-2026-11-04.json`, pinned in
`test/unrepresented-external.test.mjs`):

- **4 programs (9 payloads)** have a published external interface whose file explicitly
  **DECLARES** the program (`metadata.address` match, content-verified):
  - SolFi (`SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe`, 4 payloads): `bitquery/solana-idl-lib solfi/solfi.json`
  - ZeroFi (`ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY`, 1 payload): `bitquery/solana-idl-lib zerofi/zerofi.json`
  - HumidiFi (`9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp`, 1 payload): `bitquery/solana-idl-lib humidifi/humidifi.json`
  - Manifest Wrapper (`wMNFSTkir3HgyZTsB7uqu3i7FA73grFCptPXgrZjksL`, 3 payloads): `Bonasa-Tech/manifest client/idl/wrapper.json`
- **12 programs (19 payloads)** have external references (code or docs) but no published IDL file.
- **0 unknown** (positive control resolved, no partial-sweep claims).

### External adoption preview (falsification against fixture bytes)

Does a declared external interface actually decode the foreign repo's fixture bytes?
The claim was previewed via `tools/preview-external-adoption.mjs` on a throwaway store
copy (artifact: `research/external-adoption-preview-2026-11-04.json`, pinned in
`test/external-adoption-preview.test.mjs`):

- **decoded:** 724 → **732** (+8 payloads decoded: SolFi 4/4, Manifest Wrapper 3/3, ZeroFi 1/1)
- **gap (`noInterface`):** 65 → **56** (-9 payloads resolved)
- **decodeErrors:** 17 → **18** — HumidiFi's single payload is **REFUSED BY NAME**:
  `9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp: unknown instruction discriminator f6dc6...`
  (an honest refusal, not a silent mis-parse).
- **disagreements:** 0 (still completely diff-free).
- **byteExactRate:** 100% (all 8 decoded payloads reproduce byte-for-byte).
- **isolation:** exactly the 4 adopted programs moved in `byProgram`; 0 unadopted rows shifted.
- **license gate:** `bitquery/solana-idl-lib` has license `null` (no LICENSE file),
  `Bonasa-Tech/manifest` is `GPL-3.0`. Neither may be copied into this MIT repository or
  the published npm package. The preview therefore ran on a throwaway work-dir;
  the committed store remains untouched (`committedStoreModified: false`, 76 receipts).

## Next qualification

1. Reproduce the classification with `npm ci && npm test && node tools/measure.mjs programs-20.json another-run.json` (or set `SOLANA_RPC_URL` to another mainnet RPC). The script checks canonical Program Metadata and legacy Anchor IDL accounts in one finalized batch, separates RPC failures from missing accounts, and checks PDA derivation against independently pinned fixtures from `auroraxo/idl-drift`. It is **not** a pull/store/decode implementation. An incomplete RPC run is not zero coverage; absences at these two addresses do not mean no interface exists elsewhere.
2. **Whirlpool pull + content fingerprint has landed, the instruction decoder decodes real mainnet bytes, one own consumer reads the stored artifact for BOTH checking and producing, and the decoder is verified against an independent oracle across 1,000+ transactions** (see sections above): `solana-tx-remix` uses the pinned IDL for its single-program Whirlpool path (verifier + emitter), and `tools/tx-diff.mjs` verifies 1,119 real mainnet payloads from 1,029 transactions (sampled across 40,013 mainnet transactions in 148 finalized blocks) with 0 naming disagreements, 0 value disagreements, 0 byte mismatches, and 33 unexplained trailing-byte payloads (2.95%). Still to do, in order: migrate the remaining own decoder paths; then seek an outside user. The selected-sample threshold does not validate other program families. The `41 paths` figure above is an unverified note estimate; the computed scan in [research/decoder-sites-2026-10-27.json](research/decoder-sites-2026-10-27.json) reports **42 (file, class) decoder sites across 35 files in 5 own repositories**, of which 36 sit in `solana-tx-remix` + `sememe` — the counting unit matters and the two numbers are not interchangeable.
3. **Account decoding has landed** (see "Accounts: state, not just calls"): 39 real mainnet accounts across three programs, 39/39 re-encoded byte-exact, values checked against anchor-ts, 29/29 account discriminators matching anchor-ts's own computation. Still open: `repr(C)`/`packed` accounts, non-Anchor account framing, and the report path for account bytes the IDL does not describe (no real data has exercised it yet — 0 trailing bytes observed).
4. **Union decode has landed** (see "Working now: union decode"): `sememe adopt` puts a first-party published copy in the store, `sememe decode --union` answers from both verified sources with byte-evidence arbitration and a reported drift ledger — measured 915/996 decoded on real pump.fun traffic (the on-chain account alone decodes 669, the published copy alone 880). Still open: the same arbitration for account decoding (accounts still read a single receipt), adopting published copies for more than one program, and an honest label for a declared `origin` that no reader verifies.
5. Test a less family-clustered, independently selected sample and seek an outside user actually importing an interface before claiming this is a venture. A favorable fraction or self-run tests alone are not adoption.
