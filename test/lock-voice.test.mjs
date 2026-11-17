// test/lock-voice.test.mjs — the LOCK SURFACE must name its refusals, like
// every other refusal class in the product.
//
// WHAT THIS PINS (the defect, measured 2026-11-17, this host, and
// reproduced against the PUBLISHED sememe@0.4.34 installed into an empty
// app):
//
// The lock is the product's own CI gate: the README tells a stranger to run
// `npx sememe verify` after checkout. Three classifier families already
// speak the product's voice — the file the CALLER names
// (src/file-input.mjs), the store directory the CALLER names
// (src/store-input.mjs), the damage the reader FINDS ITSELF
// (src/store-damage.mjs). The LOCK surface did not:
//
//   sememe verify --store store --lock bad.lock
//     -> {"error":"sememe lock file bad.lock is not JSON (lock-v1-parse)"}
//        exit 1
//   sememe verify --store store --lock drift.lock
//     -> {"error":"store does not match sememe.lock (1 drifted, 0 missing,
//        0 unverified, 0 relabelled, 0 unbound) — drifted: …"}
//        exit 1
//
// Four faults, all measured:
//
//   L1  NO BRANCHABLE NAME. The reason sat INSIDE the prose ("(lock-v1-
//       parse)"), so `error.code` was undefined and a script had to read
//       English to branch. The gate failure had NO reason at all.
//   L2  NO REPAIR. Not one of these refusals named what the operator can
//       run.
//   L3  NO STRUCTURED DETAIL on the gate answer: a pipeline could not tell
//       "the store drifted" from "a receipt is damaged" without parsing
//       the sentence.
//   L4  A CODE MINTED AND DROPPED. The receipt-integrity refusals carried
//       `code: receipt-tampered` but NO `fix` — and the CLI prints
//       code+fix only when BOTH are present, so the code never reached the
//       operator.
//
// THE CONTRACT (src/lock-voice.mjs is the ONE classifier):
//
//   C1  every lock refusal carries a PRODUCT CODE naming the reason:
//       lock-v1-parse / lock-v1-shape / lock-v1-fingerprint /
//       lock-v1-origin / lock-pins-nothing / lock-mismatch.
//   C2  every lock refusal carries a REPAIR the operator can run.
//   C3  the CHANNEL does not move: a document fault and a gate failure are
//       the WORK channel (exit 1) — the file WAS read and the work ran,
//       the bytes were wrong. The CALLER-named path class keeps the
//       usage/IO channel (exit 2); the two classes must not collapse.
//   C4  the sentences other tools quote stay VERBATIM: the reason in
//       parentheses, the file named, the violation kinds named.
//   C5  the gate answer carries the programs of every violation kind, so
//       no pipeline has to parse prose to learn what broke.
//   C6  the CONTROLS are untouched: an intact store still verifies green,
//       `sememe lock` still writes a lock, and a store that does not exist
//       still answers with its own sentence — an ANSWER, not a refusal, so
//       it must not acquire a code or a repair.
//
// The pre-fix numbers are pinned by the committed artifact
// (research/lock-voice-2026-11-17.json, produced by
// tools/measure-lock-voice.mjs): 13 of the 13 faces were unnamed and
// repairless on the pre-fix tree (c356ab4), 2 library refusals minted a
// code without a repair; 0 of each here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const OTHER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');

const { canonicalJson } = await import('../src/canonical.mjs');
const { receiptDigestOf, originDigestOf } = await import('../src/receipt-digest.mjs');
const idl = JSON.parse(fs.readFileSync(IDL, 'utf8'));
const objectBytes = Buffer.from(canonicalJson(idl) + '\n');
const fingerprint = createHash('sha256').update(objectBytes).digest('hex');
const receiptName = `${PROGRAM}-462039125-metadata-${fingerprint}.json`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-lock-voice-'));

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { exit: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/** The product's refusal as a script sees it: a JSON object on stderr with
 *  a code, a repair and (for the gate) the violations. */
function refusal(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.stderr.trim()); } catch { parsed = null; }
  return {
    exit: result.exit,
    code: parsed?.code ?? null,
    fix: parsed?.fix ?? null,
    violations: parsed?.violations ?? null,
    error: String(parsed?.error ?? `${result.stdout}${result.stderr}`),
    out: `${result.stdout}${result.stderr}`,
  };
}

/** A store exactly as `sememe pull` writes it. */
function makeStore(name, receiptBody = null) {
  const store = path.join(tmp, name);
  fs.mkdirSync(path.join(store, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(store, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(store, 'objects', `${fingerprint}.json`), objectBytes);
  const body = receiptBody ?? {
    program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata',
  };
  const name2 = `${PROGRAM}-${body.slot ?? 462039125}-${body.source ?? 'metadata'}-${fingerprint}.json`;
  fs.writeFileSync(path.join(store, 'receipts', name2), JSON.stringify(body));
  return { store, receiptFile: name2 };
}

const { store: intact, receiptFile } = makeStore('intact');

function lockFile(name, doc) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return p;
}

const pinned = {
  lockVersion: 1,
  programs: {
    [PROGRAM]: {
      fingerprint: `sha256:${fingerprint}`,
      source: 'metadata',
      slot: 462039125,
      receipt: receiptFile,
      instructions: idl.instructions.length,
    },
  },
};

// --- C1/C2: every refusal names itself and names a repair --------------------

const REFUSAL_FACES = [
  {
    name: 'a lock file that holds no JSON',
    code: 'lock-v1-parse',
    run: () => run(['verify', '--store', intact, '--lock', lockFile('not-json.lock', 'nope')]),
  },
  {
    name: 'a lock file that holds JSON but not a lock',
    code: 'lock-v1-shape',
    run: () => run(['verify', '--store', intact, '--lock', lockFile('array.lock', '[]')]),
  },
  {
    name: 'a lock with an unsupported version',
    code: 'lock-v1-shape',
    run: () => run(['verify', '--store', intact, '--lock',
      lockFile('version.lock', { lockVersion: 99, programs: pinned.programs })]),
  },
  {
    name: 'a lock with no programs map',
    code: 'lock-v1-shape',
    run: () => run(['verify', '--store', intact, '--lock', lockFile('no-programs.lock', { lockVersion: 1 })]),
  },
  {
    name: 'a lock that pins no program',
    code: 'lock-pins-nothing',
    run: () => run(['verify', '--store', intact, '--lock', lockFile('empty.lock', { lockVersion: 1, programs: {} })]),
  },
  {
    name: 'a pinned entry that is not an object',
    code: 'lock-v1-shape',
    run: () => run(['verify', '--store', intact, '--lock',
      lockFile('entry.lock', { lockVersion: 1, programs: { [PROGRAM]: 7 } })]),
  },
  {
    name: 'a pinned fingerprint that is malformed',
    code: 'lock-v1-fingerprint',
    run: () => run(['verify', '--store', intact, '--lock',
      lockFile('fingerprint.lock', { lockVersion: 1, programs: { [PROGRAM]: { fingerprint: 'nope' } } })]),
  },
  {
    name: 'a pinned origin that is malformed',
    code: 'lock-v1-origin',
    run: () => run(['verify', '--store', intact, '--lock',
      lockFile('origin.lock', { lockVersion: 1, programs: { [PROGRAM]: { fingerprint: `sha256:${fingerprint}`, origin: 7 } } })]),
  },
  {
    name: 'a store that does not match the lock',
    code: 'lock-mismatch',
    run: () => run(['verify', '--store', intact, '--lock',
      lockFile('drift.lock', { lockVersion: 1, programs: { [PROGRAM]: { fingerprint: `sha256:${'0'.repeat(64)}` } } })]),
  },
  {
    name: 'a pinned program the store does not hold',
    code: 'lock-mismatch',
    run: () => run(['verify', '--store', intact, '--lock',
      lockFile('missing.lock', { lockVersion: 1, programs: { ...pinned.programs, [OTHER_PROGRAM]: pinned.programs[PROGRAM] } })]),
  },
];

for (const face of REFUSAL_FACES) {
  test(`C1/C2 — ${face.name} is refused BY NAME, with a repair`, () => {
    const result = face.run();
    const parsed = refusal(result);
    assert.equal(parsed.code, face.code,
      `the refusal must carry the product's own code: ${parsed.out.slice(0, 300)}`);
    assert.ok(parsed.fix && /^fix: /.test(parsed.fix),
      `the refusal must carry a repair: ${parsed.out.slice(0, 300)}`);
    assert.equal(parsed.exit, 1, 'the work channel: the file was read, the bytes were wrong');
  });
}

// --- C5: the gate answer says WHAT broke ------------------------------------

test('C5 — the gate answer carries the programs of every violation kind', () => {
  const parsed = refusal(run(['verify', '--store', intact, '--lock',
    lockFile('gate.lock', { lockVersion: 1, programs: { [PROGRAM]: { fingerprint: `sha256:${'0'.repeat(64)}` } } })]));
  assert.equal(parsed.code, 'lock-mismatch', 'the gate must name itself');
  assert.ok(parsed.violations, 'the gate must carry the violations: a pipeline must not parse prose');
  assert.deepEqual(parsed.violations.drifted, [PROGRAM],
    'the drifted program must be named machine-readably');
  assert.match(parsed.error, /drifted/, 'and the sentence must still name the kind');
  // The repair must be the one of the kind that ACTUALLY happened: a
  // drifted gate answered with the relabelled repair is the wrong repair,
  // and both contain "sememe lock", so the pin has to say which.
  assert.match(parsed.fix, /different bytes/,
    `the drifted repair must be the drifted one: ${parsed.fix}`);
  assert.doesNotMatch(parsed.fix, /declared origin/,
    'the drifted gate must not answer with a repair for a kind that did not happen');
});

// --- L4: a code minted at the library must not be dropped by the channel ----

test('L4 — a receipt edited after it was written is refused with code AND repair', () => {
  const tampered = makeStore('tampered', {
    program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata',
    // a digest over a DIFFERENT body: the receipt was edited after it was written
    receiptDigest: receiptDigestOf({
      program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 1, source: 'metadata',
    }),
  });
  const parsed = refusal(run(['lock', '--store', tampered.store, '--out', path.join(tmp, 't.lock')]));
  assert.equal(parsed.code, 'receipt-tampered',
    `the minted code must REACH the operator, not be dropped by the channel: ${parsed.out.slice(0, 300)}`);
  assert.ok(parsed.fix && /^fix: /.test(parsed.fix),
    `and the repair must travel with it: ${parsed.out.slice(0, 300)}`);
  assert.equal(parsed.exit, 1, 'damage is the work channel');
});

test('L4 — a rewritten declared origin is refused with code AND repair', () => {
  const relabelled = makeStore('relabelled', {
    program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata',
    origin: 'attacker/rewritten-origin',
    originDigest: originDigestOf('the-origin-it-was-written-with'),
  });
  const parsed = refusal(run(['lock', '--store', relabelled.store, '--out', path.join(tmp, 'r.lock')]));
  assert.equal(parsed.code, 'receipt-relabelled',
    `the minted code must REACH the operator: ${parsed.out.slice(0, 300)}`);
  assert.ok(parsed.fix && /^fix: /.test(parsed.fix), 'and the repair must travel with it');
});

// --- C4: the quoted sentences stay VERBATIM ---------------------------------

test('C4 — the sentences other tools quote stay verbatim', () => {
  const notJson = refusal(run(['verify', '--store', intact, '--lock', lockFile('q1.lock', 'nope')]));
  assert.match(notJson.error, /sememe lock file .* is not JSON \(lock-v1-parse\)/,
    `the parse sentence must stay: ${notJson.error}`);
  // …and it stays at the FRONT: a code that pushes the quoted sentence out
  // of position breaks every regex anchored on the old first word.
  assert.ok(notJson.error.startsWith('sememe lock file'),
    `the sentence must stay first: ${notJson.error.slice(0, 120)}`);
  const empty = refusal(run(['verify', '--store', intact, '--lock', lockFile('q2.lock', { lockVersion: 1, programs: {} })]));
  assert.match(empty.error, /pins no program \(lock-pins-nothing\)/,
    `the pins-nothing sentence must stay: ${empty.error}`);
  assert.ok(empty.error.startsWith('sememe lock file'),
    `and stays first: ${empty.error.slice(0, 120)}`);
  const gate = refusal(run(['verify', '--store', intact, '--lock',
    lockFile('q3.lock', { lockVersion: 1, programs: { [PROGRAM]: { fingerprint: `sha256:${'0'.repeat(64)}` } } })]));
  assert.match(gate.error, /store does not match sememe\.lock \(\d+ drifted, \d+ missing, \d+ unverified, \d+ relabelled, \d+ unbound\)/,
    `the gate sentence must stay: ${gate.error}`);
  assert.ok(gate.error.startsWith('store does not match sememe.lock'),
    `and stays first: ${gate.error.slice(0, 120)}`);
});

// --- C3: the channel does not move -------------------------------------------

test('C3 — the CALLER-named path class keeps its own voice and its own channel', () => {
  const parsed = refusal(run(['verify', '--store', intact, '--lock', path.join(tmp, 'no-such.lock')]));
  assert.equal(parsed.code, 'lock-file-missing',
    `a lock path that does not exist is the caller's mistake: ${parsed.out.slice(0, 300)}`);
  assert.equal(parsed.exit, 2, 'and it keeps the usage/IO channel');
});

// --- C6: the controls are untouched ------------------------------------------

test('C6 — an intact store still verifies green', () => {
  const lockOut = path.join(tmp, 'green.lock');
  const written = run(['lock', '--store', intact, '--out', lockOut]);
  assert.equal(written.exit, 0, `sememe lock must still write a lock: ${written.stderr}`);
  const verified = run(['verify', '--store', intact, '--lock', lockOut]);
  assert.equal(verified.exit, 0, `verify on an intact store must stay green: ${verified.stderr}`);
  assert.match(verified.stdout, /"violations": 0/);
});

test('C6 — a store that does not exist is an ANSWER, not a refusal', () => {
  const parsed = refusal(run(['verify', '--store', path.join(tmp, 'no-such-store'), '--lock', path.join(tmp, 'green.lock')]));
  assert.match(parsed.error, /no sememe store at/,
    `the missing-store answer keeps its own sentence: ${parsed.out.slice(0, 300)}`);
  assert.equal(parsed.code, null, 'the missing-store answer must not acquire a code');
  assert.equal(parsed.fix, null, 'nor a repair');
});

// --- the classifier is the ONE place ----------------------------------------

test('the classifier is the ONE place: every minted code is recognisable', async () => {
  const { isLockCode, lockRefusal, mismatchRepair } = await import('../src/lock-voice.mjs');
  for (const face of REFUSAL_FACES) {
    assert.ok(isLockCode(face.code), `${face.code} must be recognisable as a lock refusal`);
  }
  assert.ok(!isLockCode('lock-file-missing'), 'the CALLER-named path class is NOT this class');
  assert.ok(!isLockCode('store-receipt-unreadable'), 'nor the damage class');
  assert.ok(!isLockCode('no-sememe-store'), 'nor the missing-store answer');
  assert.throws(() => lockRefusal({ code: 'not-a-lock-code', message: 'x' }),
    /does not mint/, 'the classifier must refuse a code it does not mint');
  const refusal2 = lockRefusal({ code: 'lock-v1-parse', message: 'sememe lock file x is not JSON (lock-v1-parse)' });
  assert.equal(refusal2.exitCode, 1, 'the work channel');
  assert.match(refusal2.fix, /^fix: /, 'and a repair');
  assert.match(refusal2.message, /\(lock-v1-parse\)/,
    'the code must ride at the end of the product\'s own sentence, not push it out of position');
  assert.equal(mismatchRepair(['drifted']), mismatchRepair(['drifted', 'drifted']),
    'the repair must not repeat a kind');
  assert.ok(mismatchRepair(['drifted']).includes('re-pull'), 'the drifted repair');
  assert.ok(mismatchRepair(['missing']).includes('sememe pull'), 'the missing repair');
});

test('the committed measurement is the one the tool produces, and its baseline really had the defect', () => {
  const artifact = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'research', 'lock-voice-2026-11-17.json'), 'utf8'));
  assert.equal(artifact.verdictName, 'lock-voice-closed', 'the verdict must be closed');
  assert.ok(artifact.verdict.preFixUnnamedFaces > 0,
    'the pre-fix tree must have been unnamed: a baseline with no defect makes the fix unmeasurable');
  assert.ok(artifact.verdict.preFixRepairlessFaces > 0, 'and repairless');
  assert.ok(artifact.verdict.preFixSilentCodeFaces > 0, 'and at least one code minted but dropped');
  assert.equal(artifact.verdict.fixedUnnamedFaces, 0, 'no refusal may be unnamed');
  assert.equal(artifact.verdict.fixedRepairlessFaces, 0, 'no refusal may be repairless');
  assert.equal(artifact.verdict.fixedWrongChannelFaces, 0, 'no refusal may leave the work channel');
  assert.equal(artifact.verdict.fixedSilentCodeFaces, 0, 'no minted code may be dropped');
  assert.equal(artifact.verdict.controlRegression, 0, 'no control may change verdict');
  assert.equal(artifact.hostPathLeak, 0, 'research/ is committed — no host path in it');
  assert.equal(artifact.tempPathLeak, 0, 'and no absolute temp path either');
});
