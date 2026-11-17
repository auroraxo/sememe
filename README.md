# sememe

A local meaning layer for Solana bytes. `sememe pull <program>` fetches and verifies a program interface; every process on the machine can then decode instructions, accounts, and events offline.

**Status: v0.4.35 — published on the npm registry AND as a git tag. Pull/store plus an offline decoder for instructions, Anchor event self-CPIs and account state, verified against real mainnet programs; union decode across a program's on-chain IDL and its adopted first-party published copy (`sememe adopt` + `sememe decode --union`); the fingerprint lockfile ships (`sememe lock` + `sememe verify`); the decode path installs zero runtime dependencies. The ecosystem-wide measured coverage is 88.8% (18,967/21,350 payloads across 6 finalized blocks, 2026-11-13; 96.4% on the curated watchlist, 63.8% outside it; byte-exact re-encode on 93.1% of decoded). The honest limits ride with every number: zero external users so far — publish is not consumption — one machine, no audit.**

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
npm install github:auroraxo/sememe#v0.4.35   # tagged release; no npm account needed
```

```js
import { decodePayload } from 'sememe';

const result = await decodePayload('./store', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', payload);
// result.name, result.args, result.roundTripByteExact, result.idl.fingerprint
```

The decode path installs **zero runtime dependencies**: `sememe` itself has none on its entry, and every file it reaches imports only `node:` builtins. Beyond the entry, the package exports `sememe/native` (System + ComputeBudget, derived at import from the pinned upstream sources), `sememe/token` (SPL Token + Token-2022, derived the same way from the pinned interface crates), `sememe/raydium` (Raydium AMM v4, derived from its pinned program source), `sememe/ata` (SPL Associated Token Account, derived from its pinned interface + processor), `sememe/lighthouse` (the Lighthouse first-party IDL copy, hash-checked against its pinned upstream commit at import), `sememe/store` (read/verify receipts), `sememe/pull` (acquisition), `sememe/mailbox` (read rows from a local reeflog mailbox, honouring both of reeflog's retraction signals) and the low-level surfaces a consumer may need directly: `sememe/codec`, `sememe/canonical`, `sememe/discriminators`. Two audit surfaces let a consumer falsify the table it was handed instead of trusting it: `sememe/native-corpus` (the real mainnet System/ComputeBudget harvests the decoder was qualified against, re-hashed on every read) and `sememe/native-audit` (re-derive the native tables from the pinned vendored Rust and byte-compare the shipped artifacts — the same audit the suite runs).

The pull is the one path that needs a package too, because deriving the Program Metadata PDA needs ed25519: install `@solana/web3.js` next to sememe before it. `@solana/web3.js` is declared as an *optional peer* precisely so a decoder-only consumer is never asked to install it. The CLI refuses `sememe pull` and `sememe gap` without it, with that instruction, and still runs every other subcommand. (Measured 2026-11-05: `sememe gap` probes the same on-chain IDL addresses as `sememe pull`, so it needs the peer too — the sentence here used to name only `sememe pull`; `tools/measure-release-surface.mjs` now derives the peer-needing commands from the import graph and fails this README if the claim drifts again.)

The **library** refuses the same way: importing `sememe/pull` or `sememe/gap` without the peer throws `PeerDependencyMissingError` (code `peer_dependency_missing`) whose message is that exact instruction — not Node's raw `ERR_MODULE_NOT_FOUND` stack trace. (Measured 2026-11-06 from a bare tarball install with the peer absent: both subpaths used to surface `Cannot find package '@solana/web3.js' imported from …` with no install command, while the CLI, which wrapped the same failure, was the only surface that named the fix; `test/acquisition-peer-surface.test.mjs` pins it on the working tree and `test/peer-tag-journey.test.mjs` pins it on the PINNED install — the fix reached main on 2026-11-06 but the front-page pin still named v0.4.5, whose bytes still leaked the raw loader error, so this sentence described an install a stranger did not receive. v0.4.6 carries it.) The entry and every decode-only subpath still import zero packages, so this refusal never reaches a decoder-only consumer.

**From an install (not a clone), the CLI is `npx sememe …`** — npm exec resolves the package's own `bin` from `node_modules`; the bare command `sememe` is not on your `PATH` after a plain `npm install`, and `node bin/sememe.mjs` works only inside a clone of the repository (both measured 2026-11-05 from a real tarball install). The consumer journey from the install, verbatim:

```bash
npm install github:auroraxo/sememe#v0.4.35 @solana/web3.js   # acquisition needs the peer
npx sememe pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --store ./store
npx sememe decode whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc 2b04ed0b1ac91e62a40d0100000000000100000000000000af331ba8327fbb35b1c4feff00000000010001010000000601 --store ./store
```

`./store` is the local content-addressed store the error `no sememe store at ./store: run "sememe pull" first` tells you to create — the `pull` above is that creation step; the vendored programs (System, ComputeBudget, SPL Token, Token-2022, Raydium AMM v4, SPL Associated Token Account) need no store at all: `npx sememe decode-native 11111111111111111111111111111111 <payload>` answers offline from the pinned upstream tables. If you ever point the decoder at a store directory that does not exist yet, the refusal names the fix; `npx sememe` is the form of that fix that runs where you are. Measured 2026-11-05 from the packed tarball of this tree: install (zero deps) → `npx sememe pull` (live mainnet) → `npx sememe decode` (byte-exact, live-pulled object byte-identical to the fixture store object `0b886e37…660f`).

Publishing to the npm registry changed on 2026-11-12: the `sememe` name is now live on registry.npmjs.org (first shipped as 0.4.21; the measured registry install of `sememe@0.4.22` into an empty app decoded the Whirlpool fixture payload `swap_v2`, `roundTripByteExact: true`). `npm install sememe` and `npm install github:auroraxo/sememe#v0.4.35` deliver the same product files from the same code: the files allowlist already ships none of this repository's tests, fixtures or qualification harness (pinned by `test/package.test.mjs`), so the git tag remains the release artifact — `test/package.test.mjs` (the contract above), `tools/e2e-package-consumer.mjs` (a real install into an empty directory) and `test/install-surface.test.mjs` (the shipped README's install commands run verbatim from the packed tarball) keep both channels honest. That sameness is now MEASURED per published version, not assumed (`tools/measure-channel-parity.mjs`, `test/channel-parity.test.mjs`, `research/channel-parity-2026-11-16.json`): 0.4.23 through 0.4.30 measure byte parity, while the two first releases diverge and cannot be repaired — `sememe@0.4.21` shipped `src/rawle.mjs` that the tag `v0.4.21` never contained (it was published from the commit *after* the tag), and `sememe@0.4.22` carries a README one commit newer than tag `v0.4.22`; both are named, classified and pinned so the record survives the immutable versions.

The **user-zero against the published pin** — a stranger's first run against the version the channels actually serve — is now a repeatable measurement, not a hand-run script: `tools/measure-published-pin-user-zero.mjs` installs the README's pin from the npm registry into an empty app, runs the README's own decode example verbatim, retargets the committed byte-identical HADRo probe at the INSTALLED copy, and decodes both chain-accepted `updateSpreadConfig` (0x0e) witnesses through the installed `src/decode.mjs`. The expectation is not a number written down in a previous pulse: the same probe is run against this checkout first, and the installed copy must answer the identical question identically. `test/published-pin-user-zero.test.mjs` gates the committed artifact (a check that failed, a pin that drifted off the README, or a host path in the artifact all turn it red), and `tools/mutation-ladder-published-pin-user-zero.sh` proves the gate can go red: 8/8 mutations caught, control green, tree byte-identical. Measured 2026-11-16 (`research/published-pin-user-zero-2026-11-16.json`, verdict `measured`, 6/6 checks pass): registry serves 0.4.30, zero-dependency install, the README example answers `swap_v2` / `roundTripByteExact: true`, the probe answers 144/144 identically on both trees, both 0x0e witnesses decode byte-exact through the installed copy.

## Working now: the README that ships is gated, not just the README you read (2026-11-15)

The one-pin rule was enforced on **this checkout's** README by eight gates and on
nothing that leaves the machine. Publishing is manual here, so on `0.4.28` the
order went wrong: `npm publish` ran first, npm accepted a README naming **two**
install tags, and only *afterwards* did CI go red on that same commit. Measured
per published version (`tools/measure-shipped-readme-pin.mjs` →
`research/shipped-readme-pin-2026-11-16.json`, verdict
`shipped-readme-pin-defective`): 8 of 10 carry exactly one correct tag, **2 carry
two** — `0.4.23` and `0.4.28`. Both are immutable, so they are named rather than
repaired, and `v0.4.32` is the corrected successor: one pin.

`prepublishOnly` now runs `tools/gate-shipped-readme-pin.mjs`, which packs this
tree the way `npm publish` does and refuses unless the **shipped** README pins one
tag equal to the published version — and *not* on `npm pack`, so the channel-parity
tool keeps measuring the immutable two-pin tags. The gate caught its own author
during this release. `test/shipped-readme-pin.test.mjs` is 8 red / 1 green on the
pre-fix tree; `tools/mutation-ladder-shipped-readme-pin.sh` is 8/8 caught with a
green control. Full measurement in [docs/measured-history.md](docs/measured-history.md).

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

`lock` snapshots every program's newest verified receipt into one canonical-JSON document (fingerprint + source + slot + receipt name, one commit-able file); every receipt is re-checked through the store reader first, so a store the reader refuses produces NO lock, never a lock over damage. `verify` re-checks the store against the pin and refuses drift by name — `drifted` (the store now answers with a different fingerprint, both quoted), `missing` (a pinned program has no receipt), `unverified` (an object fails the re-hash), `relabelled` (a DECLARED origin changed), `unbound` (the store declares an origin this lock does not pin, so the gate cannot say whether that label changed — the lock predates origin pinning; the repair is `sememe lock`). An **extra** store program — one the lock does not pin, because the lock pins minimums, not store equality — is **reported, never a violation for being there**; but if its receipt is DAMAGED, that is a violation like any other, marked `scope: "extra"` so the repair is not mistaken for pin drift (the pin is fine; the store's receipt for an unpinned program has to be re-pulled). `--mode error` (verify's default) exits 1 on any violation, so the CI gate is `npx sememe verify` after checkout. Every refusal on this surface answers the machine channel the rest of the product answers — `{"error": …, "code": …, "fix": …}` — so a pipeline branches instead of reading prose: `lock-v1-parse`, `lock-v1-shape`, `lock-v1-fingerprint`, `lock-v1-origin`, `lock-pins-nothing`, and on gate failure `lock-mismatch`, which also carries `violations` (the programs of every kind) because a pipeline that has to parse a sentence to tell "the store drifted" from "a receipt is damaged" is not a pipeline. Refusals on this surface stay on the work channel (exit 1); a lock path that does not exist is a caller mistake and stays on the usage channel (exit 2). A store that does not exist is an ANSWER, not a refusal, and keeps its own sentence. **Measured 2026-11-17:** on the published `0.4.34` and on the pre-fix tree, 13 of 13 lock-surface refusals were unnamed and repairless, and 2 refusals minted a code the CLI then dropped — [research/lock-voice-2026-11-17.json](research/lock-voice-2026-11-17.json).

**Measured 2026-11-07 (`verify` must not call clean a store the reader refuses):** a store holding Whirlpool (locked) and Jupiter pulled *afterwards*, so Jupiter is an extra, with Jupiter's object rewritten so it no longer re-hashed to its receipt — the store reader refuses that program, and `sememe decode` on it exits 1 with "object and receipt disagree, refusing to decode". On the published `v0.4.10` install: `sememe lock` exited **1** (no lock written) while `sememe verify` exited **0** with **violations 0** — a green CI gate over a program the reader refuses. The cause was structural, not a typo: `writeLock` re-checked **every** receipt, `checkLock` re-checked only the **pinned** ones, so the shared helper was shared but only ever called on one side. Both paths now re-check the extras through the same helper, and only their FAILURES are reported. See [Working now: `verify` agrees with `lock`](https://github.com/auroraxo/sememe/blob/main/docs/measured-history.md#working-now-verify-agrees-with-lock-about-a-store-whose-extra-program-is-damaged-2026-11-07) and [research/extra-damage-2026-11-07-before.json](research/extra-damage-2026-11-07-before.json) (the published install: 3 contract violations) / [research/extra-damage-2026-11-07.json](research/extra-damage-2026-11-07.json) (this tree: 0).

What the lock does NOT do: it is not a freshness check against the chain (the pin says "this is what I answered", not "this is what the program is now"); it does not cover vendored programs (System/ComputeBudget/SPL Token/Token-2022/Raydium AMM v4/SPL Associated Token Account have no receipts, they are pinned from upstream sources instead); and it cannot stop you from re-pulling — it makes every re-pull that changes an answer visible.

## Working now: when the on-chain interface copy is complete but incomplete on the wire (`sememe adopt-hadron`, 2026-11-14)

Most interface gaps are "no interface exists at all" — the ATA, Lighthouse and Manifest cases, closed by a derived wire table or a vendored first-party copy. HADRo (`HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8`) is the other kind: the on-chain metadata IDL declares **all 38 instructions and every type**, and it is still incomplete **on the wire**. It lacks exactly two argument declarations — `sequence: u64`, last on `setCurve` and `setRiskCurve` — and the wire carries those 8 bytes after the points.

Measured on the 144 committed chain-accepted payloads of those two instructions:

| from the on-chain copy alone | |
|---|---|
| decoded | 144/144, 0 refused |
| payloads ending in unexplained bytes | 144/144 (8 bytes each) |
| **re-encoding byte-exactly** | **0/144** |
| refused under `--trailing error` | 144/144 |

So a consumer had no path to byte-exactness on real mainnet traffic, and `--trailing error` refused every one of those payloads outright.

```bash
npx sememe adopt-hadron --store ./store
npx sememe decode --union HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8 <payload> --store ./store
```

`adopt-hadron` adopts the program's **first-party published copy** (`Hadron-Fi/hadron-tx-verifier`, Apache-2.0 AND MIT) from a sha256-pinned vendored file, hash-checked **before** any write, through the product's own write path. Afterwards the union reproduces **144/144 payloads byte-exactly**, 0 unexplained bytes, 0 refusals under `--trailing error` — and *names* the disagreement with the on-chain copy instead of silently picking one (`verdict: layout_drift`, drift path `sequence`, arbitration basis `byte_evidence_full_roundtrip`).

Neither half of this was sufficient alone, and that was measured rather than argued (`research/hadron-adoption-2026-11-14.json`, four faces over the same 144 payloads):

| face | decoded | refused | byte-exact |
|---|---|---|---|
| before the header-count rule + on-chain IDL | 72 | 72 | 0 |
| before the header-count rule + first-party IDL | 72 | 72 | 0 |
| after the header-count rule + on-chain IDL | 144 | 0 | 0 |
| after the header-count rule + first-party IDL | 144 | 0 | **144** |

The second row is the falsifier for "just adopt the source IDL": the first-party copy declares `points` as a Borsh vector too, so on its own it refuses the same 72 payloads. The third row is the falsifier for "the header rule alone is the fix": it stops the refusals but drops the 8-byte tail, so nothing round-trips. Only the composition reproduces every byte.

What it does **not** do: plain `sememe decode` keeps the on-chain receipt as its default answer (measured unchanged on both sides of the adoption — the adopted receipt sorts at slot 0, so it never wins the single-source read), and the receipt's origin stays `declared`: a commit is content-addressed, not signed, and nothing here proves the bytes describe the deployed program. Chain proof stays with the decode — every payload must re-encode byte-exactly or the union refuses. See [docs/measured-history.md](https://github.com/auroraxo/sememe/blob/main/docs/measured-history.md) and [research/hadron-adoption-2026-11-14.json](research/hadron-adoption-2026-11-14.json).

## Working now: a name the decoder can say but the encoder could not reproduce (Token-2022 metadata, 2026-11-15)

`tokenNames(TOKEN_2022)` advertises 53 names for the Token-2022 program — 48 token instructions plus five token-metadata variants (`Initialize`, `UpdateField`, `RemoveKey`, `UpdateAuthority`, `Emit`) — and `encodeTokenInstruction(TOKEN_2022, …)` refused all five with `unknown-variant`, even though the decoder's own fallback branch handles exactly those payloads. A consumer could be handed the name of a payload and then be unable to re-encode it.

Measured against the unchanged prefix tree `e28c849` (= tag `v0.4.27` = npm `latest` until today): five of five metadata names refused by the encoder, 0/10 fixture and 0/4 chain-witness payloads re-encoded byte-exactly, and the refusal reason printed twice (`trailing-bytes: trailing-bytes: …`). After the fix: zero refused names, 10/10 and 4/4 byte-exact, one reason. Legacy SPL Token still refuses all five names — the fallback is Token-2022-only, exactly as the decoder's gate is. `research/token-encoder-fallback-2026-11-15.json` pins both trees (verdict `encoder-reproduces-its-own-names`), `test/token-encoder-fallback.test.mjs` carries the four defect faces (red on the prefix tree) and four guards (green on both), and `tools/mutation-ladder-token-encoder-fallback.sh` proves the gate can go red (6/6 mutations caught, control green).

Why the round trip stayed green anyway: the encoder is only reached when the decoder is not byte-exact — and on all ten sampled payloads the decoder was byte-exact. The gap was invisible to the gate that was supposed to watch it.

## Working now: a path you named is answered in the product's voice, not the kernel's (2026-11-16)

`sememe` refuses almost everything by name — a typo'd flag names the supported flag, a damaged store names the receipt. The one input class it had not closed was **the file you point at**: when the path was wrong the answer was the kernel's, verbatim (`{"error":"ENOENT: no such file or directory, open '/tmp/nope.json'"}`, exit 1) — no name to branch on, no subject saying which argument, and sharing exit 1 with a real refusal so a CI script could not tell "you pointed me at nothing" from "your store drifted".

Measured on the published `sememe@0.4.30` and reproduced against pre-fix tree `3ef9ca8`: **10 of 12** caller-named faces leaked a raw errno. Now **0 of 12**, every refusal naming a code, a subject, a reason and a repair — and the IO faces travel on the usage/IO channel (exit 2), because nothing ran, while a file that *is* there but holds wrong bytes keeps exit 1. `src/file-input.mjs` is the one classifier; the errno is input, never output. `research/file-input-voice-2026-11-16.json` pins both trees (verdict `file-input-voice-closed`, 0 control regressions), `test/file-input-voice.test.mjs` carries the twelve faces and the controls, and `tools/mutation-ladder-file-input-voice.sh` proves the gate can go red (8/8 caught, control green). See [docs/measured-history.md](https://github.com/auroraxo/sememe/blob/main/docs/measured-history.md).

## Working now: the store you point at — and the damage in it — is answered in the product's voice too (2026-11-17)

The file you name was closed in v0.4.31; **the directory you name** was not. `--store <dir>` is a path you chose (sememe keeps `receipts/` and `objects/` inside it), and when it was wrong the answer was still the kernel's (`{"error":"ENOTDIR: not a directory, scandir '/tmp/store-file/receipts'"}`, exit 1) — without saying *which* path was wrong: the store root, its `receipts/` or its `objects/` are three faults with three repairs. Measured on the published `sememe@0.4.31` and reproduced against pre-fix tree `a722b55`: **13 of 13** caller-named store faces leaked a raw errno. Now **0 of 13**, each naming a code (`store-not_a_directory`, `store-receipts-unreadable`, …), the exact path and a repair, all on the usage/IO channel (exit 2) because nothing ran. A store that does not exist is *not* a refusal: the read paths keep their `no sememe store` answer and the write paths still create it. `src/store-input.mjs` is the one classifier; `research/store-input-voice-2026-11-17.json` pins both trees (verdict `store-input-voice-closed`), `test/store-input-voice.test.mjs` carries the faces, and `tools/mutation-ladder-store-input-voice.sh` proves the gate can go red (9/9, control green). Shipped in v0.4.32; 0.4.31 still leaks it, and the tag stays immutable. What was left after that was the input sememe finds *itself*: the store path was right and the store was damaged — the reader refused it in the kernel's voice, with no code, no repair, and your home directory in the message (`{"error":"store receipt <name>.json is unreadable: EACCES: permission denied, open '/home/you/…'"}`, exit 1). Measured against pre-fix tree `9fe90e5`: **4 of 11** damage faces leaked a raw errno, **all 11** were unnamed and repairless; now **0/0/0**, each naming a code (`store-object-rehash_mismatch`, …), its subject and a repair, with no absolute path in the refusal. The channel does not move — damage stays exit 1, a wrong path stays exit 2 — and the sentences other tools quote keep their place. `src/store-damage.mjs` is the one classifier; `research/store-damage-voice-2026-11-17.json` pins both trees (verdict `store-damage-voice-closed`), `test/store-damage-voice.test.mjs` carries the faces, `tools/mutation-ladder-store-damage-voice.sh` proves the gate goes red (8/8). The claim was then asked at the channel a stranger installs — two published npm versions in two empty apps, the same probe inside each package: `sememe@0.4.32` still quotes the kernel on **4 of 11** damage faces and names none of them, `sememe@0.4.33` answers **0 leaked, 11 named, 11 repaired** (`research/store-damage-voice-published-2026-11-17.json`, verdict `store-damage-voice-held-on-the-published-channel`, gate `test/store-damage-voice-published-measurement.test.mjs`, ladder 11/11). The same day closed the last voice on that surface: **the answers themselves**. A store that does not exist, or that simply holds no receipt for the program you asked for, is a state, not a fault — but all six answer faces (`decode`/`account`/`lock`/`verify` × `no-sememe-store`/`no-stored-idl`) reached the operator as bare prose, because the CLI printed `code` only together with `fix` and an answer has none (and `lock`/`verify` minted no code at all). Measured on the published `sememe@0.4.35` and pre-fix tree `dc2317d`: **6 of 6** answers unnamed. Now **0 of 6**: each carries its code plus `answer: true` — *acquire, do not repair*, the one mark that tells a script "pull first" from "something broke" without parsing prose — and never a `fix`, never a changed sentence, never a moved channel (exit 1 stays). `src/store-answer.mjs` is the ONE mint place; [research/answer-voice-2026-11-17.json](research/answer-voice-2026-11-17.json) pins both trees (verdict `answer-voice-closed`), `test/answer-voice.test.mjs` carries the faces, `tools/mutation-ladder-answer-voice.sh` proves the gate goes red (8/8). See [docs/measured-history.md](https://github.com/auroraxo/sememe/blob/main/docs/measured-history.md).

## Where the numbers come from

Every claim above is pinned by a test and backed by a committed artifact. If you want to know **why** a number is what it is, and what was measured wrong before it was measured right:

- [docs/measured-history.md](https://github.com/auroraxo/sememe/blob/main/docs/measured-history.md) — the unabridged record: per-program verification (9+ programs, real mainnet payloads), the ecosystem coverage measurement and its corrections, acquisition-gap closings (ATA, Lighthouse, Manifest, Archer, DiabLokxis, pfeeU, pump.fun, HADRo), the dialect gate and raw-LE engine, short-form and struct-absent rules with chain witnesses, and the registry-channel measurements. Sections are named by date.
- `research/` — the JSON artifacts the README used to quote inline; the history file links them by path.
- `npm test` — 1,184 tests: the quickstart output line, the documented commands against the pinned tag, the install channels, the journey from a bare `node_modules` install, and the measurement artifacts themselves are all pinned. A hand-edited number in this README goes red.

## Free and paid

- Free, MIT: all acquisition channels, normalization, fingerprint store, checks, decode and encode APIs, CLI, daemon, lock files, and fully offline resolution. No account or quota.
- Paid later: managed team registries, curated coverage packs for programs without a public interface, and enterprise approval and audit workflows. A decode call is never sold.
