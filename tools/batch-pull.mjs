#!/usr/bin/env node
// batch-pull.mjs — close a MEASURED acquisition gap in one batched probe.
//
//   node tools/batch-pull.mjs --gap research/acquisition-gap-2026-11-04.json \
//     --store test/fixtures/traffic-sample-store-2026-11-04-pulled \
//     --out research/batch-pull-2026-11-04.json
//
// WHY THIS IS A TOOL AND NOT A LOOP OF `sememe pull`
//
// 1. One probe, one slot. The gap measurement (2026-11-04, live mainnet)
//    classified 70 programs and found 34 of them publishing an on-chain IDL
//    that sememe never pulled — 177 of the 306 no-interface payloads in the
//    foreign fixture sweep. Pulling them one CLI process each would probe
//    the chain 34 times, at 34 different slots, and re-hash the same bytes 34
//    times. This tool probes them in batched getMultipleAccounts calls
//    (25 programs = 50 keys per request; the public endpoint rejects larger
//    batches, -32602) and stores each IDL with the SAME write path the
//    single-program CLI uses (`installIdl` from src/pull.mjs). One writer,
//    one slot per batch, one fingerprint per object.
//
// 2. A failure is never an absence. The crates.io-403 lesson (signerd,
//    2026-11-03) and the gap classifier's own rule both say it: if the RPC
//    did not answer, the row is `unknown` and the run withholds its verdict
//    (exit 3). A program whose account cannot be DECODED is `undecodable`
//    with the reason — never folded into "the chain publishes nothing",
//    because the gap report already said it publishes something.
//
// 3. The gap report is the denominator. Its rows must sum to its own
//    headline (`programsFromReport` refuses a hand-edited artifact), and
//    only its `pullable` rows are candidates — the `no-interface-published`
//    rows are NOT retried here, because pulling them can never succeed.
//
// 4. The verdict is per program and per payload. The artifact records what
//    the store now holds, so the sweep can be re-measured against it. It
//    does NOT claim the payloads decode: 22 of the 34 pullable programs
//    publish an IDL with NO stored discriminators (Anchor's rule can supply
//    them), and a derived discriminator that does not match the wire is a
//    refusal, not a decode. The artifact says which programs carry stored
//    discriminators so the coverage claim stays honest.
//
// Exit codes: 0 measured (every candidate resolved), 2 usage/IO,
// 3 no verdict (a probe failed — the artifact still records what WAS
// measured, and the unknown rows are named).

import { readFileSync, writeFileSync } from 'node:fs';
import { addresses, decodeAccount, rpcAccounts } from '../src/acquire.mjs';
import { installIdl } from '../src/pull.mjs';

/**
 * The gap report is the denominator, checked against ITSELF: its per-row
 * payload counts must sum to its own headline, and that headline must equal
 * the sweep report's noInterface (source.noInterface) the classifier derived
 * it from. A hand-edited row is refused before any probe runs — the same
 * rule `programsFromReport` applies to the sweep report itself.
 */
export function candidatesFromGap(gap) {
  if (!Array.isArray(gap.rows) || !gap.rows.length) throw Error('gap report has no rows');
  const sum = gap.rows.reduce((n, row) => n + (row.payloads ?? 0), 0);
  if (sum !== gap.summary?.payloads) {
    throw Error(`gap rows sum to ${sum} but summary.payloads says ${gap.summary?.payloads} — hand-edited artifact`);
  }
  if (gap.source?.noInterface != null && gap.summary.payloads !== gap.source.noInterface) {
    throw Error(`gap summary.payloads ${gap.summary.payloads} != source.noInterface ${gap.source.noInterface}`);
  }
  const pullable = gap.rows.filter((row) => row.verdict === 'pullable');
  if (!pullable.length) throw Error('the gap report names no pullable program');
  return pullable.map((row) => ({ program: row.program, payloads: row.payloads }));
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Probe AND store in one pass: the accounts are already in hand when they
 * are decoded, so the IDL is installed from that same evidence rather than
 * from a second probe (a second probe could see a different slot).
 */
export async function acquire(programs, { url, fetcher = fetch, store, batchSize = 25, tries = 3 } = {}) {
  const rows = [];
  const slots = [];
  for (const group of chunk(programs, batchSize)) {
    const locations = await Promise.all(group.map(async ({ program }) => addresses(program)));
    const keys = locations.flatMap(({ metadata, anchor }) => [metadata, anchor]);
    const response = await rpcAccounts(url, keys, fetcher, tries);
    if (response.error) {
      for (const { program, payloads } of group) {
        rows.push({ program, payloads, verdict: 'unknown', error: response.error });
      }
      continue;
    }
    if (Number.isSafeInteger(response.slot)) slots.push(response.slot);
    for (const [index, { program, payloads }] of group.entries()) {
      const accounts = [response.accounts[2 * index], response.accounts[2 * index + 1]];
      let chosen = null;
      const errors = [];
      for (const [source, address, account] of [
        ['metadata', locations[index].metadata, accounts[0]],
        ['anchor', locations[index].anchor, accounts[1]],
      ]) {
        if (!account) { errors.push(`${source}: account missing`); continue; }
        try {
          chosen = { source, address, idl: decodeAccount(account, source, program) };
          break;
        } catch (error) { errors.push(`${source}: ${String(error.message).slice(0, 100)}`); }
      }
      if (!chosen) {
        rows.push({ program, payloads, verdict: 'undecodable', slot: response.slot, errors });
        continue;
      }
      const receipt = await installIdl(chosen.idl, {
        program, source: chosen.source, address: chosen.address, slot: response.slot,
      }, store);
      const stored = chosen.idl.instructions.filter((ix) => Array.isArray(ix.discriminator)).length;
      rows.push({
        program, payloads, verdict: 'stored', slot: response.slot,
        source: chosen.source, address: chosen.address,
        instructions: chosen.idl.instructions.length,
        storedDiscriminators: stored,
        derivedDiscriminators: chosen.idl.instructions.length - stored,
        decodableStoredOnly: stored > 0,
        fingerprint: receipt.fingerprint,
      });
    }
  }
  const summary = {
    candidates: programs.length,
    stored: rows.filter((r) => r.verdict === 'stored').length,
    storedPayloads: rows.filter((r) => r.verdict === 'stored').reduce((n, r) => n + r.payloads, 0),
    undecodable: rows.filter((r) => r.verdict === 'undecodable').length,
    unknown: rows.filter((r) => r.verdict === 'unknown').length,
    storedWithDiscriminators: rows.filter((r) => r.verdict === 'stored' && r.decodableStoredOnly).length,
    storedNeedingDerivation: rows.filter((r) => r.verdict === 'stored' && !r.decodableStoredOnly).length,
  };
  summary.verdict = summary.unknown > 0 ? 'no-verdict' : 'measured';
  return { rows, summary, slots };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const gapPath = option('--gap', undefined);
    if (!gapPath) {
      console.error('usage: node tools/batch-pull.mjs --gap <acquisition-gap.json> --store <dir> [--out <file>] [--rpc <url>]');
      process.exit(2);
    }
    const gap = JSON.parse(readFileSync(gapPath, 'utf8'));
    // The gap report is the denominator (checked above), and only its
    // PULLABLE rows are candidates — a `no-interface-published` row is not
    // retried, because pulling it can never succeed.
    const candidates = candidatesFromGap(gap);
    const store = option('--store', undefined);
    if (!store) throw Error('--store is required: the artifact must name where the bytes went');
    const url = option('--rpc', process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const { rows, summary, slots } = await acquire(candidates, { url, store });
    const artifact = {
      tool: 'batch-pull',
      generatedAt: new Date().toISOString(),
      rpcUrl: url,
      slots,
      source: { gap: gapPath, generatedAt: gap.generatedAt, programs: gap.summary?.programs ?? null },
      store,
      summary,
      rows,
    };
    const outPath = option('--out', undefined);
    if (outPath) writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
    console.log(JSON.stringify({ ...summary, output: outPath ?? null, slots }, null, 1));
    if (summary.verdict === 'no-verdict') process.exitCode = 3;
  } catch (error) {
    console.error(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exitCode = 2;
  }
}
