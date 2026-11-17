// test/answer-voice.test.mjs — THE PRODUCT'S ANSWERS ARE NAMED AS ANSWERS,
// NOT LEFT AS BARE PROSE AND NOT DRESSED UP AS REFUSALS.
//
// WHAT THIS PINS (the defect, measured 2026-11-17, this host, pre-fix tree
// dc2317d, and reproduced against the PUBLISHED sememe@0.4.35 installed into
// an empty app):
//
// The store reader minted `no-sememe-store` and `no-stored-idl`, but the CLI
// prints `code` only together with `fix` — and an answer has no fix — so
// both codes were minted and DROPPED. The two lock-surface call sites did
// not even mint them. Every answer face reached the operator as bare prose:
//
//   sememe decode <program> <payload> --store <missing>
//     -> {"error":"no sememe store at …: run \"sememe pull\" first"} exit 1
//   sememe verify --store <missing> --lock <lock>
//     -> {"error":"no sememe store at …: run \"sememe pull\" first"} exit 1
//   sememe decode <program> <payload> --store <store without the program>
//     -> {"error":"no stored IDL for program … in …"} exit 1
//
// An ANSWER is not a refusal: nothing is broken and nothing can be repaired.
// The store is simply not in the state the command needs. The card's own
// plan (17.11): "die Antwort-Flächen bekommen einen Code, aber KEINE
// Reparatur — sie sind Antworten, keine Verweigerungen; eine Antwort mit
// Code braucht eine eigene Semantik." That semantics is `answer: true`:
// ACQUIRE, do not repair.
//
// THE CONTRACT (src/store-answer.mjs is the ONE mint place):
//   A1  every answer carries a PRODUCT CODE: no-sememe-store / no-stored-idl.
//   A2  every answer carries `answer: true` — acquire, do not repair. That
//       is what separates it from a refusal without parsing prose.
//   A3  an answer carries NO `fix` — the verbatim sentence already says
//       what to run ("run \"sememe pull\" first").
//   A4  the SENTENCE stays verbatim and in front: quoted by bin/sememe.mjs,
//       the README and several tests.
//   A5  the CHANNEL does not move: exit 1, stderr, JSON — exactly where
//       these answers answered before they were named.
//   A6  the refusal classes are untouched: a caller-named wrong path keeps
//       the store-input voice (exit 2), damage keeps the store-damage voice
//       (exit 1), the gate stays green — and `answer: true` never rides on
//       a refusal, `fix` never rides on an answer.
//
// The pre-fix numbers are pinned by the committed artifact
// (research/answer-voice-2026-11-17.json, produced by
// tools/measure-answer-voice.mjs): all 6 answer faces were unnamed on the
// pre-fix tree (dc2317d); 0 are here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const OTHER_PROGRAM = '4bCbe9vJAbtpajLfgHyLbEYWcAvAhXXLbQ6kZ1QwqVvT';
const IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');

const { canonicalJson } = await import('../src/canonical.mjs');
const { createHash } = await import('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-answer-voice-'));

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { exit: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/** The machine answer as a script sees it: the parsed stderr JSON plus the
 *  channel. */
function parsed(result) {
  let doc = null;
  try { doc = JSON.parse(result.stderr.trim()); } catch { doc = null; }
  return {
    exit: result.exit,
    error: doc && typeof doc.error === 'string' ? doc.error : '',
    code: doc && typeof doc.code === 'string' ? doc.code : null,
    fix: doc && typeof doc.fix === 'string' ? doc.fix : null,
    answer: doc?.answer === true,
    keys: doc && typeof doc === 'object' ? Object.keys(doc).sort() : [],
    out: `${result.stdout}${result.stderr}`,
  };
}

/** A store exactly as `sememe pull` writes it. */
const idl = JSON.parse(fs.readFileSync(IDL, 'utf8'));
const objectBytes = Buffer.from(canonicalJson(idl) + '\n');
const fingerprint = createHash('sha256').update(objectBytes).digest('hex');
const receiptName = `${PROGRAM}-462039125-metadata-${fingerprint}.json`;

const intact = path.join(tmp, 'intact-store');
fs.mkdirSync(path.join(intact, 'receipts'), { recursive: true });
fs.mkdirSync(path.join(intact, 'objects'), { recursive: true });
fs.writeFileSync(path.join(intact, 'objects', `${fingerprint}.json`), objectBytes);
fs.writeFileSync(path.join(intact, 'receipts', receiptName), JSON.stringify({
  program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata',
}));

const missing = path.join(tmp, 'no-such-store');
const greenLock = path.join(tmp, 'green.lock');

// The lock exists BEFORE the verify face runs: a missing lock is the
// CALLER-PATH class (exit 2) and would hide the store answer under test.
run(['lock', '--store', intact, '--out', greenLock]);

// --- A1+A2+A3+A5: every answer face is named, marked, repairless, exit 1 ----

test('A1/A2/A3/A5 — decode answers a missing store by name, as an answer, exit 1', () => {
  const face = parsed(run(['decode', PROGRAM, 'AAAA', '--store', missing]));
  assert.equal(face.exit, 1, `the channel does not move: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'no-sememe-store', `the answer carries its code: ${face.out.slice(0, 300)}`);
  assert.equal(face.answer, true, 'and its own semantics: acquire, do not repair');
  assert.equal(face.fix, null, 'an answer carries NO repair');
});

test('A1/A2/A3/A5 — account answers a missing store the same way', () => {
  const face = parsed(run(['account', PROGRAM, 'AAAA', '--store', missing]));
  assert.equal(face.exit, 1, `the channel does not move: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'no-sememe-store', `named: ${face.out.slice(0, 300)}`);
  assert.equal(face.answer, true, 'answer, not refusal');
  assert.equal(face.fix, null, 'no repair');
});

test('A1/A2/A3/A5 — lock answers a missing store the same way (it used to mint nothing at all)', () => {
  const face = parsed(run(['lock', '--store', missing, '--out', path.join(tmp, 'x.lock')]));
  assert.equal(face.exit, 1, `the channel does not move: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'no-sememe-store', `named: ${face.out.slice(0, 300)}`);
  assert.equal(face.answer, true, 'answer, not refusal');
  assert.equal(face.fix, null, 'no repair');
});

test('A1/A2/A3/A5 — verify answers a missing store the same way (it used to mint nothing at all)', () => {
  const face = parsed(run(['verify', '--store', missing, '--lock', greenLock]));
  assert.equal(face.exit, 1, `the channel does not move: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'no-sememe-store', `named: ${face.out.slice(0, 300)}`);
  assert.equal(face.answer, true, 'answer, not refusal');
  assert.equal(face.fix, null, 'no repair');
});

test('A1/A2/A3/A5 — a store that simply lacks the program answers no-stored-idl (decode)', () => {
  const face = parsed(run(['decode', OTHER_PROGRAM, 'AAAA', '--store', intact]));
  assert.equal(face.exit, 1, `the channel does not move: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'no-stored-idl', `named: ${face.out.slice(0, 300)}`);
  assert.equal(face.answer, true, 'an acquisition gap is an answer too');
  assert.equal(face.fix, null, 'no repair');
});

test('A1/A2/A3/A5 — account answers no-stored-idl the same way', () => {
  const face = parsed(run(['account', OTHER_PROGRAM, 'AAAA', '--store', intact]));
  assert.equal(face.exit, 1, `the channel does not move: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'no-stored-idl', `named: ${face.out.slice(0, 300)}`);
  assert.equal(face.answer, true, 'answer, not refusal');
  assert.equal(face.fix, null, 'no repair');
});

// --- A4: the sentences other tools quote stay verbatim -----------------------

test('A4 — the missing-store sentence is byte-for-byte what the README quotes', () => {
  const face = parsed(run(['decode', PROGRAM, 'AAAA', '--store', missing]));
  assert.equal(face.error, `no sememe store at ${missing}: run "sememe pull" first`,
    `the sentence is quoted verbatim by bin/sememe.mjs, the README and tests: ${face.error}`);
  assert.equal(face.keys.join(','), 'answer,code,error',
    'the answer carries exactly its three fields — no repair slipping in, no refusal fields');
});

test('A4 — the no-stored-idl sentence is byte-for-byte what the tests quote', () => {
  const face = parsed(run(['account', OTHER_PROGRAM, 'AAAA', '--store', intact]));
  assert.equal(face.error, `no stored IDL for program ${OTHER_PROGRAM} in ${intact}`,
    `the sentence keeps its place: ${face.error}`);
  assert.equal(face.keys.join(','), 'answer,code,error', 'exactly three fields');
});

test('A1 — the two answers are DIFFERENT states a script can branch on', () => {
  const noStore = parsed(run(['decode', PROGRAM, 'AAAA', '--store', missing])).code;
  const noIdl = parsed(run(['decode', OTHER_PROGRAM, 'AAAA', '--store', intact])).code;
  assert.notEqual(noStore, noIdl, 'acquire a store vs. pull this program: two states, two codes');
});

// --- A6: the refusal classes are untouched -----------------------------------

test('A6 — a caller-named wrong store path keeps the store-input refusal voice (exit 2)', () => {
  const storeIsFile = path.join(tmp, 'store-is-file');
  fs.writeFileSync(storeIsFile, 'not a store');
  const face = parsed(run(['decode', PROGRAM, 'AAAA', '--store', storeIsFile]));
  assert.equal(face.exit, 2, `the usage/IO channel: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'store-not_a_directory', 'the path class keeps its name');
  assert.match(face.fix, /^fix: /, 'a refusal keeps its repair');
  assert.equal(face.answer, false, 'and `answer: true` never rides on a refusal');
});

test('A6 — damage in a store keeps the store-damage refusal voice (exit 1)', () => {
  const damaged = path.join(tmp, 'damaged-store');
  fs.mkdirSync(path.join(damaged, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(damaged, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(damaged, 'objects', `${fingerprint}.json`), objectBytes);
  fs.writeFileSync(path.join(damaged, 'receipts', receiptName), JSON.stringify({
    program: PROGRAM, fingerprint: `sha256:${'0'.repeat(64)}`, slot: 462039125, source: 'metadata',
  }));
  const face = parsed(run(['lock', '--store', damaged, '--out', path.join(tmp, 'd.lock')]));
  assert.equal(face.exit, 1, `damage stays on the work channel: ${face.out.slice(0, 300)}`);
  assert.equal(face.code, 'store-object-missing',
    'the damage class keeps its own name — the receipt in this fixture points at an object the store lacks');
  assert.match(face.fix, /^fix: /, 'a refusal keeps its repair');
  assert.equal(face.answer, false, 'and `answer: true` never rides on a refusal');
});

test('A6 — an intact store still verifies green', () => {
  const written = run(['lock', '--store', intact, '--out', greenLock]);
  assert.equal(written.exit, 0, `sememe lock must still write a lock: ${written.stderr}`);
  const verified = run(['verify', '--store', intact, '--lock', greenLock]);
  assert.equal(verified.exit, 0, `verify on an intact store must stay green: ${verified.stderr}`);
  assert.match(verified.stdout, /"violations": 0/);
});

// --- the classifier is the ONE place -----------------------------------------

test('the classifier is the ONE place: the answer codes are recognisable, refusal codes are not answers', async () => {
  const { isAnswerCode, noStoreAnswer, noStoredIdlAnswer } = await import('../src/store-answer.mjs');
  assert.ok(isAnswerCode('no-sememe-store'));
  assert.ok(isAnswerCode('no-stored-idl'));
  for (const foreign of [
    'store-not_a_directory', 'store-receipt-unreadable', 'store-object-rehash_mismatch',
    'lock-v1-parse', 'lock-mismatch', 'receipt-tampered', 'lock-file-missing',
    'conform-file-missing', 'adopt-file-missing', 'usage', 'peer_dependency_missing',
    'unsupported-idl-dialect',
  ]) {
    assert.ok(!isAnswerCode(foreign), `${foreign} is a refusal, not an answer`);
  }
  const minted = noStoreAnswer('/x');
  assert.equal(minted.code, 'no-sememe-store');
  assert.equal(minted.answer, true, 'the mint marks it as an answer');
  assert.equal(minted.fix, undefined, 'the mint attaches no repair');
  assert.equal(minted.message, 'no sememe store at /x: run "sememe pull" first', 'the verbatim sentence');
  const gap = noStoredIdlAnswer('P', '/x');
  assert.equal(gap.code, 'no-stored-idl');
  assert.equal(gap.answer, true);
  assert.equal(gap.fix, undefined, 'no repair');
  assert.equal(gap.message, 'no stored IDL for program P in /x', 'the verbatim sentence');
});

test('the library paths mint through the ONE place: answers carry the mark through store-read', async () => {
  const { findStoredIdl } = await import('../src/store-read.mjs');
  await assert.rejects(
    () => findStoredIdl(missing, PROGRAM),
    (error) => {
      assert.equal(error.code, 'no-sememe-store', `library answer must carry the code: ${error.message}`);
      assert.equal(error.answer, true, 'and the answer mark');
      assert.equal(error.fix, undefined, 'and no repair');
      assert.equal(error.message, `no sememe store at ${missing}: run "sememe pull" first`, 'verbatim');
      return true;
    },
  );
  await assert.rejects(
    () => findStoredIdl(intact, OTHER_PROGRAM),
    (error) => {
      assert.equal(error.code, 'no-stored-idl', `library answer must carry the code: ${error.message}`);
      assert.equal(error.answer, true, 'and the answer mark');
      return true;
    },
  );
});

// --- the committed measurement -----------------------------------------------

test('the committed measurement is the one the tool produces, and its baseline really had the defect', () => {
  const artifact = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'research', 'answer-voice-2026-11-17.json'), 'utf8'));
  assert.equal(artifact.verdictName, 'answer-voice-closed', 'the verdict must be closed');
  assert.equal(artifact.verdict.preFixUnnamedFaces, 6,
    'all six faces must have been unnamed pre-fix: a baseline with no defect makes the fix unmeasurable');
  assert.equal(artifact.verdict.fixedUnnamedFaces, 0, 'every answer must carry its code');
  assert.equal(artifact.verdict.fixedUnmarkedFaces, 0, 'every answer must carry `answer: true`');
  assert.equal(artifact.verdict.fixedRepairedFaces, 0, 'no answer may carry a repair');
  assert.equal(artifact.verdict.fixedWrongChannelFaces, 0, 'no answer may leave exit 1');
  assert.equal(artifact.verdict.fixedWrongSentenceFaces, 0, 'no answer may change its sentence');
  assert.equal(artifact.verdict.controlRegression, 0, 'no control may change verdict');
  assert.equal(artifact.hostPathLeak, 0, 'research/ is committed — no host path in it');
  assert.equal(artifact.tempPathLeak, 0, 'and no absolute temp path either');
});
