// The acquisition path: find and decode a program's IDL account from chain.
//
// This module moved out of `tools/measure.mjs` on 2026-11-01 so that
// `src/pull.mjs` never reaches OUT of the shipped package (it used to import
// `../tools/measure.mjs`, which forced a consumer either to miss files or to
// download the whole qualification harness). `tools/measure.mjs` now imports
// these helpers back from here; the CLI/manifest logic stays in tools/.
//
// Everything here touches the network and the ed25519 curve, so this is the
// ONLY file in `src/` allowed to import @solana/web3.js (pinned in
// test/deps.test.mjs). It is deliberately NOT reachable from the package
// entry (`index.mjs`): a decoder-only consumer installs zero packages, and
// the acquisition subpath (`sememe/pull`) declares web3.js as an optional
// peer — pull users install it themselves.
import { gunzipSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export const METADATA_PROGRAM = new PublicKey('ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S');
const ANCHOR_DISCRIMINATOR = Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]);
const MAX_BYTES = 16 << 20;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** The two account addresses a program's interface can live at. */
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

/** Decode a raw IDL account (canonical Program Metadata or legacy anchor:idl). */
export function decodeAccount(account, source, programId) {
  if (!account) throw Error('missing account');
  const expectedOwner = source === 'metadata' ? METADATA_PROGRAM.toBase58() : programId;
  if (account.owner !== expectedOwner) throw Error(`wrong owner: ${account.owner}`);
  if (!Array.isArray(account.data) || account.data[1] !== 'base64') throw Error('invalid encoding');
  const bytes = Buffer.from(account.data[0], 'base64');
  let idl;
  if (source === 'metadata') {
      const seed = Buffer.alloc(16); seed.write('idl');
      if (bytes.length < 96 || bytes[0] !== 2 || !bytes.subarray(1,33).equals(new PublicKey(programId).toBuffer()) ||
          bytes[66] === 0 || !bytes.subarray(67,83).equals(seed) || bytes[83] !== 1 || bytes[85] > 1 || bytes[86] !== 0)
        throw Error('invalid metadata header, binding, source or format');
      const len = bytes.readUInt32LE(87);
      if (len > MAX_BYTES || bytes.length < 96 + len) throw Error('invalid metadata length');
      idl = bodyDecode(bytes.subarray(96, 96 + len), bytes[84]);
  } else if (source === 'anchor') {
    if (bytes.length < 44 || !bytes.subarray(0,8).equals(ANCHOR_DISCRIMINATOR)) throw Error('invalid Anchor header');
    const len = bytes.readUInt32LE(40);
    if (len > MAX_BYTES || bytes.length < 44 + len) throw Error('invalid Anchor length');
    idl = bodyDecode(bytes.subarray(44, 44 + len), 2);
  } else throw Error(`unknown source: ${source}`);
  if (!idl || typeof idl !== 'object' || !Array.isArray(idl.instructions) || !idl.instructions.length ||
      idl.instructions.some(x => !x || typeof x.name !== 'string' || !x.name))
    throw Error('no usable instruction schema');
  if (idl.address && idl.address !== programId) throw Error('IDL declares another program');
  return idl;
}

/** Batched `getMultipleAccounts` with bounded retry; never throws — returns {error} instead. */
/**
 * Classify ONE IDL account: is there a usable schema behind it?
 *
 * "Usable" must mean a decoder can USE the schema, not that the schema names
 * things. A discriminator-less IDL names every instruction and still decodes
 * nothing: measured on Kamino Lend (66 instructions, 0 discriminators), 0 of
 * 1,432 real mainnet payloads decoded.
 *
 * This moved here from tools/measure.mjs on 2026-11-04: the gap classifier
 * (src/gap.mjs) needs it, and the classifier has to work from an INSTALLED
 * package — tools/ is not shipped.
 */
export function inspect(account, source, programId) {
  if (!account) return { state: 'missing' };
  const expectedOwner = source === 'metadata' ? METADATA_PROGRAM.toBase58() : programId;
  if (account.owner !== expectedOwner) return { state: 'wrong_owner', owner: account.owner };
  try {
    const idl = decodeAccount(account, source, programId);
    const digest = createHash('sha256').update(JSON.stringify(idl)).digest('hex');
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

export async function rpcAccounts(url, keys, fetcher = fetch, tries = 3) {
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
