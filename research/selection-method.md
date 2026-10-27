# Selection method for the 20-program on-chain IDL coverage test

**Chronology correction (2026-10-27):** This explanatory file and the detailed `research/programs-20.json`
were written and committed *after* the full 20-program measurement. They must not be described as
preregistered. The separate root [`../programs-20.json`](../programs-20.json) froze exactly the same 20 IDs
in commit `681936b` before the batch RPC result `coverage-result.json` (result timestamp
2026-10-27T10:25:21Z). A separate exploratory RPC check on Whirlpool was made **before** that commit;
the earlier claim of “zero RPC calls” was false. This was a convenience sample, not a blinded
prospective population study. This document records how the sample was assembled *retrospectively*.

## Question

For this selected set of 20 real Solana programs, can a usable instruction schema be pulled **from chain**
(public Solana RPC only)? This is sememe's coverage qualification: README says on-chain acquisition for fewer
than half of the programs actually touched would collapse the venture into an import-and-lock tool.

## Universe

- DefiLlama-derived local snapshot `~/github_repos/solana-radar/radar.sqlite`
  (`protocol` table, snapshot file mtime 2026-10-27T07:52:49+01:00, protocols whose `chains` include `Solana`,
  built from `https://api.llama.fi/protocols`), used **only** to order candidates by TVL.
- Caveat: the snapshot's `tvl` column is protocol-global, not Solana-only.

## Selection rationale (recorded after measurement; not an independently preregistered algorithm)

1. **Stratum A – mandated families (7 program ids).** The README/Workboard names Whirlpool, Kamino, OpenBook,
   Marinade, Jupiter route targets, Raydium, Pump.fun. One flagship program per family, each program id taken
   from that family's first-party repository/docs (`declare_id!` in the program source, or the program's own
   published IDL/docs table). Mainnet variant chosen over `devnet`/`staging` cfg branches.
2. **Stratum A-expansion (5).** Additional *distinct mainnet* programs published by those same first-party
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

## Selection bias and what the result does not prove

- Stratum A family names were in the earlier README/Workboard, but the choice of *additional* programs
  was made by an investigator who had already worked with several IDL sources. The list is intentionally
  concentrated in Raydium and Meteora; 20 IDs are **not** 20 independent protocol families.
- The TVL-ranked-fill description was written after the batch run; it is not a reproducible published
  pre-measurement exclusion ledger. Global rather than Solana-only TVL is another limitation.
- An exploratory Whirlpool IDL RPC check occurred before the 20-ID commit. Do not claim this sample was
  selected blind to on-chain IDL status. The root file *does* prove the exact 20 IDs were fixed before
  the full batched measurement. No population-wide or demand inference is supported.

## Honest limitations

- **Selection-conditioning bias:** requiring a *first-party published program id* favors protocols with public
  code/IDLs, which plausibly correlates with having on-chain IDLs. The observed fraction may be higher than
  coverage in the broader universe; it is **not** a statistically justified upper bound.
- **Untested tail:** after `meteora-dlmm` (rank ~20 by TVL in the eligible categories) the walk stopped at the
  20-program cap; protocols ranked below that (marginfi, save/loopscale, templar, gmx, phoenix-perp,
  bisonfi, serum, …) were **not evaluated**, not skipped-for-cause.
- **Candidates walked past and not resolved (recorded, not silently dropped):** `lido` (no live Solana
  first-party program located), `maple`, `sanctum-validator-lsts`, `binance-staked-sol`, `jito-liquid-staking`,
  `pancakeswap-amm-v3`, `jupiter-perpetual-exchange` (no first-party repo found for the perps program),
  `jupiter-staked-sol`, `marinade-native`, `forward-industries-sol`, `dfdv-staked-sol`, `sanctum-infinity`,
  `phantom-sol` (custodial/wrapper entries with no distinct published program), each either "no first-party
  program id published" or "not a distinct on-chain program" as far as bounded search showed.
- **Line drift:** evidence URLs use `main`/`master` branches and line numbers, **not immutable commit pins**;
  upstream edits can change them. The owning source file and ID text were HTTP-checked again on 27.10.
- **Corroboration depth:** Jupiter v6 and Meteora DLMM program ids are cited from the owning org's
  repo/docs (not a third-party list); index 14's address comes from the org's own published IDL file, not from
  `declare_id!`.
- **Drift gating uncertainty:** see `programs-20.json` index 13 — cfg gating of the two identical
  `declare_id!` lines was not verified line-by-line.

## What the measurement harness must record per program

Denominator was fixed at 20 in commit `681936b` before the full batch run (18 excluding controls).
The current harness records both addresses, RPC slot, classification and decoded JSON fingerprint; it does
**not** retain raw responses or a raw response hash. Per program, record: channel(s) tried (canonical
Program Metadata `idl` PDA under `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, legacy Anchor `anchor:idl`
address = `create_with_seed(find_program_address([], program_id), "anchor:idl", program_id)`), RPC endpoint,
slot, classification (pulled-usable / present-but-unusable / both checked accounts absent / rpc-error),
and the exact definition of "usable". PDA absence at these two addresses is **not** proof that a program
has no interface anywhere; a committed first-party IDL can still be available without an on-chain copy.
