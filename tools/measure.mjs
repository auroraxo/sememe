#!/usr/bin/env node
// Reproducible program-IDL coverage test. No user keys, no transactions.
// Account layout/seed logic derived from auroraxo/idl-drift (MIT, src/{derive,index}.mjs).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, inflateSync } from 'node:zlib';
import { PublicKey } from '@solana/web3.js';

export const METADATA_PROGRAM = new PublicKey('ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S');
const ANCHOR_DISCRIMINATOR = Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]);
const MAX_BYTES = 16 << 20;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function addresses(id) {
  const program = new PublicKey(id);
  const seed = Buffer.alloc(16); seed.write('idl');
  const [metadata] = PublicKey.findProgramAddressSync([program.toBuffer(), seed], METADATA_PROGRAM);
  const [base] = PublicKey.findProgramAddressSync([], program);
  const anchor = await PublicKey.createWithSeed(base, 'anchor:idl', program);
  return { metadata: metadata.toBase58(), anchor: anchor.toBase58() };
}

function bodyDecode(bytes, compression) {
  if (bytes.length > MAX_BYTES) throw Error('body exceeds maximum');
  let decoded;
  if (compression === 0) decoded = bytes;
  else if (compression === 1) decoded = gunzipSync(bytes, { maxOutputLength: MAX_BYTES });
  else if (compression === 2) decoded = inflateSync(bytes, { maxOutputLength: MAX_BYTES });
  else throw Error(`unsupported compression: ${compression}`);
  if (decoded.length > MAX_BYTES) throw Error('decompressed body exceeds maximum');
  return JSON.parse(decoded.toString('utf8'));
}

export function inspect(account, source, programId) {
  if (!account) return { state: 'missing' };
  const expectedOwner = source === 'metadata' ? METADATA_PROGRAM.toBase58() : programId;
  if (account.owner !== expectedOwner) return { state: 'wrong_owner', owner: account.owner };
  if (!Array.isArray(account.data) || account.data[1] !== 'base64') return { state: 'invalid_encoding' };
  const bytes = Buffer.from(account.data[0], 'base64');
  let idl;
  try {
    if (source === 'metadata') {
      const seed = Buffer.alloc(16); seed.write('idl');
      if (bytes.length < 96 || bytes[0] !== 2 || !bytes.subarray(1,33).equals(new PublicKey(programId).toBuffer()) ||
          bytes[66] === 0 || !bytes.subarray(67,83).equals(seed) || bytes[83] !== 1 || bytes[85] > 1 || bytes[86] !== 0)
        throw Error('invalid metadata header, binding, source or format');
      const len = bytes.readUInt32LE(87);
      if (len > MAX_BYTES || bytes.length < 96 + len) throw Error('invalid metadata length');
      idl = bodyDecode(bytes.subarray(96, 96 + len), bytes[84]);
    } else {
      if (bytes.length < 44 || !bytes.subarray(0,8).equals(ANCHOR_DISCRIMINATOR)) throw Error('invalid Anchor header');
      const len = bytes.readUInt32LE(40);
      if (len > MAX_BYTES || bytes.length < 44 + len) throw Error('invalid Anchor length');
      idl = bodyDecode(bytes.subarray(44, 44 + len), 2);
    }
    if (!idl || typeof idl !== 'object' || !Array.isArray(idl.instructions) || !idl.instructions.length ||
        idl.instructions.some(x => !x || typeof x.name !== 'string' || !x.name))
      throw Error('no usable instruction schema');
    if (idl.address && idl.address !== programId) throw Error('IDL declares another program');
    const digest = createHash('sha256').update(JSON.stringify(idl)).digest('hex');
    return { state: 'usable', instructions: idl.instructions.length, fingerprint: digest };
  } catch (error) {
    return { state: 'undecodable', error: String(error?.message ?? error).slice(0, 150) };
  }
}

async function rpcAccounts(url, keys, fetcher = fetch, tries = 3) {
  const payload = { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
    params: [keys, { encoding: 'base64', commitment: 'finalized' }] };
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          const retry = Number(response.headers.get('retry-after'));
          if (attempt < tries - 1) { await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 10000) : (attempt + 1) * 1500); continue; }
        }
        throw Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (data.error) throw Error(`RPC error ${data.error.code ?? 'unknown'}`);
      if (!Array.isArray(data.result?.value) || data.result.value.length !== keys.length) throw Error('malformed RPC response');
      return { slot: data.result.context?.slot ?? null, accounts: data.result.value };
    } catch (error) {
      if (attempt === tries - 1) return { error: String(error?.message ?? error).slice(0, 150) };
      await sleep((attempt + 1) * 1500);
    }
  }
  return { error: 'exhausted retries' };
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
  return { timestamp: new Date().toISOString(), rpcUrl: url, count: rows.length,
    usable, unknown, notUsable: rows.length - usable - unknown,
    coveragePct: +(100 * usable / rows.length).toFixed(1),
    interpretation: unknown ? 'incomplete: RPC failures; do not classify unknowns as missing' :
      usable < 10 ? 'below 50%: on-chain-only product thesis fails this sample' :
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
