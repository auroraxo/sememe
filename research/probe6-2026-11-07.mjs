// A6: the trigger is sememe ITSELF. src/store-write.mjs writes a receipt via
//     a temp file `${destination}.tmp-<pid>-<rand>` in the SAME directory and
//     removes it in a finally. A crash (SIGKILL, power loss, OOM) between the
//     write and the cleanup leaves that file behind in receipts/ forever.
//     Does the leftover break the lock/verify gate and the decoders?
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const { canonicalJson } = await import('../src/canonical.mjs');
const { writeLock, checkLock } = await import('../src/lock.mjs');
const { decodePayload, decodeUnionPayload } = await import('../src/decode.mjs');

const P = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const idl = JSON.parse(readFileSync(new URL('../test/fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const ix = idl.instructions.find((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8);
const payload = Buffer.from([...ix.discriminator, ...new Array(8).fill(0)]).toString('hex');

const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-A6-'));
await mkdir(path.join(store, 'objects'), { recursive: true });
await mkdir(path.join(store, 'receipts'), { recursive: true });
const bytes = Buffer.from(canonicalJson(idl) + '\n');
const fp = createHash('sha256').update(bytes).digest('hex');
await writeFile(path.join(store, 'objects', `${fp}.json`), bytes);
const receiptName = `${P}-462039125-metadata-${fp}.json`;
await writeFile(path.join(store, 'receipts', receiptName),
  JSON.stringify({ program: P, fingerprint: `sha256:${fp}`, slot: 462039125, source: 'metadata' }));

const lockPath = path.join(store, 'sememe.lock');
await writeLock(store, lockPath);

// EXACTLY what src/store-write.mjs leaves behind when the process dies
// between writeFile and the finally-cleanup:
const debris = `${receiptName}.tmp-4711-9f2c1a`;
await writeFile(path.join(store, 'receipts', debris), bytes);

const probe = async (label, fn) => {
  try { console.log(`  ${label.padEnd(15)} ${await fn()}`); }
  catch (e) { console.log(`  ${label.padEnd(15)} THREW: ${String(e.message).slice(0, 130)}`); }
};
console.log('=== A6: leftover .tmp- debris from a CRASHED write (sememe\'s own file) ===');
await probe('decode', async () => { await decodePayload(store, P, payload); return 'DECODED'; });
await probe('decode --union', async () => { await decodeUnionPayload(store, P, payload); return 'DECODED'; });
await probe('writeLock', async () => { await writeLock(store, path.join(store, 'y.lock')); return 'exit 0'; });
await probe('checkLock(error)', async () => { await checkLock(store, lockPath, { mode: 'error' }); return 'clean'; });
await rm(store, { recursive: true, force: true });
