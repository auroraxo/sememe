// ONE ordering, or one store answers with two answers again.
//
// WHAT WAS MEASURED (2026-11-07, this host, pre-fix tree 00ae18c and the
// PUBLISHED v0.4.9 install, which carries the same code):
//
//   store = two ON-CHAIN receipts of the same program, slots of different
//   digit length (the filename embeds the slot as a decimal STRING):
//     <prog>-99999999-on-chain-<hash>    (numerically OLDER)
//     <prog>-123456789-on-chain-<hash>   (numerically NEWER)
//
//   sememe decode        -> reads slot 99999999  (string-newest: "9..." > "1...")
//   sememe decode --union -> primary slot 123456789 (sorted NUMERICALLY by slot)
//   sememe lock          -> pins slot 99999999
//
//   Three surfaces, two different receipts. The union path has ordered
//   on-chain receipts by NUMERIC slot since it was written
//   (`onChain.sort((a, b) => a.slot - b.slot)`), while the plain reader
//   (findStoredIdl), receiptNames() and src/lock.mjs sort by receipt
//   FILENAME — and a decimal string sorts by its DIGITS, not by its value.
//
// WHY IT IS THE SAME DEFECT CLASS as 08eff55 ("one store must answer with ONE
// answer"): that fix removed ONE of the two orderings (label vs filename) and
// the README/commit claim it as "the rule is now ONE ordering everywhere
// (receipt filename)". The claim is false: filename order is NOT slot order
// whenever two slot strings have different digit lengths, and the union path
// never used filename order for on-chain receipts at all. Two sorts, two
// winners — exactly the shape the previous fix named, one dimension over.
//
// REACHABILITY, stated honestly rather than sold: every live slot measured on
// this host is 9 digits (44,661 slot values in research/ + fixtures, min
// 462039125, max 465713413), so two receipts of one program picked by `pull`
// today have equal-length slots and both orderings agree. The divergence needs
// a store holding receipts whose SLOT STRINGS differ in length: a receipt
// carried over from another era or cluster, a manually assembled store, or the
// mainnet slot crossing 1,000,000,000 (10 digits). It is latent for a fresh
// pull and LIVE for any such store — and the contract the README states
// ("newest stored IDL", "the newest receipt") must hold in that store too.
//
// WHAT THIS FILE PINS:
//
//   O1  the plain reader picks the NUMERIC-newest receipt. RED pre-fix.
//   O2  `sememe lock` pins the NUMERIC-newest receipt. RED pre-fix.
//   O3  plain, union and lock name the SAME fingerprint — one store, one
//       answer. RED pre-fix (union already said 123456789).
//   O4  CONTROL (false-positive guard): equal-length slots — all three
//       surfaces agree. This is the case expected GREEN on the pre-fix tree,
//       because it is what a fresh `pull` produces today.
//   O5  an adopted copy (filename slot 0) still never beats a real on-chain
//       receipt, and the union primary stays the on-chain one. GREEN pre-fix:
//       the guard for the selection rule 08eff55 protected.
//   O6  second program: whirlpool with TWO adopted copies and no pull — plain,
//       union and lock agree, and a damaged second copy refuses the lock.
//       GREEN pre-fix; pins the card's open item "adopted copies for MORE than
//       one program" against a program other than pump.fun.
//
// MUTATIONS (at the end of this file) must each turn a test red:
//   X1  sort receipts by plain filename again in store-read.mjs -> O1 + O3 red
//   X2  sort receipts by plain filename again in src/lock.mjs    -> O2 red

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WHIRL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const { canonicalJson } = await import('../src/canonical.mjs');
const { findStoredIdl, findStoredIdls } = await import('../src/store-read.mjs');
const { decodeUnionPayload } = await import('../src/decode.mjs');
const { writeLock, checkLock } = await import('../src/lock.mjs');
const { adopt } = await import('../src/adopt.mjs');

const PUBLISHED = path.join(HERE, 'fixtures', 'pump-published-idl.json'); // a35349f3…
const ONCHAIN = path.join(HERE, 'fixtures', 'pump-idl.json'); // 5a00cdb8…
const WHIRL_FIXTURE = path.join(HERE, 'fixtures', 'whirlpool-idl.json');
const SELL_V3_BASE58 = '3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** A store holding hand-written ON-CHAIN receipts. `installIdl` refuses to
 * overwrite and `pull` only ever returns the CURRENT slot, so a store whose
 * slot strings differ in length is assembled here the way a user's store would
 * hold it: receipt filenames exactly as `pull` writes them
 * (`<program>-<slot>-<source>-<fingerprint>.json`), objects canonical+hashed.
 */
async function storeWithSlots(dir, program, entries) {
  await mkdir(path.join(dir, 'receipts'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, 'objects'), { recursive: true, mode: 0o700 });
  const written = [];
  for (const { file, slot, source } of entries) {
    const idl = JSON.parse(await readFile(file, 'utf8'));
    const json = Buffer.from(canonicalJson(idl) + '\n');
    const fingerprint = sha256(json);
    await writeFile(path.join(dir, 'objects', `${fingerprint}.json`), json);
    const receipt = {
      program, source, slot,
      fingerprint: `sha256:${fingerprint}`,
      instructionCount: idl.instructions.length,
    };
    const name = `${program}-${slot}-${source}-${fingerprint}.json`;
    await writeFile(path.join(dir, 'receipts', name), Buffer.from(canonicalJson(receipt) + '\n'));
    written.push({ slot, fingerprint: `sha256:${fingerprint}`, name });
  }
  return written;
}

/** 8-digit slot (pre-1e8 era) vs 9-digit slot: numerically 123456789 is the
 * NEWER receipt, but as strings "99999999…" > "123456789…". The trap is built
 * into the slot values, not into the test's expectations. */
const OLD_DIGITS = 99999999;
const NEW_DIGITS = 123456789;

async function mixedDigitStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-slotorder-'));
  // The NUMERICALLY-newest slot (123456789) carries the copy that knows
  // sell_v3, so the fixture also decodes the payload afterwards; the OLDER
  // slot (99999999) carries the copy that does not. Both are real fixture
  // files — the trap is in the SLOT VALUES, not in the test's expectations.
  const written = await storeWithSlots(dir, PUMP, [
    { file: ONCHAIN, slot: OLD_DIGITS, source: 'on-chain' },
    { file: PUBLISHED, slot: NEW_DIGITS, source: 'on-chain' },
  ]);
  return { dir, written };
}

/** The receipt whose SLOT is the greatest number — the rule the union path
 * already applies and the README already promises ("newest stored IDL"). */
const numericNewest = (written) => [...written].sort((a, b) => a.slot - b.slot).at(-1);

test('O1: the plain reader picks the NUMERIC-newest receipt, not the string-newest', async () => {
  const { dir, written } = await mixedDigitStore();
  try {
    const newest = numericNewest(written);
    const plain = await findStoredIdl(dir, PUMP);
    assert.equal(plain.receipt.slot, newest.slot,
      'the plain reader must pick the receipt whose SLOT is the greatest number — '
      + 'filename order is digit order, and digit order is not slot order');
    assert.equal(plain.receipt.fingerprint, newest.fingerprint);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('O2: `lock` pins the NUMERIC-newest receipt', async () => {
  const { dir, written } = await mixedDigitStore();
  try {
    const newest = numericNewest(written);
    const doc = await writeLock(dir, path.join(dir, 'sememe.lock'));
    assert.equal(doc.programs[PUMP].slot, newest.slot,
      'the lock must pin the newest SLOT, not the string that sorts last');
    assert.equal(doc.programs[PUMP].fingerprint, newest.fingerprint);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('O3: plain, union and lock name the SAME fingerprint (one store, one answer)', async () => {
  const { dir, written } = await mixedDigitStore();
  try {
    const newest = numericNewest(written);
    const plain = await findStoredIdl(dir, PUMP);
    const sources = await findStoredIdls(dir, PUMP);
    const doc = await writeLock(dir, path.join(dir, 'sememe.lock'));

    assert.equal(sources.primary.idlMeta.slot, newest.slot,
      'the union path must keep answering with the newest slot');
    assert.equal(plain.receipt.fingerprint, sources.primary.idlMeta.fingerprint,
      'the plain reader and the union path must read the SAME receipt — one store, one answer');
    assert.equal(doc.programs[PUMP].fingerprint, sources.primary.idlMeta.fingerprint,
      'the lock must pin the receipt the decoders read');

    const union = await decodeUnionPayload(dir, PUMP, SELL_V3_BASE58);
    assert.equal(union.idl.fingerprint, plain.receipt.fingerprint,
      'a payload decoded through the union path must come from the copy the plain path reads');

    const report = await checkLock(dir, path.join(dir, 'sememe.lock'), { mode: 'warn' });
    assert.equal(report.violations, 0, 'a store the three surfaces agree about must verify clean');
    assert.deepEqual(report.verified, [PUMP]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('O4 (CONTROL): equal-length slots — every surface agrees, pre-fix and post-fix', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-slotorder-ctl-'));
  try {
    const written = await storeWithSlots(dir, PUMP, [
      { file: PUBLISHED, slot: 462039125, source: 'on-chain' },
      { file: ONCHAIN, slot: 465713413, source: 'on-chain' },
    ]);
    const newest = numericNewest(written);
    assert.equal(newest.slot, 465713413, 'the fixture must be built so the numerically-newest also string-sorts last');

    const plain = await findStoredIdl(dir, PUMP);
    const sources = await findStoredIdls(dir, PUMP);
    const doc = await writeLock(dir, path.join(dir, 'sememe.lock'));
    assert.equal(plain.receipt.slot, 465713413);
    assert.equal(sources.primary.idlMeta.slot, 465713413);
    assert.equal(doc.programs[PUMP].slot, 465713413);
    assert.equal(plain.receipt.fingerprint, sources.primary.idlMeta.fingerprint);

    const report = await checkLock(dir, path.join(dir, 'sememe.lock'), { mode: 'warn' });
    assert.equal(report.violations, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('O5: an adopted copy still never beats a real on-chain receipt (selection guard)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-slotorder-ad-'));
  try {
    await storeWithSlots(dir, PUMP, [
      { file: ONCHAIN, slot: 465713413, source: 'on-chain' },
    ]);
    const adopted = await adopt(PUMP, PUBLISHED, dir, { source: 'published', origin: 'docs-copy' });
    assert.equal(adopted.slot, null, 'adopt writes slot null (filename segment 0) — the fixture is faithful');

    const plain = await findStoredIdl(dir, PUMP);
    assert.equal(plain.receipt.slot, 465713413,
      'the adopted copy (filename slot 0) must sort before every real slot — adoption never switches the default source');

    const sources = await findStoredIdls(dir, PUMP);
    assert.equal(sources.primary.idlMeta.slot, 465713413, 'the union primary stays the on-chain receipt');
    assert.equal(sources.primary.idlMeta.fingerprint, plain.receipt.fingerprint);

    const doc = await writeLock(dir, path.join(dir, 'sememe.lock'));
    assert.equal(doc.programs[PUMP].slot, 465713413, 'the lock must not pin the adopted copy while a pull exists');
    assert.equal(doc.programs[PUMP].fingerprint, plain.receipt.fingerprint);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('O6: SECOND program — whirlpool with two adopted copies agrees everywhere, damage refuses the lock', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-slotorder-p2-'));
  try {
    const first = await adopt(WHIRL, WHIRL_FIXTURE, dir, { source: 'published', origin: 'sdk-copy' });
    // A second, byte-distinct copy of the same program: adopting the same file
    // twice yields the same fingerprint and therefore the same receipt.
    const modified = JSON.parse(await readFile(WHIRL_FIXTURE, 'utf8'));
    modified.instructions[0].name = `${modified.instructions[0].name}_v2`;
    const secondFile = path.join(dir, 'whirlpool-v2.json');
    await writeFile(secondFile, JSON.stringify(modified));
    const second = await adopt(WHIRL, secondFile, dir, { source: 'published', origin: 'docs-copy' });
    assert.notEqual(first.fingerprint, second.fingerprint, 'the fixture must hold two distinct copies');

    const plain = await findStoredIdl(dir, WHIRL);
    const sources = await findStoredIdls(dir, WHIRL);
    assert.equal(sources.onChain.length, 0, 'no pull for this program — adopted copies are all the store holds');
    assert.equal(sources.adopted.length, 2, 'both copies must be visible');
    assert.equal(plain.receipt.fingerprint, sources.primary.idlMeta.fingerprint,
      'a second program must obey the same one-answer rule pump.fun was fixed for');

    const doc = await writeLock(dir, path.join(dir, 'sememe.lock'));
    assert.equal(doc.programs[WHIRL].fingerprint, plain.receipt.fingerprint,
      'the lock must pin the receipt the decoders read, for this program too');
    const report = await checkLock(dir, path.join(dir, 'sememe.lock'), { mode: 'warn' });
    assert.equal(report.violations, 0);

    // Damage the copy the lock does NOT pin: the README promises no lock over
    // damage for every receipt, not only the pinned one.
    const damagedFp = [first, second].map((r) => r.fingerprint.replace(/^sha256:/, ''))
      .find((hex) => `sha256:${hex}` !== doc.programs[WHIRL].fingerprint);
    const objectPath = path.join(dir, 'objects', `${damagedFp}.json`);
    const tampered = JSON.parse(await readFile(objectPath, 'utf8'));
    tampered.instructions[0].name = `${tampered.instructions[0].name}_tampered`;
    await writeFile(objectPath, `${canonicalJson(tampered)}\n`);

    await assert.rejects(() => writeLock(dir, path.join(dir, 'damaged.lock')),
      /re-hashes to sha256:[a-f0-9]{64}/,
      'a damaged SECOND copy of the second program must refuse the lock too');
    const after = await checkLock(dir, path.join(dir, 'sememe.lock'), { mode: 'warn' });
    assert.equal(after.unverified.length, 1, 'verify must NAME the damaged receipt');
    assert.equal(after.unverified[0].program, WHIRL);
    assert.ok(after.violations >= 1, 'damage is a violation, not a note');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('O7: the shared receipt comparator orders by numeric slot, filename only as the tiebreak', async () => {
  const { compareReceiptNames } = await import('../src/receipt-order.mjs');
  const older = `${PUMP}-99999999-on-chain-aaaa.json`;
  const newer = `${PUMP}-123456789-on-chain-bbbb.json`;
  assert.ok(compareReceiptNames(older, newer) < 0,
    'numerically older must sort first even when its string sorts last');
  assert.ok(compareReceiptNames(newer, older) > 0, 'the comparison must be antisymmetric');

  const adopted = `${PUMP}-0-published-cccc.json`;
  assert.ok(compareReceiptNames(adopted, newer) < 0,
    'the adopted copy (slot 0) must sort before every real slot');

  const sameSlotA = `${PUMP}-465713413-anchor-aaaa.json`;
  const sameSlotB = `${PUMP}-465713413-metadata-bbbb.json`;
  assert.ok(compareReceiptNames(sameSlotA, sameSlotB) < 0,
    'a tie falls back to the filename, so the order stays deterministic');

  assert.equal(compareReceiptNames(older, older), 0, 'equal names are equal');
});

// ---------------------------------------------------------------------------
// MUTATIONS — each must turn a test above red.
//
// The mutant is written INTO src/ under a dot-prefixed name (so its relative
// imports resolve against the real tree) and deleted afterwards; the real
// modules are never modified. Pattern matches test/multi-copy-store.test.mjs.
//
//   X1  sort receipts by plain filename in src/store-read.mjs (the pre-fix
//       rule): digit order wins -> O1 + O3 red.
//   X2  sort receipts by plain filename in src/lock.mjs (the pre-fix rule):
//       the lock pins the string-newest -> O2 red.
// ---------------------------------------------------------------------------

async function withMutant(file, name, mutate) {
  const source = await readFile(path.join(ROOT, 'src', file), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${name}: the mutation must actually change the source`);
  const mutantPath = path.join(ROOT, 'src', `.${name}-mutant.mjs`);
  try {
    await writeFile(mutantPath, mutated);
    return await import(mutantPath);
  } finally {
    await rm(mutantPath, { force: true });
  }
}

test('MUTATION X1 (plain filename order in store-read) turns O1 and O3 red', async () => {
  const mutant = await withMutant('store-read.mjs', 'x1-filename-order', (source) => source.replace(
    '  candidates.sort(compareReceiptNames);',
    '  candidates.sort();',
  ));
  const { dir, written } = await mixedDigitStore();
  try {
    const newest = numericNewest(written);
    const plain = await mutant.findStoredIdl(dir, PUMP);
    assert.notEqual(plain.receipt.slot, newest.slot,
      'the mutant must pick the string-newest (older) receipt — otherwise O1 pins nothing');

    const sources = await mutant.findStoredIdls(dir, PUMP);
    assert.notEqual(plain.receipt.fingerprint, sources.primary.idlMeta.fingerprint,
      'the mutant must make plain and union read DIFFERENT receipts — otherwise O3 pins nothing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MUTATION X2 (plain filename order in lock) turns O2 red', async () => {
  const mutant = await withMutant('lock.mjs', 'x2-filename-order', (source) => source.replace(
    '  names.sort(compareReceiptNames);',
    '  names.sort();',
  ));
  const { dir, written } = await mixedDigitStore();
  try {
    const newest = numericNewest(written);
    const doc = await mutant.writeLock(dir, path.join(dir, 'sememe.lock'));
    assert.notEqual(doc.programs[PUMP].slot, newest.slot,
      'the mutant must pin the string-newest (older) slot — otherwise O2 pins nothing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
