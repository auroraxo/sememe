// Refined probes.
// A: valid lock FIRST, then a dash-less stray file lands in receipts/.
//    Expected surfaces: writeLock (crash?), checkLock (?), decode (?).
// B: two receipts of one program with DIFFERENT bodies (upgrade: old IDL
//    damaged, newest intact): plain vs union vs lock vs verify.
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
const probe = async (label, fn) => {
  try { const v = await fn(); console.log(`  ${label.padEnd(14)} ${v}`); }
  catch (e) { console.log(`  ${label.padEnd(14)} THREW: ${String(e.message).slice(0, 130)}`); }
};

// ---------------- PROBE A2: lock written first, then stray file -------------
{
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-A2-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  await put(store, P, idl, 462039125, 'metadata');
  const lockPath = path.join(store, 'sememe.lock');
  await writeLock(store, lockPath);           // clean store -> lock OK
  await writeFile(path.join(store, 'receipts', '.DS_Store'), 'junk');   // stray, no dash
  const ix = idl.instructions.find((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8);
  const payload = Buffer.from([...ix.discriminator, ...new Array(8).fill(0)]).toString('hex');

  console.log('=== A2: valid lock, then .DS_Store (dash-less) in receipts/ ===');
  await probe('writeLock', async () => { await writeLock(store, path.join(store, 'y.lock')); return 'exit 0, lock written'; });
  await probe('checkLock(error)', async () => { const r = await checkLock(store, lockPath, { mode: 'error' }); return `clean, violations=${r.violations}, extra=${JSON.stringify(r.extra)}`; });
  await probe('checkLock(warn)', async () => { const r = await checkLock(store, lockPath, { mode: 'warn' }); return `violations=${r.violations}, extra=${JSON.stringify(r.extra)}`; });
  await probe('decode', async () => { await decodePayload(store, P, payload); return 'DECODED'; });
  await probe('decode --union', async () => { await decodeUnionPayload(store, P, payload); return 'DECODED'; });
  await rm(store, { recursive: true, force: true });
}

// ---------------- PROBE B2: different bodies, OLD damaged -------------------
{
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-B2-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  // old body: drop one instruction -> different fingerprint
  const oldIdl = JSON.parse(JSON.stringify(idl));
  oldIdl.instructions = oldIdl.instructions.slice(0, -1);
  const oldFp = await put(store, P, oldIdl, 99999999, 'metadata');   // older
  const newFp = await put(store, P, idl, 123456789, 'metadata');     // newest
  const lockPath = path.join(store, 'sememe.lock');
  await writeLock(store, lockPath);
  // Damage ONLY the older object
  await writeFile(path.join(store, 'objects', `${oldFp}.json`), '{"instructions":[]}\n');

  const ix = idl.instructions.find((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8);
  const payload = Buffer.from([...ix.discriminator, ...new Array(8).fill(0)]).toString('hex');

  console.log('=== B2: OLD receipt damaged, NEWEST intact (one program, two bodies) ===');
  console.log(`  oldFp=${oldFp.slice(0, 12)} newFp=${newFp.slice(0, 12)} distinct=${oldFp !== newFp}`);
  await probe('decode', async () => { await decodePayload(store, P, payload); return 'DECODED (from newest)'; });
  await probe('decode --union', async () => { await decodeUnionPayload(store, P, payload); return 'DECODED'; });
  await probe('writeLock', async () => { await writeLock(store, path.join(store, 'x.lock')); return 'lock WRITTEN'; });
  await probe('checkLock(error)', async () => { await checkLock(store, lockPath, { mode: 'error' }); return 'clean'; });
  await rm(store, { recursive: true, force: true });
}
