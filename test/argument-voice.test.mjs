// test/argument-voice.test.mjs — A CALLER WHO FORGETS AN ARGUMENT IS REFUSED
// BY NAME, WITH A REPAIR, ON THE USAGE CHANNEL.
//
// WHAT THIS PINS (the defect, measured 2026-11-18, this host, pre-fix tree
// 55a5114 = published sememe@0.4.37):
//
// Every other input sememe touches had learned to refuse by name — the flag
// (src/cli-surface.mjs), the file (file-input), the store directory
// (store-input), the damage inside it (store-damage), the lock gate
// (lock-voice), the answers (store-answer), the endpoint (acquire-voice) —
// but the ARGUMENTS THE CALLER FORGOT were the one input class still
// answering as bare prose on the work channel:
//
//   sememe decode
//     -> {"error":"decode needs a program id"} exit 1
//   sememe decode <program>
//     -> {"error":"decode needs an instruction payload"} exit 1
//   sememe pull
//     -> {"error":"pull needs a program id"} exit 1
//
//   1. NO NAME — no code a script can branch on.
//   2. NO REPAIR — the sentence never says what to run.
//   3. THE WRONG CHANNEL — exit 1 is the channel the README documents for
//      "disagreement" (the store drifted, the receipt is tampered), so a CI
//      script could not tell "you called me wrong" from "the work failed".
//
// THE CONTRACT (src/argument-voice.mjs is the ONE mint place):
//   A1  every argument refusal carries a PRODUCT CODE that says WHICH
//       argument it is, and the codes are distinct per face.
//   A2  every argument refusal carries a repair (`fix: …`) naming the
//       command to run.
//   A3  the CHANNEL is exit 2 — the usage channel the product already
//       reserves for a call that cannot be what the caller meant (an
//       unknown flag, a flag given twice, a flag without a value all exit 2
//       today).
//   A4  the SENTENCE keeps the command's own words, verbatim, with the
//       code appended in parentheses — the sentences quoted by tests and
//       the README keep their place.
//   A5  nothing else moves: an ANSWER keeps exit 1 + `answer: true`, a
//       WORK refusal keeps exit 1, the flag surface keeps its own voice,
//       and `conform --only <not-a-program-id>` keeps the conformance
//       gate's channel (pinned by test/conformance-filter-domain.test.mjs).
//
// The pre-fix numbers are pinned by the committed artifact
// (research/argument-voice-2026-11-18.json, produced by
// tools/measure-argument-voice.mjs): all 26 faces were unnamed, repairless
// and on the work channel on the pre-fix tree (55a5114); 0/0/0 are here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYS = '11111111111111111111111111111111';
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// The classifier. On a pre-fix tree this module does not exist: the import
// failure must surface as the FAILING TESTS below (with their behavioural
// messages), not as a load-time crash of the whole file — the ladder has to
// be readable: mint tests red because the mint is missing, CLI tests red
// because the old bin still answers with bare prose, guards green on both
// trees.
let voice = null;
try {
  voice = await import('../src/argument-voice.mjs');
} catch {
  voice = null;
}

const requireVoice = (testName) => {
  assert.ok(voice, `${testName}: src/argument-voice.mjs is missing on this tree — the ONE mint place does not exist`);
};

function runCli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const stderr = String(result.stderr ?? '');
  let doc = null;
  try { doc = JSON.parse(stderr.trim()); } catch { doc = null; }
  return {
    exit: result.status,
    stderr,
    doc,
    code: doc && typeof doc.code === 'string' ? doc.code : null,
    fix: doc && typeof doc.fix === 'string' ? doc.fix : null,
    answer: doc?.answer === true,
    out: `${String(result.stdout ?? '')}${stderr}`,
  };
}

// A transaction fixture the conformance gate can actually read (the same one
// test/conformance-filter-domain.test.mjs uses), so the G5 guard exercises
// the FILTER and not the transaction parser.
const TX = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');

/** Every face, with the CLI invocation that must reach it and the code the
 *  mint must produce. The sentence pin is the command's OWN words as they
 *  were measured on the pre-fix tree. */
const FACES = [
  { key: 'pull:program-id', args: ['pull'], sentence: 'pull needs a program id' },
  { key: 'gap:program-id', args: ['gap'], sentence: 'gap needs a program id' },
  { key: 'adopt:program-id', args: ['adopt'], sentence: 'adopt needs a program id' },
  { key: 'adopt:interface-file', args: ['adopt', SYS], sentence: 'adopt needs the interface file to store' },
  { key: 'decode:program-id', args: ['decode'], sentence: 'decode needs a program id' },
  { key: 'decode:payload', args: ['decode', SYS], sentence: 'decode needs an instruction payload' },
  { key: 'decode:trailing', args: ['decode', SYS, '00', '--trailing', 'bogus'], sentence: '--trailing must be "report" or "error"' },
  { key: 'decode:absent', args: ['decode', SYS, '00', '--absent', 'bogus'], sentence: '--absent must be "error", "report" or "verified"' },
  { key: 'conform:transaction-file', args: ['conform'], sentence: 'conform needs a transaction JSON file' },
  { key: 'decode-native:trailing', args: ['decode-native', SYS, '00', '--trailing', 'bogus'], sentence: '--trailing must be "report" or "error"' },
  { key: 'decode-native:program-id', args: ['decode-native'], sentence: 'decode-native needs a program id' },
  { key: 'decode-native:payload', args: ['decode-native', SYS], sentence: 'decode-native needs an instruction payload' },
  { key: 'decode-token:trailing', args: ['decode-token', SYS, '00', '--trailing', 'bogus'], sentence: '--trailing must be "report" or "error"' },
  { key: 'decode-token:program-id', args: ['decode-token'], sentence: 'decode-token needs a program id' },
  { key: 'decode-token:payload', args: ['decode-token', SYS], sentence: 'decode-token needs an instruction payload' },
  { key: 'decode-raydium:trailing', args: ['decode-raydium', SYS, '00', '--trailing', 'bogus'], sentence: '--trailing must be "report" or "error"' },
  { key: 'decode-raydium:program-id', args: ['decode-raydium'], sentence: 'decode-raydium needs a program id' },
  { key: 'decode-raydium:payload', args: ['decode-raydium', SYS], sentence: 'decode-raydium needs an instruction payload' },
  { key: 'decode-ata:trailing', args: ['decode-ata', ATA, '00', '--trailing', 'bogus'], sentence: '--trailing must be "report" or "error"' },
  { key: 'decode-ata:program-id', args: ['decode-ata'], sentence: 'decode-ata needs a program id' },
  { key: 'decode-ata:payload', args: ['decode-ata', ATA], sentence: 'decode-ata needs an instruction payload' },
  { key: 'decode-ata:payload-conflict', args: ['decode-ata', ATA, '00', '--empty'], sentence: 'decode-ata: give a payload or --empty, not both' },
  { key: 'account:program-id', args: ['account'], sentence: 'account needs a program id' },
  { key: 'account:account-data', args: ['account', SYS], sentence: 'account needs the account data (base64 or hex)' },
  { key: 'account:trailing', args: ['account', SYS, 'AA==', '--trailing', 'bogus'], sentence: '--trailing must be "report" or "error"' },
  { key: 'verify:mode', args: ['verify', '--mode', 'bogus'], sentence: '--mode must be "error" or "warn"' },
];

// --- A1/A2: the ONE mint place ----------------------------------------------

test('A1: every argument face carries a distinct product code that names the argument', () => {
  requireVoice('A1');
  const codes = new Set();
  // The WHOLE table is checked, not just the probed subset: a row nobody
  // enumerates here is a row whose code collapse nobody would see.
  for (const [key, row] of Object.entries(voice.ARGUMENT_FACES)) {
    assert.ok(voice.isArgumentCode(row.code), `code ${row.code} (face ${key}) is not an argument-voice code`);
    assert.ok(['missing', 'invalid', 'conflict'].includes(row.kind), `${row.code}: kind must be missing/invalid/conflict, got ${row.kind}`);
    codes.add(row.code);
  }
  assert.equal(codes.size, Object.keys(voice.ARGUMENT_FACES).length,
    `codes collapse: ${Object.keys(voice.ARGUMENT_FACES).length} rows but ${codes.size} codes — a script could not tell WHICH argument was wrong`);
});

test('A1: the probed faces and the declared table are the same set — no declared face goes unmeasured', () => {
  requireVoice('A1 (coverage)');
  const declared = new Set(Object.keys(voice.ARGUMENT_FACES));
  const probed = new Set(FACES.map((f) => f.key));
  assert.deepEqual([...declared].filter((k) => !probed.has(k)), [],
    'declared but not probed: a face nobody measures');
  assert.deepEqual([...probed].filter((k) => !declared.has(k)), [],
    'probed but not declared: the CLI would mint nothing for it');
});

test('A2: every argument face carries a repair naming the command to run', () => {
  requireVoice('A2');
  for (const face of FACES) {
    const row = voice.ARGUMENT_FACES[face.key];
    assert.match(row.fix, /^pass |^the instruction/, `${face.key}: fix must start with an action, got "${row.fix}"`);
    assert.ok(/sememe |--trailing |--absent |--mode |--empty/.test(row.fix), `${face.key}: fix must name the command or flag to run: "${row.fix}"`);
  }
});

test('A3: the mint puts the refusal on the USAGE channel (exit 2), not the work channel', () => {
  requireVoice('A3');
  for (const face of FACES) {
    const error = voice.argumentRefusal(face.key);
    assert.equal(error.exitCode, 2, `${face.key}: a forgotten argument is a caller mistake, nothing ran -> exit 2`);
    assert.match(error.fix, /^fix: /, `${face.key}: the printed fix must carry the fix: prefix`);
    assert.equal(error.answer, undefined, `${face.key}: an argument refusal is not an answer`);
  }
});

test('A4: the sentence keeps the command\'s own words with the code appended', () => {
  requireVoice('A4');
  for (const face of FACES) {
    const row = voice.ARGUMENT_FACES[face.key];
    assert.equal(row.message, face.sentence,
      `${face.key}: the command's own sentence must stay verbatim — several tests and the README quote it`);
    const error = voice.argumentRefusal(face.key);
    assert.equal(error.message, `${face.sentence} (${row.code})`, `${face.key}: sentence in front, code in parentheses`);
  }
});

test('A4: an unknown face key is refused by the mint, never invented', () => {
  requireVoice('A4 (unknown face)');
  assert.throws(() => voice.argumentRefusal('decode:does-not-exist'), /unknown argument face/);
});

// --- A1-A3 at the CLI: the channel a script actually sees ---------------------

for (const face of FACES) {
  test(`CLI ${face.key}: named, repaired, usage channel`, () => {
    const res = runCli(face.args);
    assert.equal(res.exit, 2, `exit ${res.exit} (expected 2 — the usage channel). stderr: ${res.stderr.slice(0, 300)}`);
    const expected = voice?.ARGUMENT_FACES?.[face.key]?.code;
    assert.equal(res.code, expected,
      `code missing or wrong (expected ${expected} from the ONE table): ${res.stderr.slice(0, 300)}`);
    assert.match(res.fix, /^fix: /, `no repair: ${res.stderr.slice(0, 300)}`);
    assert.match(res.doc?.error ?? '', /\([a-z][a-z0-9-]*\)$/,
      'the printed sentence must end with its code in parentheses');
    assert.doesNotMatch(res.stderr, /\/home\/|\bENOENT\b|\bEISDIR\b|\bEACCES\b/, 'no host path, no kernel prose');
  });
}

// --- A5: nothing else moves ----------------------------------------------------

test('G1 GUARD: an unknown flag keeps the flag surface\'s voice (usage exit 2, plain text, closest flag)', () => {
  const res = runCli(['lock', '--store', './x', '--o', 'out.lock']);
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /unknown flag "--o"/);
  assert.match(res.stderr, /did you mean "--out"/);
});

test('G2 GUARD: an unknown command still dumps the usage text with exit 2', () => {
  const res = runCli(['totally-unknown-command']);
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /usage:/);
});

test('G3 GUARD: a flag without a value keeps the cli-surface voice (usage exit 2)', () => {
  const res = runCli(['conform', TX, '--only']);
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /missing value for --only/);
});

test('G4 GUARD: an ANSWER keeps exit 1 and answer:true — the argument fix must not move the answer channel', () => {
  const res = runCli(['decode', WHIRLPOOL, '00', '--store', './arg-voice-store']);
  assert.equal(res.exit, 1, `an answer is a state, not a usage error: ${res.stderr.slice(0, 300)}`);
  assert.equal(res.answer, true, `answer:true must survive: ${res.stderr.slice(0, 300)}`);
  assert.equal(res.code, 'no-sememe-store');
});

test('G5 GUARD: the conformance gate keeps ITS channel for --only <not-a-program-id> (exit 1, named reason)', () => {
  const res = runCli(['conform', TX, '--only', 'not-a-program-id']);
  assert.equal(res.exit, 1, `pinned by test/conformance-filter-domain.test.mjs — this pulse does not move it: ${res.stderr.slice(0, 300)}`);
  assert.match(res.stderr, /filter-is-not-a-program-id/);
  assert.match(res.stderr, /not-a-program-id/);
});

test('G6 GUARD: a surplus positional keeps the cli-surface voice (usage exit 2, the command\'s own words)', () => {
  const res = runCli(['lock', SYS, '--store', './x']);
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /lock takes no program id/);
});

// --- the committed measurement --------------------------------------------------

test('the committed measurement is the one the tool produces, and its baseline really had the defect', () => {
  const artifact = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'research', 'argument-voice-2026-11-18.json'), 'utf8'));
  assert.equal(artifact.verdictName, 'argument-voice-closed', 'the verdict must be closed');
  assert.equal(artifact.faces.length, 26, 'the instrument must ask all 26 faces');
  assert.equal(artifact.verdict.preFixUnnamedFaces, 26,
    'all 26 faces must have been unnamed pre-fix: a baseline with no defect makes the fix unmeasurable');
  assert.equal(artifact.verdict.preFixRepairlessFaces, 26,
    'all 26 faces must have been repairless pre-fix');
  assert.equal(artifact.verdict.preFixWrongChannelFaces, 26,
    'all 26 must have travelled on the work channel pre-fix');
  assert.equal(artifact.verdict.fixedUnnamedFaces, 0, 'every refusal must carry a product code');
  assert.equal(artifact.verdict.fixedRepairlessFaces, 0, 'every refusal must carry a repair');
  assert.equal(artifact.verdict.fixedWrongChannelFaces, 0,
    'the channel contract must hold: a caller mistake -> exit 2');
  assert.equal(artifact.verdict.controlRegression, 0, 'no control may change verdict');
  assert.equal(artifact.hostPathLeak, 0,
    'research/ is committed — an artifact that prints this host\'s paths must never be committed');
});
