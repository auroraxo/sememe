// Probe A: a NON-RECEIPT file (no dash) in receipts/ — does `writeLock` crash?
// Probe B: an older DAMAGED receipt of the SAME program — plain decode vs
//          union decode vs lock vs verify: four commands, how many verdicts?
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

// ---------------- PROBE A: stray dash-less file in receipts/ ----------------
{
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-probeA-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  await put(store, P, idl, 462039125, 'metadata');
  // A file any user/OS/tool can leave behind: no dash in the name.
  await writeFile(path.join(store, 'receipts', '.DS_Store'), 'junk');
  const out = path.join(store, 'sememe.lock');
  let lockErr = null;
  try { await writeLock(store, out); } catch (e) { lockErr = String(e.message); }
  let verifyErr = null, verifyReport = null;
  try { verifyReport = await checkLock(store, out, { mode: 'error' }); }
  catch (e) { verifyErr = String(e.message); }
  console.log('=== PROBE A: dash-less file .DS_Store in receipts/ ===');
  console.log('writeLock :', lockErr ? `THREW: ${lockErr}` : 'exit 0, lock written');
  console.log('checkLock :', verifyErr ? `THREW: ${verifyErr}` : `clean, violations=${verifyReport.violations}`);
  await rm(store, { recursive: true, force: true });
}

// ---------------- PROBE B: damaged OLDER receipt of the SAME program --------
{
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-probeB-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const oldFp = await put(store, P, idl, 99999999, 'metadata');
  const newFp = await put(store, P, idl, 123456789, 'metadata');
  const lockPath = path.join(store, 'sememe.lock');
  await writeLock(store, lockPath);
  // Damage the OLDER receipt's object (the newest is what plain decode reads)
  await writeFile(path.join(store, 'objects', `${oldFp}.json`), '{"instructions":[]}\n');

  // find a decodable payload from the IDL: use a trivial one — first instruction discriminator
  const ix = idl.instructions.find((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8);
  const payload = Buffer.from([...ix.discriminator, ...new Array(8).fill(0)]).toString('hex');

  const results = {};
  try { await decodePayload(store, P, payload); results.plainDecode = 'DECODED'; }
  catch (e) { results.plainDecode = `REFUSED: ${String(e.message).slice(0, 110)}`; }
  try { await decodeUnionPayload(store, P, payload); results.unionDecode = 'DECODED'; }
  catch (e) { results.unionDecode = `REFUSED: ${String(e.message).slice(0, 110)}`; }
  let l = null;
  try { await writeLock(store, path.join(store, 'x.lock')); l = 'lock WRITTEN'; } catch (e) { l = `lock REFUSED: ${String(e.message).slice(0, 90)}`; }
  results.writeLock = l;
  try {
    const r = await checkLock(store, lockPath, { mode: 'error' });
    results.checkLock = `clean violations=${r.violations}`;
  } catch (e) { results.checkLock = `VIOLATION: ${String(e.message).slice(0, 90)}`; }
  console.log('=== PROBE B: damaged OLDER receipt, newest intact (newFp, slots 99999999<123456789) ===');
  for (const [k, v] of Object.entries(results)) console.log(k.padEnd(12), v);
  await rm(store, { recursive: true, force: true });
}
