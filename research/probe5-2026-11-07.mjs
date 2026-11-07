// A5: stray file with a HUGE slot segment -> does it displace the newest
//     receipt that plain decode reads?
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const { canonicalJson } = await import('../src/canonical.mjs');
const { decodePayload } = await import('../src/decode.mjs');

const P = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const idl = JSON.parse(readFileSync(new URL('../test/fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const bytes = Buffer.from(canonicalJson(idl) + '\n');
const fp = createHash('sha256').update(bytes).digest('hex');

const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-A5-'));
await mkdir(path.join(store, 'objects'), { recursive: true });
await mkdir(path.join(store, 'receipts'), { recursive: true });
await writeFile(path.join(store, 'objects', `${fp}.json`), bytes);
await writeFile(path.join(store, 'receipts', `${P}-462039125-metadata-${fp}.json`),
  JSON.stringify({ program: P, fingerprint: `sha256:${fp}`, slot: 462039125, source: 'metadata' }));
// stray: non-receipt content, but a slot segment that sorts AFTER the real one
await writeFile(path.join(store, 'receipts', `${P}-999999999-junk-aaaa.json`), 'garbage');

const ix = idl.instructions.find((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8);
const payload = Buffer.from([...ix.discriminator, ...new Array(8).fill(0)]).toString('hex');
try { await decodePayload(store, P, payload); console.log('plain decode: DECODED'); }
catch (e) { console.log(`plain decode: REFUSED — ${String(e.message).slice(0, 140)}`); }
await rm(store, { recursive: true, force: true });
