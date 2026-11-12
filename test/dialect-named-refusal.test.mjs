// Domain pins for the non-Anchor dialect gate (12.11. PULS X):
// a codec CRASH is not a REFUSAL, and a derived table must not replace a
// dialect it does not speak.
//
// WHAT THIS FILE ASSERTS, in order of what would hurt most if it lied:
//
//   D1 the measured crash face is NAMED: feeding the real diabloarb
//      interface (fetched at the pin — its bytes are never committed, the
//      upstream repo has no license) to the codec refuses with a CodecError
//      whose message starts `unsupported IDL dialect`, and NEVER with the
//      pre-fix `TypeError: object is not iterable`. The prefix-tree half of
//      the measurement (research/dialect-named-refusal-2026-11-12.json)
//      pins that the TypeError really was the pre-fix voice.
//   D2 the reason text is IDENTICAL at every boundary the defect could
//      enter through: codec context(), the derivation, adopt, store read.
//   D3 the derivation fills NO Anchor sighash over a tag-dispatch interface
//      (pre-fix: filled 4/0 over the diabloarb 4 instructions — a table
//      matching no wire byte).
//   D4 adopt refuses a declared program under ANY field name — `address`
//      (Anchor), `metadata.address` (shank), `program_id` (diabloarb, the
//      measured face: old check read only `idl.address`, adopt under WSOL
//      succeeded) — and names the field.
//   D5 store-read refuses the same mismatch on the read side, under
//      `program_id` too (a store object must never become another
//      source's names).
//   G1 the gate is SURGICAL: a supported anchor interface, a legacy
//      name-only anchor interface (Kamino: no selectors, account lists
//      drive conform) and a shank interface all pass unchanged; every
//      committed store object stays readable (22/22).
//   G2 instruction entries WITHOUT `args` but without tag/data shape stay
//      supported — `measure.test.mjs`'s legacyAccount and the dedicated
//      parser's binding face pin that shape, and the Kamino conform
//      dependency is on exactly it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PIN = {
  repo: 'cryptodiablo/diabloarb',
  commit: 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc',
  file: 'sdk/diabloarb-executor.idl.json',
};

const { unsupportedIdlReason, idlDialect, declaredProgram, isTagDispatchInstruction } =
  await import('../src/dialect.mjs');

// The real interface at the pin. Unlicensed upstream => fetched, never
// committed: same licensing gate the archer/manifest/pump measurements used.
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

async function withTempStore(fn) {
  const store = await mkdtemp(path.join(tmpdir(), 'sememe-dialect-gate-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  try { return await fn(store); }
  finally { await rm(store, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 }); }
}

// A structurally minimal stand-in for the measured shape, so D2/D3/D4 are
// pinned OFFLINE: dict `types`, tag/data instructions, `program_id` only.
const tagDispatchIdl = () => JSON.stringify({
  name: 'diabloarb_executor',
  program_id: DIABLO,
  encoding: 'little-endian',
  types: { Hop: { size: 5, fields: [{ name: 'dex', type: 'u8' }] } },
  instructions: [
    { name: 'search', tag: 1, data: [{ name: 'tag', type: 'u8', value: 1 }] },
    { name: 'quote', tag: 2, data: [{ name: 'tag', type: 'u8', value: 2 }] },
  ],
});

test('D1: the measured crash face is a NAMED CodecError, never a TypeError', async () => {
  const { decodeInstructionData, CodecError } = await import('../src/codec.mjs');
  const idl = JSON.parse(tagDispatchIdl());
  const payload = Buffer.from('01' + '02'.repeat(12), 'hex');
  assert.throws(
    () => decodeInstructionData(idl, payload, { trailing: 'report' }),
    (error) => {
      assert.ok(error instanceof CodecError, `expected a CodecError, got ${error.constructor.name}: ${error.message}`);
      assert.match(error.message, /^unsupported IDL dialect:/);
      assert.doesNotMatch(error.message, /is not iterable|Symbol\(Symbol\.iterator\)/,
        'the pre-fix crash voice must not survive anywhere');
      return true;
    },
  );
});

test('D1b: the real interface at the pin refuses by name in the product codec', async (t) => {
  if (!await ghAuthed()) { t.skip('gh CLI not authenticated; skipping pin fetch'); return; }
  const raw = await fetchAt(PIN.file);
  const idl = JSON.parse(raw);
  assert.equal(idl.program_id, DIABLO, 'the pinned file declares this program');
  const { decodeInstructionData, CodecError } = await import('../src/codec.mjs');
  assert.throws(
    () => decodeInstructionData(idl, Buffer.from('010680ca15000000000000010b0500000000010000009201f74d00000000', 'hex'), { trailing: 'report' }),
    (error) => error instanceof CodecError && /^unsupported IDL dialect:/.test(error.message),
  );
  // And the reason names the mapping shape, not a shrug.
  assert.match(unsupportedIdlReason(idl), /types must be an array, got object/);
});

test('D2: every boundary states the SAME named reason', async () => {
  const { decodeInstructionData } = await import('../src/codec.mjs');
  const { withDerivedDiscriminators } = await import('../src/discriminators.mjs');
  const { adopt } = await import('../src/adopt.mjs');
  const idl = JSON.parse(tagDispatchIdl());
  const reason = unsupportedIdlReason(idl);
  assert.match(reason, /^unsupported IDL dialect: types must be an array, got object/);

  // codec context()
  const codecVoice = (() => {
    try { decodeInstructionData(idl, Buffer.from([1, 2, 3]), { trailing: 'report' }); return null; }
    catch (error) { return error.message; }
  })();
  assert.ok(codecVoice.includes(reason), 'codec voice must carry the shared reason');

  // derivation
  const derivationVoice = (() => {
    try { withDerivedDiscriminators(idl); return null; } catch (error) { return error.message; }
  })();
  assert.equal(derivationVoice, reason, 'the derivation must refuse with the identical text');

  // adopt (write path) — same reason, file-prefixed
  await withTempStore(async (store) => {
    const file = path.join(store, 'foreign.json');
    await writeFile(file, tagDispatchIdl());
    await assert.rejects(adopt(DIABLO, file, store), (error) => {
      assert.ok(error.message.includes(reason), `adopt voice must carry the shared reason: ${error.message}`);
      assert.equal(error.code, 'unsupported-idl-dialect');
      return true;
    });
  });
});

test('D3: the derivation fills NO Anchor sighash over a tag-dispatch interface', async () => {
  const { withDerivedDiscriminators } = await import('../src/discriminators.mjs');
  // Pre-fix (measured): filled {instructions: 4, events: 0} over the
  // diabloarb instructions — a table matching no wire byte.
  assert.throws(
    () => withDerivedDiscriminators(JSON.parse(tagDispatchIdl())),
    (error) => /^unsupported IDL dialect:/.test(error.message),
  );
});

test('D4: adopt refuses a declared program under ANY field name, naming the field', async () => {
  const { adopt } = await import('../src/adopt.mjs');
  const writeIdl = async (idl, name) => {
    const store = await mkdtemp(path.join(tmpdir(), 'sememe-declare-'));
    await mkdir(path.join(store, 'objects'), { recursive: true });
    await mkdir(path.join(store, 'receipts'), { recursive: true });
    const file = path.join(store, name);
    await writeFile(file, JSON.stringify(idl));
    return { store, file };
  };
  // The measured face: program_id only — old check read `idl.address`.
  {
    const { store, file } = await writeIdl(JSON.parse(tagDispatchIdl()), 'program-id-only.json');
    try {
      await assert.rejects(
        adopt(WSOL_MINT, file, store),
        /declares program DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z via program_id, not So11111111111111111111111111111111111111112/,
      );
    } finally { await rm(store, { recursive: true, force: true }); }
  }
  // metadata.address (shank spelling) must be read too.
  {
    const idl = { name: 'x', metadata: { address: WSOL_MINT }, instructions: [{ name: 'go', discriminator: [1], args: [] }] };
    const { store, file } = await writeIdl(idl, 'metadata-address.json');
    try {
      await assert.rejects(adopt(DIABLO, file, store),
        /declares program So11111111111111111111111111111111111111112 via metadata.address/);
    } finally { await rm(store, { recursive: true, force: true }); }
  }
  // `address` keeps its exact legacy wording (pinned by union.test.mjs and
  // lighthouse-acquisition.test.mjs).
  {
    const idl = { address: WSOL_MINT, instructions: [{ name: 'go', discriminator: [1], args: [] }] };
    const { store, file } = await writeIdl(idl, 'address.json');
    try {
      await assert.rejects(adopt(DIABLO, file, store),
        /declares program So11111111111111111111111111111111111111112, not DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z — refusing to re-label a foreign interface/);
    } finally { await rm(store, { recursive: true, force: true }); }
  }
});

test('D5: store-read refuses a program_id mismatch against the receipt, before any decode', async () => {
  // A store object that disagrees with its receipt's program must never
  // answer for that program — under ANY declaration field. Hand-built
  // (content-addressed) so the check is isolated from adopt.
  const { canonicalJson } = await import('../src/canonical.mjs');
  const store = await mkdtemp(path.join(tmpdir(), 'sememe-store-declare-'));
  try {
    await mkdir(path.join(store, 'objects'), { recursive: true });
    await mkdir(path.join(store, 'receipts'), { recursive: true });
    const idl = { name: 'x', program_id: DIABLO, instructions: [{ name: 'go', discriminator: [1], args: [] }] };
    const json = Buffer.from(canonicalJson(idl) + '\n');
    const fingerprint = createHash('sha256').update(json).digest('hex');
    await writeFile(path.join(store, 'objects', `${fingerprint}.json`), json);
    // The receipt binds WSOL; the object declares DiabLokxis.
    await writeFile(path.join(store, 'receipts', `${WSOL_MINT}-0-published-${fingerprint}.json`),
      JSON.stringify({
        program: WSOL_MINT, source: 'published', origin: 'unit-test', slot: 0,
        fingerprint: `sha256:${fingerprint}`, instructionCount: 1,
      }));
    const { findStoredIdl } = await import('../src/store-read.mjs');
    await assert.rejects(
      findStoredIdl(store, WSOL_MINT),
      /declares program DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z, not the receipt's So11111111111111111111111111111111111111112/,
    );
  } finally {
    await rm(store, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }
});

test('G1: the gate is surgical — anchor, legacy name-only anchor and shank all pass', async () => {
  for (const file of ['whirlpool-idl.json', 'kamino-lend-idl.json', 'jupiter-amm-v6-idl.json']) {
    const idl = JSON.parse(await readFile(path.join(ROOT, 'test', 'fixtures', file), 'utf8'));
    assert.equal(unsupportedIdlReason(idl), null, `${file} must pass the gate`);
  }
  // shank shape: discriminant selectors pass (the lighthouse fixture dir).
  const shank = { instructions: [{ name: 'assertAccountInfoMulti', discriminant: { type: 'u8', value: 6 }, args: [] }] };
  assert.equal(unsupportedIdlReason(shank), null);
  assert.equal(idlDialect(shank), 'shank');
  assert.equal(idlDialect(JSON.parse(await readFile(path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json'), 'utf8'))), 'anchor');
});

test('G1b: every committed store object still passes the gate and stays readable', async () => {
  const objectsDir = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11', 'objects');
  const names = await readdir(objectsDir);
  assert.ok(names.length >= 22, `the committed store must carry its 22 objects (found ${names.length})`);
  for (const name of names) {
    const idl = JSON.parse(await readFile(path.join(objectsDir, name), 'utf8'));
    assert.equal(unsupportedIdlReason(idl), null, `${name} must stay readable`);
  }
  const { findStoredIdls } = await import('../src/store-read.mjs');
  // Whirlpool is in the committed store; the read must still return sources.
  const { primary } = await findStoredIdls(path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11'),
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
  assert.ok(primary?.idl?.instructions?.length > 0, 'the whirlpool store object must still decode-read');
});

test('G2: instruction entries without args but without tag/data stay supported', () => {
  // The legacyAccount shape measure.test.mjs pins and the dedicated-parser
  // binding face rely on: { name } alone is a NAME-ONLY anchor entry, not a
  // tag-dispatch dialect.
  const nameOnly = { name: 'swap' };
  assert.equal(isTagDispatchInstruction(nameOnly), false);
  assert.equal(unsupportedIdlReason({ instructions: [nameOnly] }), null);
  assert.equal(idlDialect({ instructions: [nameOnly] }), 'name-only');
  assert.equal(declaredProgram({ program_id: DIABLO }), DIABLO);
  assert.equal(declaredProgram({ metadata: { address: 'X' }, address: 'Y' }), 'Y', 'address wins over metadata');
  assert.equal(declaredProgram({}), null);
});
