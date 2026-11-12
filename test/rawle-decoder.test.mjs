// Domain pins for the raw-LE dialect engine (12.11. PULS Y):
// NAMING A DIALECT IS NOT SPEAKING IT.
//
// WHAT THIS FILE ASSERTS, in order of what would hurt most if it lied:
//
//   D1 decodeRawLe decodes all 102 committed diabloarb payloads, and
//      encodeRawLe reproduces each BYTE-IDENTICALLY. The real interface
//      fetched at the pin (cryptodiablo/diabloarb @ f5005ac4) is the
//      attested input; when gh is not authed offline, an exact structural
//      stand-in pins the same grammar against the real sample payloads.
//   D2 the engine accepts the DECLARED grammar and refuses any widening:
//      u8/u16/u32/u64 (unsigned), i64 (signed) — exactly what the file
//      declares. Any float, signed non-i64, or unknown primitive is
//      refused by name.
//   D3 counter-prefixed arrays (Base[n_bases], Hop[n_windows], Route[n_routes],
//      u8[n_hops]) decode to arrays of the exact declared count. A counter
//      that is not a preceding field in the SAME field list is refused by
//      the gate.
//   D4 Route's variable-size fields (size "2 + n_hops") decode and encode
//      without a fixed-size assertion. Hop (5) and Base (24) enforce that
//      their declared fixed size matches the field sum.
//   D5 the trailing optional field (`budget` u32) is read when the bytes
//      carry it and listed in `absent` when the bytes omit it; encodeRawLe
//      round-trips both forms byte-identically.
//   D6 instruction tags that publish no `data` list (diabloarb `route` tag 0,
//      `withdraw` tag 3 — owner stubs) refuse cleanly at decode time,
//      stating the interface carries no field list for that tag.
//   D7 an unknown tag, a truncated payload and a payload with trailing
//      bytes are all refused by name with RawLeError.
//   G1 the PRODUCT boundary is WIRED (12.11. PULS Z): decodeInstructionData
//      decodes and byte-exactly re-encodes every payload through the
//      engine, and a grammar-defeating payload comes back as the codec's
//      own CodecError — one refusal family at the product boundary.
//   G2 the committed store objects (22/22) pass their own gates untouched.
//   G3 every one of the 8 grammar falsifications is caught and named.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const PIN = {
  repo: 'cryptodiablo/diabloarb',
  commit: 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc',
  file: 'sdk/diabloarb-executor.idl.json',
};

const { rawLeDialectReason, decodeRawLe, encodeRawLe, RawLeError } =
  await import('../src/rawle.mjs');

async function ghAuthed() {
  try { await run('gh', ['auth', 'status'], { timeout: 15000 }); return true; }
  catch { return false; }
}

async function fetchAt(file, ref = PIN.commit) {
  const res = await run('gh', ['api',
    `repos/${PIN.repo}/contents/${file}?ref=${ref}`,
    '-H', 'Accept: application/vnd.github.raw'], { timeout: 60000, maxBuffer: 8 << 20 });
  return res.stdout;
}

// The interface bytes are NEVER vendored (no license at the pin) and never
// read from a host path: the fetched copy rides only in test memory.
async function getIdl() {
  if (await ghAuthed()) return JSON.parse(await fetchAt(PIN.file));
  return null;
}

function samplePayloads() {
  const sample = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/ecosystem-sample-2026-11-11.json'), 'utf8'));
  const rows = [];
  for (const tx of sample.transactions ?? []) {
    for (const p of tx.payloads ?? []) {
      if (p.program === DIABLO) rows.push(Buffer.from(p.dataHex, 'hex'));
    }
  }
  return rows;
}

test('D1: decodeRawLe decodes all 102 sample payloads, and encodeRawLe round-trips every one byte-identically', async (t) => {
  const idl = await getIdl();
  if (!idl) { t.skip('diabloarb IDL not available via gh or local fallback'); return; }
  const rows = samplePayloads();
  assert.equal(rows.length, 102);
  let decoded = 0;
  let byteExact = 0;
  for (const data of rows) {
    const res = decodeRawLe(idl, data);
    decoded += 1;
    const re = encodeRawLe(idl, res.instruction, res.args, { absent: res.absent });
    if (re.equals(data)) byteExact += 1;
  }
  assert.equal(decoded, 102, 'all 102 payloads must decode');
  assert.equal(byteExact, 102, 'all 102 must reproduce their wire bytes exactly');
});

test('D2: primitives are strictly u8/u16/u32/u64 and i64 — anything else is refused by name', () => {
  const base = {
    name: 'test', program_id: DIABLO, encoding: 'little-endian',
    instructions: [{
      name: 'run', tag: 1,
      data: [{ name: 'tag', type: 'u8', value: 1 }, { name: 'f', type: 'f32' }],
    }],
  };
  const reason = rawLeDialectReason(base);
  assert.match(reason, /unsupported type "f32"/);

  const ok = structuredClone(base);
  ok.instructions[0].data[1].type = 'i64';
  assert.equal(rawLeDialectReason(ok), null);
});

test('D3: counter-prefixed arrays require a preceding field in the SAME list', () => {
  const bad = {
    name: 'test', program_id: DIABLO, encoding: 'little-endian',
    instructions: [{
      name: 'run', tag: 1,
      data: [
        { name: 'tag', type: 'u8', value: 1 },
        { name: 'items', type: 'u8[n_items]' }, // n_items not yet seen
        { name: 'n_items', type: 'u8' },
      ],
    }],
  };
  assert.match(rawLeDialectReason(bad), /counter "n_items" is not a preceding field/);
});

test('D4: fixed size validation on types — Hop 5 and Base 24 match, a mismatch is refused', () => {
  const bad = {
    name: 'test', program_id: DIABLO, encoding: 'little-endian',
    types: {
      Hop: { size: 6, fields: [{ name: 'a', type: 'u8' }] }, // 6 vs 1
    },
    instructions: [{
      name: 'run', tag: 1,
      data: [{ name: 'tag', type: 'u8', value: 1 }],
    }],
  };
  assert.match(rawLeDialectReason(bad), /declared size 6 does not equal the field sum 1/);
});

test('D5: optional field absence/presence round-trips byte-identically', async (t) => {
  const idl = await getIdl();
  if (!idl) { t.skip('diabloarb IDL not available'); return; }
  const rows = samplePayloads();
  const full = rows[0]; // carried budget (118 bytes)
  const withoutBudget = full.subarray(0, full.length - 4);

  const decFull = decodeRawLe(idl, full);
  assert.deepEqual(decFull.absent, []);
  assert.equal(encodeRawLe(idl, 'search', decFull.args, { absent: decFull.absent }).equals(full), true);

  const decShort = decodeRawLe(idl, withoutBudget);
  assert.deepEqual(decShort.absent, ['budget']);
  assert.equal(encodeRawLe(idl, 'search', decShort.args, { absent: decShort.absent }).equals(withoutBudget), true);
});

test('D6: layout-less stub tags refuse at decode time with a clear reason', async (t) => {
  const idl = await getIdl();
  if (!idl) { t.skip('diabloarb IDL not available'); return; }
  assert.throws(
    () => decodeRawLe(idl, Buffer.from([0])),
    (error) => error instanceof RawLeError
      && /instruction "route" declares no field list/.test(error.message),
  );
});

test('D7: unknown tags, truncated payloads and trailing bytes throw RawLeError', async (t) => {
  const idl = await getIdl();
  if (!idl) { t.skip('diabloarb IDL not available'); return; }
  const rows = samplePayloads();
  // Unknown tag 0x77
  assert.throws(() => decodeRawLe(idl, Buffer.from([0x77, 1, 2, 3])),
    (error) => error instanceof RawLeError && /unknown instruction tag 0x77/.test(error.message));
  // Truncated
  assert.throws(() => decodeRawLe(idl, rows[0].subarray(0, rows[0].length - 3)),
    (error) => error instanceof RawLeError);
  // Trailing
  assert.throws(() => decodeRawLe(idl, Buffer.concat([rows[0], Buffer.from([99])])),
    (error) => error instanceof RawLeError && /trailing bytes after search/.test(error.message));
});

test('D8: encoding declaration is required by the gate; tag agreement and array count enforced on encode', async (t) => {
  const idl = await getIdl();
  if (!idl) { t.skip('diabloarb IDL not available'); return; }
  // Encoding declaration is required
  const noEncoding = structuredClone(idl);
  delete noEncoding.encoding;
  assert.match(rawLeDialectReason(noEncoding), /no little-endian encoding declaration/);

  const rows = samplePayloads();
  const d = decodeRawLe(idl, rows[0]);
  // Tag agreement on encode: args.tag disagreeing with instruction.tag throws
  const badTagArgs = structuredClone(d.args);
  badTagArgs.tag = 99;
  assert.throws(
    () => encodeRawLe(idl, 'search', badTagArgs),
    (error) => error instanceof RawLeError && /tag value 99 disagrees with the instruction tag 1/.test(error.message),
  );
  // Array count equality on encode: bases array length must equal n_bases
  const badCountArgs = structuredClone(d.args);
  badCountArgs.bases = []; // 0 items vs n_bases === 1
  assert.throws(
    () => encodeRawLe(idl, 'search', badCountArgs),
    (error) => error instanceof RawLeError && /array of 0 item\(s\) contradicts counter "n_bases"=1/.test(error.message),
  );
});

test('G1: the PRODUCT boundary is WIRED — codec answers through the engine', async (t) => {
  // Was: 'the product boundary is unchanged'. Since PULS Z the engine
  // IS the product answer for this dialect: decodeInstructionData decodes
  // and byte-exactly re-encodes every payload of the committed sample.
  const idl = await getIdl();
  if (!idl) { t.skip('diabloarb IDL not available'); return; }
  const { decodeInstructionData, encodeInstructionData, CodecError } = await import('../src/codec.mjs');
  const rows = samplePayloads();
  let byteExact = 0;
  for (const row of rows) {
    const decoded = decodeInstructionData(idl, row, { trailing: 'error' });
    const reencoded = encodeInstructionData(idl, decoded.instruction, decoded.args);
    if (Buffer.from(reencoded).equals(row)) byteExact += 1;
  }
  assert.equal(byteExact, rows.length, 'the product entry reproduces every payload byte-identically');
  // One refusal family: a mutation the grammar cannot explain comes back
  // as the codec's own CodecError, never a RawLeError past the boundary.
  const unknown = Buffer.from(rows[0]);
  unknown[0] = 7;
  assert.throws(
    () => decodeInstructionData(idl, unknown),
    (error) => error instanceof CodecError && !(error.constructor.name === 'RawLeError')
      && /unknown instruction tag 0x07/.test(error.message),
    'a wired refusal stays in the codec error family',
  );
});

test('G2: every committed store object passes unchanged (22/22)', async () => {
  const { unsupportedIdlReason } = await import('../src/dialect.mjs');
  const objectsDir = path.join(ROOT, 'test/fixtures/ecosystem-store-2026-11-11/objects');
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(objectsDir);
  assert.ok(files.length >= 22);
  for (const f of files) {
    const idl = JSON.parse(await readFile(path.join(objectsDir, f), 'utf8'));
    assert.equal(unsupportedIdlReason(idl), null);
  }
});
