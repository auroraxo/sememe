#!/usr/bin/env node
// Reproducible program-IDL coverage test. No user keys, no transactions.
// Account layout/seed logic derived from auroraxo/idl-drift (MIT, src/{derive,index}.mjs).
// The acquisition helpers (addresses / decodeAccount / rpcAccounts) moved to
// src/acquire.mjs on 2026-11-01: `src/pull.mjs` used to import them from
// here, which meant the shipped package had to reach OUT of itself into
// tools/. This file is the coverage harness and keeps only what the harness
// needs; the implementation lives once, in src/acquire.mjs.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  METADATA_PROGRAM, addresses, decodeAccount, rpcAccounts,
} from '../src/acquire.mjs';

export { METADATA_PROGRAM, addresses, decodeAccount, rpcAccounts };

export function inspect(account, source, programId) {
  if (!account) return { state: 'missing' };
  const expectedOwner = source === 'metadata' ? METADATA_PROGRAM.toBase58() : programId;
  if (account.owner !== expectedOwner) return { state: 'wrong_owner', owner: account.owner };
  try {
    const idl = decodeAccount(account, source, programId);
    const digest = createHash('sha256').update(JSON.stringify(idl)).digest('hex');
    // "Usable" must mean a decoder can USE the schema, not that the schema
    // names things. A discriminator-less IDL names every instruction and
    // still decodes nothing: measured on Kamino Lend (66 instructions, 0
    // discriminators), 0 of 1,432 real mainnet payloads decoded.
    const stored = idl.instructions.filter((ix) => Array.isArray(ix.discriminator)).length;
    const derived = idl.instructions.length - stored;
    const decodable = stored + derived > 0;
    return {
      state: 'usable',
      instructions: idl.instructions.length,
      fingerprint: digest,
      // A strict, honest split for the coverage claim:
      //   storedDiscriminators  - the program itself published the bytes
      //   derivedDiscriminators - Anchor's rule can supply them from the name
      //   decodableStoredOnly    - usable with the published bytes alone
      storedDiscriminators: stored,
      derivedDiscriminators: derived,
      decodableStoredOnly: stored > 0,
      decodableWithDerivation: decodable,
    };
  } catch (error) {
    return { state: 'undecodable', error: String(error?.message ?? error).slice(0, 150) };
  }
}

export async function measure(programs, url, fetcher = fetch, options = {}) {
  if (!Array.isArray(programs) || programs.length !== 20 || new Set(programs.map(p => p.id)).size !== 20)
    throw Error('pre-registered manifest must contain exactly 20 unique program IDs');
  // One request gives a consistent slot, avoids public-RPC rate-limit bursts,
  // and keeps the entire pre-registered denominator visible on RPC errors.
  const locations = await Promise.all(programs.map(async ({ id }) => addresses(id)));
  const keys = locations.flatMap(({ metadata, anchor }) => [metadata, anchor]);
  const result = await rpcAccounts(url, keys, fetcher, options.tries ?? 3);
  const rows = programs.map(({ name, id, source }, index) => {
    const { metadata, anchor } = locations[index];
    if (result.error) return { name, id, source, status: 'rpc_error', error: result.error, metadata, anchor };
    const canonical = inspect(result.accounts[2 * index], 'metadata', id);
    const legacy = inspect(result.accounts[2 * index + 1], 'anchor', id);
    const usable = canonical.state === 'usable' ? 'metadata' : legacy.state === 'usable' ? 'anchor' : null;
    return { name, id, source, status: usable ? 'usable' : 'not_usable', usableSource: usable,
      slot: result.slot, metadata, anchor, canonical, legacy };
  });
  const usable = rows.filter(x => x.status === 'usable').length;
  const unknown = rows.filter(x => x.status === 'rpc_error').length;
  // Two coverage numbers, because they answer different questions:
  //  - decodableStoredOnly: the published bytes alone are enough to decode.
  //  - decodableWithDerivation: Anchor's rule can fill a missing discriminator.
  // The venture thesis ("pull an interface and decode it") needs the second;
  // the strictest reading of "the program published its own interface" is the
  // first. Reporting only the old "usable" number hid that gap.
  const decodableStoredOnly = rows.filter((x) => x.status === 'usable' && x.canonical?.decodableStoredOnly
    || x.status === 'usable' && x.legacy?.decodableStoredOnly).length;
  const decodableWithDerivation = rows.filter((x) => x.status === 'usable' && (
    x.canonical?.decodableWithDerivation || x.legacy?.decodableWithDerivation)).length;
  return { timestamp: new Date().toISOString(), rpcUrl: url, count: rows.length,
    usable, unknown, notUsable: rows.length - usable - unknown,
    coveragePct: +(100 * usable / rows.length).toFixed(1),
    decodableStoredOnly,
    decodableWithDerivation,
    decodableStoredOnlyPct: +(100 * decodableStoredOnly / rows.length).toFixed(1),
    decodableWithDerivationPct: +(100 * decodableWithDerivation / rows.length).toFixed(1),
    interpretation: unknown ? 'incomplete: RPC failures; do not classify unknowns as missing' :
      decodableWithDerivation < 10 ? 'below 50%: on-chain-only product thesis fails this sample' :
      'at least 50% in this sample; still no proof of demand', rows };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const manifestPath = process.argv[2];
  if (!manifestPath) { console.error('usage: node tools/measure.mjs manifest.json [output.json]'); process.exitCode = 2; }
  else {
    const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const entries = JSON.parse(readFileSync(manifestPath, 'utf8'));
    try {
      const result = await measure(entries, url);
      if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
      console.log(JSON.stringify({ count: result.count, usable: result.usable, notUsable: result.notUsable,
        unknown: result.unknown, coveragePct: result.coveragePct, interpretation: result.interpretation,
        output: process.argv[3] ?? null }));
      if (result.unknown) process.exitCode = 1;
    } catch (error) { console.error(error); process.exitCode = 2; }
  }
}
