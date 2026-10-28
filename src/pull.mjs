// First sememe capability: pull a Solana program IDL into a local content-addressed store.
// No decoding of transactions yet; no network call after the pull is stored.
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { addresses, decodeAccount, rpcAccounts } from '../tools/measure.mjs';

// Re-exported from its own module so a consumer can verify a fingerprint
// without importing this file (and therefore without @solana/web3.js).
export { canonicalJson } from './canonical.mjs';
import { canonicalJson } from './canonical.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const validId = (input) => {
  if (typeof input !== 'string') throw Error('program id must be a string');
  const pk = new PublicKey(input);
  if (pk.toBase58() !== input) throw Error('noncanonical program id');
  return pk.toBase58();
};

// This fingerprint describes JSON content, not freshness, chain authenticity, or ABI parity.
// The canonical form itself lives in src/canonical.mjs (dependency-free);
// re-exported above for callers that import it from here.

async function writeOnce(destination, content) {
  try {
    const entry = await lstat(destination);
    if (!entry.isFile() || entry.isSymbolicLink()) throw Error(`non-regular store entry: ${destination}`);
    const current = await readFile(destination);
    if (!current.equals(content)) throw Error(`digest collision or corrupted local object: ${destination}`);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = null;
    // Atomic no-replace installation: hard-link fails if another writer won.
    // Rename would overwrite a concurrently created or symlinked digest path.
    try { await link(temporary, destination); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const entry = await lstat(destination);
      if (!entry.isFile() || entry.isSymbolicLink()) throw Error(`non-regular store entry: ${destination}`);
      const current = await readFile(destination);
      if (!current.equals(content)) throw Error(`digest collision or corrupted local object: ${destination}`);
    }
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

export async function pull(programInput, storeDir, rpcUrl = 'https://api.mainnet-beta.solana.com', fetcher = fetch) {
  const program = validId(programInput);
  if (typeof storeDir !== 'string' || !storeDir.trim()) throw Error('explicit --store path required');
  if (!/^https:\/\//.test(rpcUrl)) throw Error('HTTPS RPC URL required');
  const { metadata, anchor } = await addresses(program);
  const response = await rpcAccounts(rpcUrl, [metadata, anchor], fetcher, 3);
  if (response.error) throw Error(`RPC unavailable: ${response.error}`);
  let selected, idl;
  const errors = [];
  for (const [source, address, account] of [
    ['metadata', metadata, response.accounts[0]], ['anchor', anchor, response.accounts[1]],
  ]) {
    if (!account) { errors.push(`${source}: account missing`); continue; }
    try {
      idl = decodeAccount(account, source, program);
      selected = { source, address };
      break;
    } catch (error) { errors.push(`${source}: ${String(error.message).slice(0, 100)}`); }
  }
  if (!selected) throw Error(`no verified on-chain IDL for ${program}: ${errors.join('; ')}`);
  const json = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = sha256(json);
  if (!Number.isSafeInteger(response.slot) || response.slot < 0) throw Error('RPC context lacks a valid slot');
  const directory = path.resolve(storeDir);
  const objects = path.join(directory, 'objects');
  const receipts = path.join(directory, 'receipts');
  await mkdir(objects, { recursive: true, mode: 0o700 });
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const file = path.join(objects, `${fingerprint}.json`);
  await writeOnce(file, json);
  const receipt = {
    program, source: selected.source, address: selected.address, slot: response.slot,
    fingerprint: `sha256:${fingerprint}`, instructionCount: idl.instructions.length,
  };
  const receiptPath = path.join(receipts, `${program}-${response.slot}-${selected.source}-${fingerprint}.json`);
  await writeOnce(receiptPath, Buffer.from(canonicalJson(receipt) + '\n'));
  return { ...receipt, path: file, receiptPath };
}
