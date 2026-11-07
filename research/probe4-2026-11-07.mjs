// A4: stray files under a REAL program prefix, receipt-dir only.
//     Which surfaces break, and with which verdict?
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

async function put(store, program, body, slot, source) {
  const bytes = Buffer.from(canonicalJson(body) + '\n');
  const fp = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fp}.json`), bytes);
  await writeFile(path.join(store, 'receipts', `${program}-${slot}-${source}-${fp}.json`),
    JSON.stringify({ program, fingerprint: `sha256:${fp}`, slot, source }));
  return fp;
}
const ix = idl.instructions.find((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8);
const payload = Buffer.from([...ix.discriminator, ...new Array(8).fill(0)]).toString('hex');
const probe = async (label, fn) => {
  try { console.log(`  ${label.padEnd(15)} ${await fn()}`); }
  catch (e) { console.log(`  ${label.padEnd(15)} THREW: ${String(e.message).slice(0, 120)}`); }
};

// stray names under the REAL program prefix, none of them receipts
const strays = [
  `${P}-junk.json`,                                   // program prefix, no slot/hex
  `${P}-1234-backup-copy.json`,                       // program+slot, no 64hex tail
  `${P}-99999999-x-aaaa.json`,                        // program+slot, short hex
  `${P}-0-meteora-published-test-fixture-pin--33d0a1e29e72a050ead4ea885a28b0a05abe29b9af397786f209c9c7f5d4b5e2.json.bak`, // real receipt + .bak
];

for (const stray of strays) {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-A4-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  await put(store, P, idl, 462039125, 'metadata');
  const lockPath = path.join(store, 'sememe.lock');
  await writeLock(store, lockPath);
  await writeFile(path.join(store, 'receipts', stray), 'garbage, not a receipt');
  console.log(`=== stray: ${stray.slice(0, 80)} ===`);
  await probe('decode', async () => { await decodePayload(store, P, payload); return 'DECODED'; });
  await probe('decode --union', async () => { await decodeUnionPayload(store, P, payload); return 'DECODED'; });
  await probe('writeLock', async () => { await writeLock(store, path.join(store, 'y.lock')); return 'exit 0'; });
  await probe('checkLock(error)', async () => { await checkLock(store, lockPath, { mode: 'error' }); return 'clean'; });
  await rm(store, { recursive: true, force: true });
}
