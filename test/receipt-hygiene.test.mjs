// THE RECEIPT-DIRECTORY HYGIENE LADDER: a file in `receipts/` that is not a
// receipt must not break the store, and a receipt that IS damaged must still
// be refused.
//
// MEASURED (2026-11-07, this host, pre-fix tree a7848d4 — the tree the
// published v0.4.10 carries):
//
// Every reader treated EVERY file in `receipts/` as a receipt. The trigger is
// sememe ITSELF: src/store-write.mjs installs a receipt (and an object)
// through a temporary file `<name>.tmp-<pid>-<random>` in the SAME directory
// and removes it in a `finally`. A crash between the write and the cleanup
// (SIGKILL, power loss, OOM) leaves that file behind FOREVER.
//
//   sememe decode <program> <payload>   -> EXIT 1 "store receipt <tmp file>
//                                          is unreadable: Unexpected token"
//   sememe decode --union <program> ... -> EXIT 1, same refusal
//   sememe lock                         -> EXIT 1, "Cannot destructure
//                                          property 'idl' of (intermediate
//                                          value) as it is null"
//   sememe verify --mode error          -> EXIT 1, "unverified: <program>"
//
// The last one is the worst: the CI gate went RED, named a program that was
// perfectly intact, and named no repair — the user is told to re-pull a
// healthy program. One crashed write permanently bricked the store.
//
// Two further pre-fix readings of the same root cause, both measured:
//   - a FOREIGN file (`.DS_Store`) became a PHANTOM program in the report
//     ("extra: [.DS_Store]");
//   - a foreign file WITH a dash (`my-file.json`) became a phantom program
//     "my" that FAILED the gate ("unverified: my") — a false red over a
//     file that was never a receipt.
//
// WHY THE DEBRIS IS SAFE TO IGNORE (the reason, not a convenience):
// store-write.mjs installs a receipt by HARD-LINKING the temporary file to
// its final name and only then removes the temporary. So the temporary never
// holds anything the final name does not also hold:
//   - died BEFORE the link -> only the temp exists; the receipt was never
//     committed, so there is nothing to read;
//   - died AFTER the link  -> the final name holds the receipt AND the temp
//     holds a byte-identical copy, so the temp carries no information the
//     committed receipt does not.
// Either way the debris is an UNCOMMITTED write.
//
// WHY MALFORMED RECEIPTS ARE NOT IGNORED: a name that looks like a receipt
// (it has a numeric slot segment) but is not well-formed may be a receipt
// that was renamed or corrupted. Ignoring it would be a NEW green lie: the
// receipt would vanish from the store's answers without a word. It stays in
// the verified set and is refused by name, exactly as before.
//
// LADDER (written FIRST, against a7848d4):
//   G1 (guard, GREEN pre-fix) an intact store with a clean lock stays clean:
//      no violations, no strays, nothing reported.
//   G2 (guard, GREEN pre-fix) a DAMAGED receipt (its object no longer
//      re-hashes) is still refused by name — the fix must not move that.
//   G3 (guard, GREEN pre-fix) a MALFORMED receipt name (slot segment, bad
//      hex tail) is still refused by name — it is damage, not debris.
//   T1 (RED pre-fix) a leftover `.tmp-` file from a crashed write does not
//      break `sememe decode`.
//   T2 (RED pre-fix) it does not break `sememe decode --union`.
//   T3 (RED pre-fix) it does not break `sememe lock`.
//   T4 (RED pre-fix) it does not make `sememe verify` fail, and the gate
//      stays GREEN — a crashed write must not turn a clean store red.
//   T5 (RED pre-fix) the stray files are REPORTED by name and kind, so a
//      user can see and delete them — ignored, but not silently.
//   T6 (RED pre-fix) a foreign file (`.DS_Store`) is not a phantom program:
//      it does not appear in `extra`, and the gate stays green.
//
// G1-G3 are the false-positive guards. Everything else must be red on the
// pre-fix tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm as fsRm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const whirlpoolIdl = JSON.parse(await readFile(new URL('./fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const { canonicalJson } = await import('../src/canonical.mjs');
const { writeLock, checkLock } = await import('../src/lock.mjs');
const { decodePayload, decodeUnionPayload } = await import('../src/decode.mjs');

const runCli = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });

/** Write one verified receipt+object pair, exactly as `sememe pull` writes. */
async function putIdl(store, program, idl, slot, source) {
  const bytes = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(store, 'receipts', `${program}-${slot}-${source}-${fingerprint}.json`),
    JSON.stringify({ program, fingerprint: `sha256:${fingerprint}`, slot, source }));
  return fingerprint;
}

/** A clean store with a committed lock. */
async function cleanStore() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-hygiene-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const fingerprint = await putIdl(store, WHIRLPOOL, whirlpoolIdl, 462039125, 'metadata');
  const lockPath = path.join(store, 'sememe.lock');
  await writeLock(store, lockPath);
  return { store, lockPath, fingerprint };
}

/** A payload the stored Whirlpool IDL can decode. */
function payloadFor() {
  const ix = whirlpoolIdl.instructions.find((i) => Array.isArray(i.discriminator) && i.discriminator.length === 8);
  return Buffer.from([...ix.discriminator, ...new Array(8).fill(0)]).toString('hex');
}

/** The exact leftover src/store-write.mjs leaves behind when the process
 * dies between the temporary write and the cleanup. */
const crashDebris = (receiptName) => `${receiptName}.tmp-4711-9f2c1a`;

// ------------------------------------------------------------------- guards

test('G1 (guard): an intact store with a clean lock stays clean — no violations, no strays', async () => {
  const { store, lockPath } = await cleanStore();
  try {
    const report = await checkLock(store, lockPath, { mode: 'error' });
    assert.equal(report.violations, 0);
    assert.deepEqual(report.verified, [WHIRLPOOL]);
    assert.deepEqual(report.extra, [], 'nothing is extra in a store that holds one program');
    assert.deepEqual(report.stray ?? [], [], 'a clean store has no stray files');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('G2 (guard): a DAMAGED receipt is still refused by name — the fix must not move it', async () => {
  const { store, lockPath, fingerprint } = await cleanStore();
  try {
    await writeFile(path.join(store, 'objects', `${fingerprint}.json`), '{"instructions":[]}\n');
    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.ok(report.violations >= 1, 'a damaged receipt must be a violation');
    assert.ok(report.unverified.some((u) => u.program === WHIRLPOOL),
      'the damaged program must still be named');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('G3 (guard): a MALFORMED receipt name (slot segment, bad hex tail) is still refused by name', async () => {
  const { store, lockPath } = await cleanStore();
  try {
    // receipt-shaped (it carries a numeric slot segment) but the fingerprint
    // tail is not 64 hex — this is DAMAGE to the store, not debris.
    await writeFile(path.join(store, 'receipts', `${WHIRLPOOL}-462039126-metadata-deadbeef.json`), 'not json');
    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.ok(report.violations >= 1,
      'a malformed receipt must not be silently ignored — it may be a renamed receipt');
    assert.ok(report.unverified.some((u) => u.program === WHIRLPOOL),
      'the malformed receipt must be named');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------- reds

test('T1: a leftover .tmp- file from a crashed write does not break sememe decode', async () => {
  const { store, fingerprint } = await cleanStore();
  try {
    const receiptName = `${WHIRLPOOL}-462039125-metadata-${fingerprint}.json`;
    await writeFile(path.join(store, 'receipts', crashDebris(receiptName)), 'leftover bytes');
    const decoded = await decodePayload(store, WHIRLPOOL, payloadFor());
    assert.equal(decoded.name, 'close_bundled_position',
      'the decode must still answer with the instruction name it decoded');
    assert.equal(decoded.program, WHIRLPOOL);
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('T2: it does not break sememe decode --union', async () => {
  const { store, fingerprint } = await cleanStore();
  try {
    const receiptName = `${WHIRLPOOL}-462039125-metadata-${fingerprint}.json`;
    await writeFile(path.join(store, 'receipts', crashDebris(receiptName)), 'leftover bytes');
    const decoded = await decodeUnionPayload(store, WHIRLPOOL, payloadFor());
    assert.equal(decoded.program, WHIRLPOOL, 'the union decode must still answer');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('T3: it does not break sememe lock', async () => {
  const { store, fingerprint } = await cleanStore();
  try {
    const receiptName = `${WHIRLPOOL}-462039125-metadata-${fingerprint}.json`;
    await writeFile(path.join(store, 'receipts', crashDebris(receiptName)), 'leftover bytes');
    const doc = await writeLock(store, path.join(store, 'second.lock'));
    assert.ok(doc.programs[WHIRLPOOL], 'the lock must still pin the program');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('T4: it does not make sememe verify fail — a crashed write must not turn a clean store red', async () => {
  const { store, lockPath, fingerprint } = await cleanStore();
  try {
    const receiptName = `${WHIRLPOOL}-462039125-metadata-${fingerprint}.json`;
    await writeFile(path.join(store, 'receipts', crashDebris(receiptName)), 'leftover bytes');
    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.violations, 0,
      `a crashed write must not turn a clean store red; got ${JSON.stringify(report.unverified)}`);
    assert.deepEqual(report.verified, [WHIRLPOOL], 'the program must still verify');

    // And the CLI gate the README tells a stranger to run.
    const result = runCli(['verify', '--store', store, '--lock', lockPath, '--mode', 'error']);
    assert.equal(result.status, 0,
      `the CI gate must stay green; got ${result.status}\n${String(result.stderr).slice(0, 300)}`);
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('T5: the stray files are REPORTED by name and kind — ignored, but not silently', async () => {
  const { store, lockPath, fingerprint } = await cleanStore();
  try {
    const receiptName = `${WHIRLPOOL}-462039125-metadata-${fingerprint}.json`;
    const debris = crashDebris(receiptName);
    await writeFile(path.join(store, 'receipts', debris), 'leftover bytes');
    const report = await checkLock(store, lockPath, { mode: 'warn' });
    const stray = report.stray ?? [];
    assert.ok(stray.some((s) => s.name === debris && s.kind === 'debris'),
      `the crash debris must be reported as debris; got ${JSON.stringify(stray)}`);
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('T6: a foreign file (.DS_Store) is not a phantom program — the gate stays green', async () => {
  const { store, lockPath } = await cleanStore();
  try {
    await writeFile(path.join(store, 'receipts', '.DS_Store'), 'junk');
    const report = await checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.violations, 0, 'a foreign file must not fail the gate');
    assert.deepEqual(report.extra, [], '.DS_Store must not become a phantom program');
    assert.ok((report.stray ?? []).some((s) => s.name === '.DS_Store'),
      'the foreign file must still be reported');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// MUTATIONS — each must turn a test above red.
//
// The mutant is written INTO src/ under a dot-prefixed name (so its relative
// imports resolve against the real tree) and deleted afterwards; the real
// modules are never modified. A mutation of `src/receipt-name.mjs` alone would
// pin NOTHING: every consumer imports './receipt-name.mjs' by that literal
// path, so a dot-prefixed copy of the classifier is never executed by the
// reader. Each mutant therefore lives in the CONSUMER — the module the
// executed path really calls (the pattern of test/multi-copy-store.test.mjs).
//
//   X1  the reader drops the classifier (the pre-fix rule: every file that
//       starts with `<program>-` is a receipt) -> T1/T2 red (decode and the
//       union decode read the crash debris and refuse).
//   X2  the lock stops reporting stray files -> T5 red (ignored, but silently).
//   X3  the lock ignores MALFORMED receipts too (the green lie: a renamed
//       receipt would vanish from the store's answers without a word) -> G3 red.
//   X4  the lock reads every file as a receipt again (the pre-fix rule) ->
//       T3/T4 red (writeLock refuses, the CI gate goes red over a clean store).
// ---------------------------------------------------------------------------

/** Write a mutant of `file` in src/ under a dot-prefixed name, import it,
 * delete it afterwards. The real module is never touched. */
async function withMutant(file, name, mutate) {
  const source = await readFile(path.join(ROOT, 'src', file), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${name}: the mutation must actually change the source`);
  const mutantPath = path.join(ROOT, 'src', `.${name}-mutant.mjs`);
  try {
    await writeFile(mutantPath, mutated);
    return await import(mutantPath);
  } finally {
    await fsRm(mutantPath, { force: true });
  }
}

test('MUTATION X1 (the reader drops the classifier) turns T1 and T2 red', async () => {
  const mutant = await withMutant('store-read.mjs', 'x1-no-classifier', (source) => source.replace(
    '  const candidates = names.filter((name) => name.startsWith(`${program}-`) && isReceiptFile(name));',
    '  const candidates = names.filter((name) => name.startsWith(`${program}-`));',
  ));
  const { store, fingerprint } = await cleanStore();
  try {
    const receiptName = `${WHIRLPOOL}-462039125-metadata-${fingerprint}.json`;
    await writeFile(path.join(store, 'receipts', crashDebris(receiptName)), 'leftover bytes');
    await assert.rejects(() => mutant.findStoredIdl(store, WHIRLPOOL),
      'the mutant must refuse the store over crash debris — otherwise T1/T2 pin nothing');
    await assert.rejects(() => mutant.findStoredIdls(store, WHIRLPOOL),
      'the mutant must refuse the union path over crash debris — otherwise T2 pins nothing');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('MUTATION X2 (the lock stops reporting strays) turns T5 red', async () => {
  const mutant = await withMutant('lock.mjs', 'x2-silent-stray', (source) => source.replace(
    '    stray,',
    '    stray: [],',
  ));
  const { store, lockPath, fingerprint } = await cleanStore();
  try {
    const receiptName = `${WHIRLPOOL}-462039125-metadata-${fingerprint}.json`;
    await writeFile(path.join(store, 'receipts', crashDebris(receiptName)), 'leftover bytes');
    const report = await mutant.checkLock(store, lockPath, { mode: 'warn' });
    assert.deepEqual(report.stray, [],
      'the mutant must hide the crash debris from the report — otherwise T5 pins nothing');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('MUTATION X3 (the lock ignores malformed receipts too) turns G3 red', async () => {
  const mutant = await withMutant('lock.mjs', 'x3-drop-malformed', (source) => source.replace(
    '  const { receipts: validReceipts, stray } = classifyReceiptFiles(receiptNames);',
    '  const { receipts: good, stray } = classifyReceiptFiles(receiptNames);\n'
    + '  const validReceipts = good.filter((name) => /-[a-f0-9]{64}\\.json$/.test(name));',
  ));
  const { store, lockPath } = await cleanStore();
  try {
    await writeFile(path.join(store, 'receipts', `${WHIRLPOOL}-462039126-metadata-deadbeef.json`), 'not json');
    const report = await mutant.checkLock(store, lockPath, { mode: 'warn' });
    assert.equal(report.violations, 0,
      'the mutant must pass a store holding a renamed/corrupted receipt — otherwise G3 pins nothing');
    assert.deepEqual(report.unverified, [],
      'the mutant must name no damaged receipt — otherwise G3 pins nothing');
  } finally { await fsRm(store, { recursive: true, force: true }); }
});

test('MUTATION X4 (the lock reads every file as a receipt again) turns T3 and T4 red', async () => {
  const mutant = await withMutant('lock.mjs', 'x4-read-everything', (source) => source
    .replace('  const { receipts: validReceipts, stray } = classifyReceiptFiles(receiptNames);',
      '  const validReceipts = receiptNames;\n  const stray = [];')
    .replace('  const programs = [...new Set(names.filter(isReceiptFile).map(programOfReceiptName))].sort();',
      '  const programs = [...new Set(names.map(programOfReceiptName))].sort();')
    .replace('    const candidates = names.filter((name) => name.startsWith(`${program}-`) && isReceiptFile(name));',
      '    const candidates = names.filter((name) => name.startsWith(`${program}-`));'));
  const { store, lockPath, fingerprint } = await cleanStore();
  try {
    const receiptName = `${WHIRLPOOL}-462039125-metadata-${fingerprint}.json`;
    await writeFile(path.join(store, 'receipts', crashDebris(receiptName)), 'leftover bytes');
    await assert.rejects(() => mutant.writeLock(store, path.join(store, 'second.lock')),
      'the mutant must refuse the LOCK over crash debris — otherwise T3 pins nothing');
    const report = await mutant.checkLock(store, lockPath, { mode: 'warn' });
    assert.ok(report.violations >= 1,
      `the mutant must turn a clean store RED over crash debris — otherwise T4 pins nothing; got ${JSON.stringify(report.unverified)}`);
  } finally { await fsRm(store, { recursive: true, force: true }); }
});
