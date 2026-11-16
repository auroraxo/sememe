// test/file-input-voice.test.mjs — A CALLER'S WRONG PATH MUST BE REFUSED IN
// THE PRODUCT'S OWN VOICE, ON THE RIGHT CHANNEL.
//
// MEASURED (2026-11-16, this host, the PUBLISHED sememe@0.4.30 installed
// into an empty app, and reproduced against pre-fix tree 3ef9ca8):
//
// A caller names a FILE — the interface to adopt, the transaction to check,
// the lock to verify against, the file to write the lock to. When that path
// is wrong the product answered with the KERNEL's error, verbatim:
//
//   sememe conform /tmp/nope.json --store ./store
//     -> {"error":"ENOENT: no such file or directory, open '/tmp/nope.json'"}
//        exit 1
//
// Three faults in that one answer, each of them measured:
//
//   D1  NO NAME: a syscall's prose — no code for a script to branch on.
//   D2  NO SUBJECT: `conform` did not say WHICH argument was bad.
//   D3  WRONG CHANNEL: a mistyped path shared exit 1 with a real refusal
//       (a drifted store, a tampered receipt), so a CI script could not
//       tell "you pointed me at nothing" from "your store drifted".
//
// The product had already closed every other refusal class — flags
// (src/cli-surface.mjs), stores and receipts (src/store-read.mjs), lock
// documents (src/lock.mjs). The caller-named FILE was the last one speaking
// raw kernel, and it is the first thing a new user gets wrong.
//
// THE CONTRACT (src/file-input.mjs is the ONE classifier):
//
//   C1  every caller-named file refusal carries a PRODUCT CODE naming the
//       subject and the reason: <command>-file-<reason>.
//   C2  no refusal echoes the kernel: the errno string is INPUT, never
//       output.
//   C3  every refusal names a REPAIR the operator can run.
//   C4  an IO failure — nothing was read, nothing ran — travels on the
//       usage/IO channel (exit 2), NOT on exit 1.
//   C5  a file that IS there but holds the wrong CONTENT keeps the work
//       channel (exit 1): the work ran and found the wrong bytes, and that
//       is a different fact from "there was no file".
//   C6  the controls are untouched: a real interface file still adopts, a
//       real transaction file still gets conformance-checked, a lock still
//       writes and verifies.
//
// The pre-fix numbers are pinned by the committed artifact
// (research/file-input-voice-2026-11-16.json, produced by
// tools/measure-file-input-voice.mjs): 10 of 12 faces leaked a raw errno on
// the pre-fix tree; 0 do here.

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
const TX = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');
const IDL = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

const ERRNO_STRINGS = [
  'ENOENT', 'EISDIR', 'EACCES', 'ENOTDIR', 'EPERM', 'ELOOP',
  'no such file or directory', 'illegal operation on a directory',
  'permission denied', 'not a directory',
];

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { exit: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** The product's refusal as a script sees it: a JSON object with code+fix. */
function refusal(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.out.trim()); } catch { parsed = null; }
  return {
    exit: result.exit,
    code: parsed?.code ?? null,
    fix: parsed?.fix ?? null,
    // The errno scan looks at the ERROR FIELD ONLY: refusal and repair share
    // one line, and a repair that reads like strerror must not count.
    leakedErrno: ERRNO_STRINGS.filter((n) => String(parsed?.error ?? result.out).includes(n)),
    out: result.out,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-file-voice-'));
const missing = path.join(tmp, 'absent.json');
const directory = path.join(tmp, 'a-directory');
fs.mkdirSync(directory, { recursive: true });
const notJson = path.join(tmp, 'not-json.txt');
fs.writeFileSync(notJson, 'not json at all');
const unreadable = path.join(tmp, 'unreadable.json');
fs.writeFileSync(unreadable, '{"instructions":[]}');
fs.chmodSync(unreadable, 0o000);
// Restored in the last test: the temp tree cannot be removed otherwise.
test.after(() => {
  try { fs.chmodSync(unreadable, 0o600); } catch { /* already gone */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const IO_FACES = [
  ['adoptMissing', ['adopt', PROGRAM, missing, '--store', path.join(tmp, 's1')], 'adopt-file-missing'],
  ['adoptDirectory', ['adopt', PROGRAM, directory, '--store', path.join(tmp, 's2')], 'adopt-file-not_a_file'],
  ['adoptUnreadable', ['adopt', PROGRAM, unreadable, '--store', path.join(tmp, 's3')], 'adopt-file-unreadable'],
  ['conformMissing', ['conform', missing, '--store', STORE], 'conform-file-missing'],
  ['conformDirectory', ['conform', directory, '--store', STORE], 'conform-file-not_a_file'],
  ['conformUnreadable', ['conform', unreadable, '--store', STORE], 'conform-file-unreadable'],
  ['lockOutDirectory', ['lock', '--store', STORE, '--out', directory], 'lock-file-not_a_file'],
  ['verifyMissing', ['verify', '--store', STORE, '--lock', missing], 'lock-file-missing'],
  ['verifyDirectory', ['verify', '--store', STORE, '--lock', directory], 'lock-file-not_a_file'],
  ['verifyUnreadable', ['verify', '--store', STORE, '--lock', unreadable], 'lock-file-unreadable'],
];

for (const [name, args, expectedCode] of IO_FACES) {
  test(`C1/C2/C3/C4 — ${name}: named, kernel-free, repaired, exit 2`, () => {
    const face = refusal(run(args));
    assert.equal(face.code, expectedCode, `the refusal must carry its product code (got ${face.code}); output: ${face.out.slice(0, 300)}`);
    assert.deepEqual(face.leakedErrno, [], `the refusal must not echo the kernel: ${face.leakedErrno}`);
    assert.ok(face.fix && /^fix: /.test(face.fix), `the refusal must name a repair (got ${face.fix})`);
    assert.equal(face.exit, 2, `an IO refusal is the usage/IO channel, not the work channel (exit ${face.exit})`);
  });
}

test('C1/D2 — the refusal names the SUBJECT, so the operator knows which argument was wrong', () => {
  const face = refusal(run(['conform', missing, '--store', STORE]));
  assert.match(face.out, /transaction file/, 'conform must say it was the transaction file');
  assert.match(face.out, new RegExp(path.basename(missing)), 'the refusal must quote the path it was given');
  const lock = refusal(run(['verify', '--store', STORE, '--lock', missing]));
  assert.match(lock.out, /lock file/, 'verify must say it was the lock file');
});

test('C5 — a file that is there but holds the wrong content keeps the WORK channel', () => {
  const conform = refusal(run(['conform', notJson, '--store', STORE]));
  assert.equal(conform.code, 'conform-file-not_json', `got ${conform.code}: ${conform.out.slice(0, 200)}`);
  assert.equal(conform.exit, 1, 'the work ran and found wrong bytes — that is exit 1, not exit 2');
  assert.deepEqual(conform.leakedErrno, [], 'the parser detail is not an errno leak');
  assert.ok(conform.fix, 'a content refusal is still repaired');

  const adopt = refusal(run(['adopt', PROGRAM, notJson, '--store', path.join(tmp, 's4')]));
  assert.equal(adopt.code, 'adopt-file-not_json', `got ${adopt.code}: ${adopt.out.slice(0, 200)}`);
  assert.equal(adopt.exit, 1, 'adopt of a non-JSON file is the work channel');
  assert.ok(adopt.fix, 'and it is repaired too');
});

test('C6 — the controls are untouched: adopt, conform and lock still work', () => {
  const adopt = run(['adopt', PROGRAM, IDL, '--store', path.join(tmp, 'store-ok')]);
  assert.equal(adopt.exit, 0, `adopt of a real interface file must succeed: ${adopt.out.slice(0, 300)}`);
  assert.ok(fs.existsSync(path.join(tmp, 'store-ok', 'receipts')), 'the receipt must be stored');

  const conform = run(['conform', TX, '--store', STORE]);
  assert.match(conform.out, /byVerdict|instructions/, `conform over a real transaction must answer: ${conform.out.slice(0, 300)}`);

  const lockOut = path.join(tmp, 'sememe.lock');
  const lock = run(['lock', '--store', STORE, '--out', lockOut]);
  assert.equal(lock.exit, 0, `lock --out to a real path must succeed: ${lock.out.slice(0, 300)}`);
  assert.ok(fs.existsSync(lockOut), 'the lock file must be written');
  const verify = run(['verify', '--store', STORE, '--lock', lockOut]);
  assert.equal(verify.exit, 0, `verify over what it wrote must pass: ${verify.out.slice(0, 300)}`);
});

test('the committed measurement is the one the tool produces, and its baseline really had the defect', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'file-input-voice-2026-11-16.json'), 'utf8'));
  assert.equal(artifact.verdictName, 'file-input-voice-closed', 'the verdict must be closed');
  assert.equal(artifact.verdict.preFixLeakedErrno, 10, 'the pre-fix tree must have leaked: a baseline with no defect makes the fix unmeasurable');
  assert.equal(artifact.verdict.fixedLeakedErrno, 0, 'the fixed tree must leak nothing');
  assert.equal(artifact.verdict.fixedWrongChannelFaces, 0, 'no IO refusal may travel on exit 1');
  assert.equal(artifact.verdict.controlRegression, 0, 'no control may change verdict');
  assert.equal(artifact.hostPathLeak, 0, 'research/ is committed — no host path in it');
});

test('G1 — a NONEXISTENT LOCK through the library is still refused, and by name', async () => {
  const { readLock } = await import('../src/lock.mjs');
  await assert.rejects(
    () => readLock(path.join(tmp, 'no-such-lock.json')),
    (error) => {
      assert.equal(error.code, 'lock-file-missing', `library refusal must carry the code: ${error.message}`);
      assert.equal(error.exitCode, 2, 'and its channel');
      return true;
    },
  );
});

test('G2 — the classifier is the ONE place: every minted code parses as a file-input code', async () => {
  const { isFileInputCode, fileInputRefusal } = await import('../src/file-input.mjs');
  for (const [, , code] of IO_FACES) {
    assert.ok(isFileInputCode(code), `${code} must be recognisable as a file-input refusal`);
  }
  assert.ok(isFileInputCode('adopt-file-not_json'), 'the content faces are minted by the same classifier');
  assert.ok(!isFileInputCode('no-sememe-store'), 'the store refusal is NOT this class — it is the work channel');
  assert.ok(!isFileInputCode('lock-v1-parse'), 'and neither is the lock document\'s own reason');
  const refusal = fileInputRefusal({ label: 'conform', subject: 'transaction file', filePath: '/x/y.json', kind: 'missing' });
  assert.equal(refusal.exitCode, 2, 'an IO refusal defaults to the usage/IO channel');
  assert.match(refusal.message, /\/x\/y\.json/, 'and it quotes the path it was given');
});

test("G3 — the flag-usage channel is unchanged: a typo'd flag is still plain text, exit 2", () => {
  const result = run(['decode', PROGRAM, '00', '--stro', path.join(tmp, 'store')]);
  assert.equal(result.exit, 2, 'usage stays on exit 2');
  assert.ok(!result.out.trim().startsWith('{'), 'a UsageError stays plain text, as documented in bin/sememe.mjs');
  assert.match(result.out, /--store/, 'and still names the supported flag');
});
