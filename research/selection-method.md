# Selection method for the 20-program on-chain IDL coverage test

Preregistered 2026-10-27, **before any RPC measurement** (this directory's files were written with zero
program-metadata/IDL RPC calls made; only documentation and first-party repository reads). Machine-readable
manifest: [`programs-20.json`](./programs-20.json).

## Question

For a preregistered set of 20 real Solana programs, can a usable instruction schema be pulled **from chain**
(public Solana RPC only)? This is sememe's coverage qualification: README says on-chain acquisition for fewer
than half of the programs actually touched would collapse the venture into an import-and-lock tool.

## Universe

- DefiLlama-derived local snapshot `~/github_repos/solana-radar/radar.sqlite`
  (`protocol` table, snapshot file mtime 2026-10-27T07:52:49+01:00, protocols whose `chains` include `Solana`,
  built from `https://api.llama.fi/protocols`), used **only** to order candidates by TVL.
- Caveat: the snapshot's `tvl` column is protocol-global, not Solana-only.

## Rule (deterministic, applied before measurement)

1. **Stratum A – mandated families (7 program ids).** The README/Workboard names Whirlpool, Kamino, OpenBook,
   Marinade, Jupiter route targets, Raydium, Pump.fun. One flagship program per family, each program id taken
   from that family's first-party repository/docs (`declare_id!` in the program source, or the program's own
   published IDL/docs table). Mainnet variant chosen over `devnet`/`staging` cfg branches.
2. **Stratum A-expansion (4).** Additional *distinct mainnet* programs published by those same first-party
   families: Jupiter Lend lending + liquidity, Raydium CLMM, Raydium CP-Swap, PumpSwap. (5 slots counted with
   stratum A primaries: 7 + 5 = 12.)
3. **Stratum B – TVL-ranked fill (2).** Walk the snapshot in TVL-desc order, skipping protocols already
   represented by stratum A, and take the first two protocols for which a first-party repository publishes the
   mainnet program id: `drift-staked-sol` (~285M, Drift v2) then `meteora-dlmm` (~166M, Meteora DLMM).
4. **Stratum B-expansion (4).** Additional distinct mainnet programs published by stratum-B family Meteora:
   DAMM v1, DAMM v2, dynamic bonding curve, dynamic vault.
5. **Controls (2).** SPL Token (classic) and SPL Token-2022, first-party `solana-program` repos. Explicitly
   labeled **negative-control sentinels**: native non-Anchor programs whose layouts come from the SPL
   interface, not from an on-chain Anchor IDL account. They keep the measurement from being Anchor-shaped by
   construction and are reported separately as well as inside the denominator.

Total: 12 + 2 + 4 + 2 = **20** (18 non-control + 2 controls).

## Why this is not cherry-picked

- Stratum A is fixed by the README before the set existed (the card named those families).
- Strata B follow one mechanical rule: snapshot TVL rank, skip represented families, first-party program id
  required.
- No candidate was skipped or kept based on whether it has an on-chain IDL — nothing about IDL availability was
  measured before this file was written.

## Honest limitations

- **Selection-conditioning bias:** requiring a *first-party published program id* favors protocols with public
  code/IDLs, which plausibly correlates with having on-chain IDLs. Coverage here is an **upper bound** for the
  broader protocol universe.
- **Untested tail:** after `meteora-dlmm` (rank ~20 by TVL in the eligible categories) the walk stopped at the
  20-program cap; protocols ranked below that (marginfi, save/loopscale, templar, gmx, phoenix-perp,
  bisonfi, serum, …) were **not evaluated**, not skipped-for-cause.
- **Candidates walked past and not resolved (recorded, not silently dropped):** `lido` (no live Solana
  first-party program located), `maple`, `sanctum-validator-lsts`, `binance-staked-sol`, `jito-liquid-staking`,
  `pancakeswap-amm-v3`, `jupiter-perpetual-exchange` (no first-party repo found for the perps program),
  `jupiter-staked-sol`, `marinade-native`, `forward-industries-sol`, `dfdv-staked-sol`, `sanctum-infinity`,
  `phantom-sol` (custodial/wrapper entries with no distinct published program), each either "no first-party
  program id published" or "not a distinct on-chain program" as far as bounded search showed.
- **Line drift:** evidence URLs pin `main`/`master` branch + line; upstream edits move lines, so quotes are
  included in the JSON for re-verification.
- **Corroboration depth:** Jupiter v6 and Meteora DLMM program ids are cited from the owning org's
  repo/docs (not a third-party list); index 14's address comes from the org's own published IDL file, not from
  `declare_id!`.
- **Drift gating uncertainty:** see `programs-20.json` index 13 — cfg gating of the two identical
  `declare_id!` lines was not verified line-by-line.

## What the measurement harness must record per program

Denominator is fixed at 20 (and 18 excluding controls). Per program, record: channel(s) tried (canonical
Program Metadata `idl` PDA under `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, legacy Anchor `anchor:idl`
address = `create_with_seed(find_program_address([], program_id), "anchor:idl", program_id)`), RPC endpoint,
slot, raw response hash, classification (pulled-usable / present-but-unusable / account-absent /
rpc-error / timeout), and the exact definition of "usable". PDA absence is **not** proof of absence — check the
other channel and at least one non-RPC source before claiming a program has no on-chain IDL anywhere.
