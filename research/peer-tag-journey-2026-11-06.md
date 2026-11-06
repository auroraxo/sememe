# pinned-tag peer journey — sememe v0.4.6 (2026-11-06)

Measured against the PUBLISHED installs, not against a working tree.
Host: own machine (openclaw029), own GitHub account, no npm account needed.

## Defect (before the fix) — published v0.4.5, peer absent

    npm install --omit=peer github:auroraxo/sememe#v0.4.5
    node --input-type=module -e "await import('sememe/pull')"

    {"imported":false,"code":"ERR_MODULE_NOT_FOUND","name":"Error",
     "message":"Cannot find package '@solana/web3.js' imported from
                /tmp/sememe-peer-tag-probe/node_modules/sememe/src/pull.mjs"}

    sememe/gap -> same, from .../src/acquire.mjs

The CLI on that SAME install refused correctly (it wraps the failure itself):
    {"error":"pull needs @solana/web3.js: install it next to sememe
      (npm i @solana/web3.js@1.98.4) — Cannot find package …"}
The gap was library-only — exactly what the README's library sentence promised.

## Fix (published v0.4.6, peer absent)

    npm install --omit=peer github:auroraxo/sememe#v0.4.6   -> version 0.4.6
    import('sememe/pull') -> {"imported":false,"code":"peer_dependency_missing",
      "name":"PeerDependencyMissingError","message":"the acquisition path needs
      @solana/web3.js: install it next to sememe (npm i @solana/web3.js@1.98.4)"}
    import('sememe/gap')  -> identical

    CLI pull -> {"error":"the acquisition path needs @solana/web3.js: install it
      next to sememe (npm i @solana/web3.js@1.98.4)"}   exit 1
    CLI gap  -> identical
    decode-native 1111… <payload> -> still works WITHOUT the peer
      ({"program":"11111111111111111111111111111111","kind":"native-instruction",
        "name":"Assign","selector":1})   # the decoder-only path stays peer-free

## Ladder (test/peer-tag-journey.test.mjs)

| test | v0.4.5 pin (pre-fix) | v0.4.6 pin (post-fix) |
|------|----------------------|-----------------------|
| P1 sememe/pull refuses in sememe's voice | RED | GREEN |
| P2 sememe/gap refuses in sememe's voice  | RED | GREEN |
| P3 CLI names the instruction exactly once | GREEN | GREEN |
| G1 GUARD: the current tree's tarball refuses the same way | GREEN | GREEN |

P1/P2 are the only tests expected to flip; P3 and G1 are the guards.
Mutation: removing `src/peer.mjs` turns G1 RED (measured, restored byte-identical
via sha256 comparison) — the guard is not vacuous.

## Limits

- Own host, own account; the journey runs the shipped bytes but is still one
  machine, not a stranger on another host.
- The peer refusal is the acquisition path only; the decode core stays at zero
  packages (pinned by test/deps.test.mjs).
- v0.4.5 keeps its defect (tags are immutable); its release page carries the
  SUPERSEDED banner.
- Adoption gate unchanged: not-distributed-not-consumed (0 non-owner signals).
