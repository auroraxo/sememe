// Union arbitration for ACCOUNT bytes — the half of union decode that
// instructions and events had since v0.4.0 and accounts never got.
//
// WHY THIS FILE EXISTS (measured 2026-11-08, research/account-union-2026-11-08.json):
//
// The pump.fun program publishes TWO interface copies that disagree about its
// ACCOUNT layout, while the instruction layouts are the union's own subject
// matter since v0.4.0:
//
//   on-chain copy (47 instructions)   BondingCurve = 13 fields
//   published copy (56 instructions)   BondingCurve = 19 fields
//
// Against 12 REAL mainnet accounts owned by that program (harvested with the
// repo's own recipe, tools/account-harvest.mjs):
//
//   the single-source account path (`sememe account`) left bytes UNEXPLAINED on
//   12 of 12 accounts and was byte-exact on 0 of 12 — because it read ONE
//   receipt (the on-chain copy), which describes an OLDER account layout;
//   the union path answered BYTE-EXACT on 6 of 12 (the BondingCurve and Global
//   accounts), and reported the drift on exactly those.
//
// The interesting half is therefore not "the union decodes more" but "the
// union says WHICH source answered, WHY, and what the other one said" — a
// decoder that always answers is useless. Every test below asserts a VERDICT.
//
// The rules pinned here (each one a refusal the naive implementation would
// get wrong):
//
//   A1  both sources refuse            -> refusal naming BOTH reasons
//   A2  one refuses, the other decodes -> the fallback needs byte evidence
//   A3  two different names for the same discriminator -> HARD refusal
//   A4  both decode, same name, same args -> 'agree'
//   A5  both decode, same name, different args -> 'layout_drift', winner by
//       byte evidence (full round trip beats a described prefix)
//   A6  evidence does not decide -> the PRIMARY stands and the drift is
//       reported, never resolved by preference
//   A7  a single-source store answers 'single_source' and says so
//   A8  the CLI exits 0 on the union path over a two-source store
//   A9  the CLI refuses a typo'd flag BEFORE it touches the store
//  A10  an unknown flag on the account command is refused by name (the
//       declared surface grew: --union)
//
// The MUTATIONS at the end are the falsification: each breaks exactly ONE
// rule and must turn the suite red. A union decoder that always answers, or
// that picks a winner by preference, is caught here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/canonical.mjs';
import { adopt } from '../src/adopt.mjs';
import { decodeStoredAccount, decodeUnionStoredAccount, findStoredIdls } from '../src/decode.mjs';
import { unionAccountDecode } from '../src/account-union.mjs';
import { UnionRefusal } from '../src/union.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROOT_MUTANT_DIR = path.join(ROOT, 'src');

const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CLI = path.join(ROOT, 'bin', 'sememe.mjs');

const load = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const pumpIdl = await load('pump-idl.json');
const pumpPublished = await load('pump-published-idl.json');
const pumpAccounts = await load('accounts-pump-2026-11-08.json');

/** A store with the on-chain copy as a pull and the published copy adopted. */
async function store({ published = true, onChain = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-account-union-test-'));
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'receipts'), { recursive: true });
  if (onChain) {
    const bytes = Buffer.from(canonicalJson(pumpIdl) + '\n');
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(dir, 'objects', `${fingerprint}.json`), bytes);
    await writeFile(
      path.join(dir, 'receipts', `${PROGRAM}-466833000-metadata-${fingerprint}.json`),
      Buffer.from(canonicalJson({
        program: PROGRAM, source: 'metadata', slot: 466833000,
        fingerprint: `sha256:${fingerprint}`, instructionCount: pumpIdl.instructions.length,
      }) + '\n'),
    );
  }
  if (published) {
    const file = path.join(dir, 'published.json');
    await writeFile(file, JSON.stringify(pumpPublished));
    await adopt(PROGRAM, file, dir, { source: 'published', origin: 'pump-published-idl.json' });
  }
  return dir;
}

const bondingCurve = pumpAccounts.accounts.find((a) => {
  const head = Buffer.from(a.dataBase64, 'base64').subarray(0, 8).toString('hex');
  return head === '17b7f83760d8ac60';
});
assert.ok(bondingCurve, 'the fixture must contain a BondingCurve account');

test('the two sources disagree about the account layout, and the measurement says so', () => {
  const onchain = pumpIdl.accounts.find((a) => a.name === 'BondingCurve');
  const published = pumpPublished.accounts.find((a) => a.name === 'BondingCurve');
  const onchainFields = pumpIdl.types.find((t) => t.name === 'BondingCurve').type.fields.length;
  const publishedFields = pumpPublished.types.find((t) => t.name === 'BondingCurve').type.fields.length;
  assert.equal(onchainFields, 13, 'the on-chain copy describes 13 fields');
  assert.equal(publishedFields, 19, 'the published copy describes 19 fields');
  assert.ok(onchain && published, 'both copies must name the account');
});

test('the single-source path leaves bytes unexplained; the union path answers byte-exactly', async () => {
  const dir = await store();
  try {
    const plain = await decodeStoredAccount(dir, PROGRAM, bondingCurve.dataBase64);
    assert.equal(plain.account, 'BondingCurve');
    assert.equal(plain.roundTripByteExact, false, 'the on-chain copy alone cannot reproduce the account');
    assert.ok(plain.trailing.count > 0, 'and it leaves bytes unexplained');

    const union = await decodeUnionStoredAccount(dir, PROGRAM, bondingCurve.dataBase64);
    assert.equal(union.account, 'BondingCurve');
    assert.equal(union.roundTripByteExact, true, 'the published copy reproduces every byte');
    assert.equal(union.trailing.count, 0);
    assert.equal(union.view.verdict, 'layout_drift');
    assert.equal(union.view.arbitration.basis, 'byte_evidence_full_roundtrip');
    assert.equal(union.view.arbitration.evidence, 'full_roundtrip');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the union names the source that answered AND the verdict of the other one', async () => {
  const dir = await store();
  try {
    const union = await decodeUnionStoredAccount(dir, PROGRAM, bondingCurve.dataBase64);
    assert.equal(union.view.primary.decoded, true);
    assert.equal(union.view.primary.evidence, 'described_roundtrip');
    assert.equal(union.view.primary.trailingBytes, 41);
    assert.equal(union.view.secondary.decoded, true);
    assert.equal(union.view.secondary.evidence, 'full_roundtrip');
    assert.equal(union.view.secondary.trailingBytes, 0);
    assert.equal(union.view.sourcesAgree, false);
    // The drift is REPORTED, field by field.
    assert.ok(union.view.drift.paths.includes('creator_fee'));
    assert.ok(union.view.drift.paths.includes('protocol_fees'));
    // The winning side's provenance is quoted: an adopted copy, declared origin.
    assert.equal(union.idl.source, 'published');
    assert.equal(union.idl.originStatus, 'declared');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the union reads BOTH copies of the store, in the same order the instruction union does', async () => {
  const dir = await store();
  try {
    const { primary, secondary } = await findStoredIdls(dir, PROGRAM);
    assert.equal(primary.idlMeta.slot, 466833000, 'the on-chain pull is the primary');
    assert.equal(secondary.idlMeta.slot, null, 'the adopted copy is the secondary');
    const union = await decodeUnionStoredAccount(dir, PROGRAM, bondingCurve.dataBase64);
    assert.equal(union.view.primary.fingerprint, primary.idlMeta.fingerprint);
    assert.equal(union.view.secondary.fingerprint, secondary.idlMeta.fingerprint);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('A1: both sources refuse -> the refusal names BOTH reasons', async () => {
  const dir = await store();
  try {
    // Bytes that are not an account of this program at all.
    await assert.rejects(
      () => decodeUnionStoredAccount(dir, PROGRAM, Buffer.alloc(64, 7).toString('base64')),
      (error) => {
        assert.ok(error instanceof UnionRefusal, 'must be a union refusal');
        assert.equal(error.view.verdict ?? null, null);
        assert.match(error.message, /both stored sources refuse/);
        assert.ok(error.view.primary.refusedReason, 'the primary reason must be visible');
        assert.ok(error.view.secondary.refusedReason, 'the secondary reason must be visible');
        return true;
      },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('A2: a fallback without byte evidence is refused', async () => {
  // A source that NAMES an account but cannot reproduce its own bytes must not
  // be admitted as the fallback answer — a name without evidence is a guess.
  //
  // Construction (a real codec property, not a mock): an `f32` field holding a
  // SIGNALING NaN. The decoder reports null for any NaN, and re-encoding null
  // writes a quiet NaN — so the decode succeeds, consumes the whole account,
  // and reproduces NEITHER the account nor its described prefix. That is the
  // honest "names bytes it cannot reproduce" state, unlike a source that simply
  // refuses (which is covered by A1).
  const disc = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
  const accountBytes = Buffer.from([...disc, ...Buffer.from('0100807f', 'hex')]);
  const survivorIdl = {
    instructions: [],
    accounts: [{ name: 'Odd', discriminator: disc }],
    types: [{ name: 'Odd', type: { kind: 'struct', fields: [{ name: 'v', type: 'f32' }] } }],
  };
  // The primary cannot identify these bytes at all: a different account list.
  const refusingIdl = {
    instructions: [],
    accounts: [{ name: 'Other', discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }],
    types: [],
  };

  // Control: the survivor really does DECODE the whole account (it is not a
  // refusal), which is why the fallback question arises at all — and yet it
  // carries no byte evidence. The union path admits it only as a SINGLE
  // source; with a second source present, a no-evidence answer is refused.
  const probe = unionAccountDecode({
    program: PROGRAM,
    primary: {
      label: 'primary', idl: survivorIdl,
      idlMeta: { fingerprint: 'sha256:primary', slot: 1, source: 'metadata' },
      objectPath: '/tmp/primary.json',
    },
    bytes: accountBytes,
  });
  assert.equal(probe.view.primary.decoded, true, 'the survivor must decode, not refuse');
  assert.equal(probe.consumed, probe.bytes, 'and it must claim the whole account');
  assert.equal(probe.roundTripByteExact, false);
  assert.equal(probe.describedRoundTripByteExact, false);
  assert.equal(probe.view.primary.evidence, 'none',
    'a source that cannot reproduce the bytes has NO evidence');

  // The rule: such a source is not admitted as the FALLBACK when the other one
  // refuses. (unionAccountDecode is synchronous, so this is a THROW, not a
  // rejected promise.)
  assert.throws(
    () => unionAccountDecode({
      program: PROGRAM,
      primary: {
        label: 'primary', idl: refusingIdl,
        idlMeta: { fingerprint: 'sha256:primary', slot: 1, source: 'metadata' },
        objectPath: '/tmp/primary.json',
      },
      secondary: {
        label: 'secondary', idl: survivorIdl,
        idlMeta: { fingerprint: 'sha256:secondary', slot: null, source: 'published' },
        objectPath: '/tmp/secondary.json',
      },
      bytes: accountBytes,
    }),
    (error) => {
      assert.ok(error instanceof UnionRefusal);
      assert.equal(error.details.view.secondary.evidence, 'none');
      assert.match(error.message, /cannot re-encode these bytes/);
      return true;
    },
  );
});

test('A3: two different names for the same discriminator is a HARD refusal', async () => {
  const renamed = structuredClone(pumpPublished);
  // The published copy calls the account "Curve" — a different schema for the
  // same 8 bytes.
  const account = renamed.accounts.find((a) => a.name === 'BondingCurve');
  account.name = 'Curve';
  const type = renamed.types.find((t) => t.name === 'BondingCurve');
  type.name = 'Curve';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-account-union-renamed-'));
  try {
    const bytes = Buffer.from(canonicalJson(pumpIdl) + '\n');
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    await mkdir(path.join(dir, 'objects'), { recursive: true });
    await mkdir(path.join(dir, 'receipts'), { recursive: true });
    await writeFile(path.join(dir, 'objects', `${fingerprint}.json`), bytes);
    await writeFile(path.join(dir, 'receipts', `${PROGRAM}-466833000-metadata-${fingerprint}.json`),
      Buffer.from(canonicalJson({
        program: PROGRAM, source: 'metadata', slot: 466833000,
        fingerprint: `sha256:${fingerprint}`, instructionCount: pumpIdl.instructions.length,
      }) + '\n'));
    const file = path.join(dir, 'published.json');
    await writeFile(file, JSON.stringify(renamed));
    await adopt(PROGRAM, file, dir, { source: 'published', origin: 'renamed.json' });

    await assert.rejects(
      () => decodeUnionStoredAccount(dir, PROGRAM, bondingCurve.dataBase64),
      (error) => {
        assert.ok(error instanceof UnionRefusal);
        assert.equal(error.details.view.primary.name, 'BondingCurve');
        assert.equal(error.details.view.secondary.name, 'Curve');
        assert.match(error.message, /interface conflict/);
        return true;
      },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('A4: two sources that decode the same account to the same values AGREE', async () => {
  const dir = await store();
  try {
    const userVolume = pumpAccounts.accounts.find((a) => {
      const head = Buffer.from(a.dataBase64, 'base64').subarray(0, 8).toString('hex');
      return head === '56ff700e66359afa';
    });
    assert.ok(userVolume, 'the fixture must contain a UserVolumeAccumulator account');
    const union = await decodeUnionStoredAccount(dir, PROGRAM, userVolume.dataBase64);
    assert.equal(union.view.verdict, 'agree');
    assert.equal(union.view.sourcesAgree, true);
    // Both copies describe this account the same way, and BOTH leave the same
    // bytes unexplained — the agreement is reported, not papered over.
    assert.equal(union.view.primary.trailingBytes, union.view.secondary.trailingBytes);
    assert.equal(union.roundTripByteExact, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('A5/A6: when the evidence does not decide, the PRIMARY stands and the drift is reported', async () => {
  // A genuine tie: two copies whose layouts SERIALIZE TO THE SAME BYTES but
  // decode them to different values (u32 vs i32 on the same four bytes —
  // 0xffffffff is 4294967295 unsigned and -1 signed). Both re-encode to every
  // byte of the account, so neither has stronger evidence, and picking the
  // winner would be a preference dressed up as a measurement.
  const disc = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44];
  const bytes = Buffer.from([...disc, 0xff, 0xff, 0xff, 0xff]);
  const idlWith = (scalar) => ({
    instructions: [],
    accounts: [{ name: 'Amount', discriminator: disc }],
    types: [{ name: 'Amount', type: { kind: 'struct', fields: [{ name: 'value', type: scalar }] } }],
  });
  const primary = {
    label: 'primary', idl: idlWith('u32'),
    idlMeta: { fingerprint: 'sha256:primary', slot: 1, source: 'metadata' },
    objectPath: '/tmp/primary.json',
  };
  const secondary = {
    label: 'secondary', idl: idlWith('i32'),
    idlMeta: { fingerprint: 'sha256:secondary', slot: null, source: 'published' },
    objectPath: '/tmp/secondary.json',
  };
  const result = unionAccountDecode({ program: PROGRAM, primary, secondary, bytes });
  assert.equal(result.view.verdict, 'layout_drift');
  assert.equal(result.view.primary.evidence, 'full_roundtrip', 'both explain every byte');
  assert.equal(result.view.secondary.evidence, 'full_roundtrip');
  assert.equal(result.view.arbitration.basis, 'primary_by_default_evidence_tied');
  assert.equal(result.view.arbitration.winner, 'primary');
  assert.equal(result.args.value, 4294967295, 'the primary stands');
  assert.ok(result.view.drift.paths.includes('value'), 'the drift is reported, not hidden');
});

test('A7: a store with ONE source answers "single_source" and says so', async () => {
  const dir = await store({ published: false });
  try {
    const union = await decodeUnionStoredAccount(dir, PROGRAM, bondingCurve.dataBase64);
    assert.equal(union.view.verdict, 'single_source');
    assert.equal(union.view.adoptedOnly, false);
    assert.equal(union.view.secondary.present, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('A8/A9/A10: the CLI refuses a typo before it touches the store, and exits 0 on the union path', async () => {
  const dir = await store();
  try {
    const typo = spawnSync(process.execPath, [
      CLI, 'account', '--uni', PROGRAM, bondingCurve.dataBase64, '--store', dir,
    ], { encoding: 'utf8' });
    assert.equal(typo.status, 2, "a typo'd flag must be a usage refusal");
    assert.match(typo.stderr, /unknown flag "--uni"/);
    assert.match(typo.stderr, /--union/, 'the refusal names the supported flag');

    const union = spawnSync(process.execPath, [
      CLI, 'account', '--union', PROGRAM, bondingCurve.dataBase64, '--store', dir,
    ], { encoding: 'utf8' });
    assert.equal(union.status, 0, `the union path must succeed: ${union.stderr}`);
    const parsed = JSON.parse(union.stdout);
    assert.equal(parsed.roundTripByteExact, true);
    assert.equal(parsed.view.verdict, 'layout_drift');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the plain path is untouched: it still reads ONE receipt and says nothing about a union', async () => {
  const dir = await store();
  try {
    const plain = await decodeStoredAccount(dir, PROGRAM, bondingCurve.dataBase64);
    assert.equal(plain.view, undefined, 'the plain path has no union view');
    assert.equal(plain.roundTripByteExact, false);
    assert.equal(plain.idl.source, 'metadata', 'it answers with the on-chain pull');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The mutations: each breaks exactly ONE rule above and must turn it red.
// A decoder that always answers, or that picks a winner by preference, is
// caught here — a suite that only measures the happy path proves nothing.
// ---------------------------------------------------------------------------

async function withAccountUnionMutant(label, mutate) {
  const file = path.join(ROOT_MUTANT_DIR, 'account-union.mjs');
  const source = await readFile(file, 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${label}: the mutation must actually change the source`);
  const mutantPath = path.join(ROOT_MUTANT_DIR, `.account-union-mutant-${label.replace(/[^a-z0-9]+/gi, '-')}.mjs`);
  await writeFile(mutantPath, mutated);
  try {
    return await import(mutantPath);
  } finally {
    await rm(mutantPath, { force: true });
  }
}

test('M1: always answer with the primary (ignore byte evidence) -> the recovered accounts go red', async () => {
  const mutant = await withAccountUnionMutant('always-primary', (source) => source.replace(
    "if (secProbe.fullExact && !primProbe.fullExact) {",
    "if (false) {",
  ));
  const dir = await store();
  try {
    const result = await mutant.unionAccountDecode({
      program: PROGRAM,
      primary: {
        label: 'primary', idl: pumpIdl,
        idlMeta: { fingerprint: 'sha256:primary', slot: 1, source: 'metadata' },
        objectPath: '/tmp/primary.json',
      },
      secondary: {
        label: 'secondary', idl: pumpPublished,
        idlMeta: { fingerprint: 'sha256:secondary', slot: null, source: 'published' },
        objectPath: '/tmp/secondary.json',
      },
      bytes: Buffer.from(bondingCurve.dataBase64, 'base64'),
    });
    assert.equal(result.roundTripByteExact, false,
      'the mutant must lose the byte-exact answer it used to win');
    assert.equal(result.view.arbitration.basis, 'primary_by_default');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M2: refuse every name conflict instead of reporting it -> the hard refusal goes red', async () => {
  const mutant = await withAccountUnionMutant('name-conflict', (source) => source.replace(
    "if (primProbe.decoded.name !== secProbe.decoded.name) {",
    "if (false) {",
  ));
  const renamed = structuredClone(pumpPublished);
  renamed.accounts.find((a) => a.name === 'BondingCurve').name = 'Curve';
  renamed.types.find((t) => t.name === 'BondingCurve').name = 'Curve';
  const dir = await store();
  try {
    // The mutant must NOT refuse here: it must decode and pick a winner.
    const result = await mutant.unionAccountDecode({
      program: PROGRAM,
      primary: {
        label: 'primary', idl: pumpIdl,
        idlMeta: { fingerprint: 'sha256:primary', slot: 1, source: 'metadata' },
        objectPath: '/tmp/primary.json',
      },
      secondary: {
        label: 'secondary', idl: renamed,
        idlMeta: { fingerprint: 'sha256:secondary', slot: null, source: 'published' },
        objectPath: '/tmp/secondary.json',
      },
      bytes: Buffer.from(bondingCurve.dataBase64, 'base64'),
    });
    assert.ok(result.view.verdict, 'the mutant must answer instead of refusing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
