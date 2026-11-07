// A3: a stray file in receipts/ whose name CONTAINS a dash.
//     checkLock derives programs from the name's first dash-run, so a stray
//     file becomes a phantom program — and its receipt check fails.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const { canonicalJson } = await import('../src/canonical.mjs');
const { writeLock, checkLock } = await import('../src/lock.mjs');

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

for (const stray of ['my-file.json', '.DS_Store', 'README']) {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-A3-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  await put(store, P, idl, 462039125, 'metadata');
  const lockPath = path.join(store, 'sememe.lock');
  await writeLock(store, lockPath);
  await writeFile(path.join(store, 'receipts', stray), 'not a receipt');
  console.log(`=== stray file: ${stray} ===`);
  try { await writeLock(store, path.join(store, 'y.lock')); console.log('  writeLock  : exit 0'); }
  catch (e) { console.log(`  writeLock  : THREW ${String(e.message).slice(0, 100)}`); }
  try {
    const r = await checkLock(store, lockPath, { mode: 'warn' });
    console.log(`  checkLock  : violations=${r.violations} extra=${JSON.stringify(r.extra)} unverified=${JSON.stringify(r.unverified.map((u) => u.program))}`);
  } catch (e) { console.log(`  checkLock  : THREW ${String(e.message).slice(0, 100)}`); }
  await rm(store, { recursive: true, force: true });
}
