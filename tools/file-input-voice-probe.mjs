#!/usr/bin/env node
// tools/file-input-voice-probe.mjs — DOES THE PRODUCT ANSWER A CALLER'S
// WRONG PATH IN ITS OWN VOICE, OR IN THE KERNEL'S?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix). It answers
// only observable questions about the tree it runs inside: it spawns THAT
// tree's bin/sememe.mjs and reads THAT tree's src/file-input.mjs. Nothing
// here asserts a verdict about which tree is right — the tool that runs this
// derives the verdict from the two runs.
//
// THE DEFECT THIS MEASURES (measured 2026-11-16, this host, the PUBLISHED
// sememe@0.4.30 installed into an empty app):
//
// A caller names a FILE — the interface to adopt, the transaction to check,
// the lock to verify against, the file to write the lock to. When that path
// is wrong, the product answered with the KERNEL's error, verbatim:
//
//   sememe conform /tmp/nope.json --store ./store
//     -> {"error":"ENOENT: no such file or directory, open '/tmp/nope.json'"}
//        exit 1
//
// The measured signature of the defect is a refusal that leaks the kernel:
// the raw errno STRING is present in the operator's output, the refusal
// carries NO product code, and the repair is absent.
//
// Cases (every one is a path the CALLER chose):
//   adoptMissing      adopt with a file that does not exist
//   adoptDirectory    adopt with a directory in place of the file
//   adoptUnreadable   adopt with a file the process may not read
//   adoptNotJson      adopt with a file that is there but holds no JSON
//   conformMissing    conform with a transaction file that does not exist
//   conformDirectory  conform with a directory in place of the file
//   conformUnreadable conform with a file the process may not read
//   conformNotJson    conform with a file that is there but holds no JSON
//   lockOutDirectory  lock --out pointing at a directory
//   verifyMissing     verify --lock naming a file that does not exist
//   verifyDirectory   verify --lock naming a directory
//   verifyUnreadable  verify --lock naming a file the process may not read
//
// The CONTROLS (they must behave the SAME in both trees — a fix that breaks
// the paths that were already correct is a regression, and the measurement
// must say so):
//   lockOutOk         lock --out writes a lock file that verifies afterwards
//   conformOk         conform over a real transaction file still answers
//   adoptOk           adopt of a real interface file still stores it
//
// WHAT WOULD FALSIFY THE FIX (counted directly by the tool):
//   * leakedErrnoFaces — a face whose refusal still carries a raw kernel
//     errno string. Must be 0 in the fixed tree.
//   * unnamedFaces    — a face whose refusal carries no product code. Must
//     be 0 in the fixed tree.
//   * repairlessFaces — a face whose refusal names no repair. Must be 0 in
//     the fixed tree.
//   * wrongChannelFaces — a face that travels on the wrong channel: an IO
//     refusal (nothing ran) must NOT share exit 1 with the work's own
//     failures, because a script cannot then tell "you pointed me at
//     nothing" from "your store drifted". Must be 0 in the fixed tree.
//   * controlRegression — a control changed its verdict between the trees.
//
// Exit codes: 0 the probe ran; 3 NO VERDICT (the tree could not be read).

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

if (!fs.existsSync(BIN)) { console.error('no bin/sememe.mjs in this tree'); process.exit(3); }

// The kernel's errno strings. A refusal that carries one of these is talking
// in the kernel's voice, not the product's.
const ERRNO_STRINGS = [
  'ENOENT', 'EISDIR', 'EACCES', 'ENOTDIR', 'EPERM', 'ELOOP',
  'no such file or directory', 'illegal operation on a directory',
  'permission denied', 'not a directory',
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-file-voice-probe-'));

function run(args, extra = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, ...extra,
  });
  return {
    exit: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/** The product's own refusal: a JSON error object on stderr carrying a code
 *  and a repair. Anything else (a bare errno, an empty output) is not one.
 *
 *  The errno scan looks at the ERROR FIELD ONLY, not the whole answer: the
 *  refusal and its repair share one line, and a repair that happens to read
 *  like strerror must not be counted as a leak. (First run caught exactly
 *  that: "pass a file path, not a directory" matched "not a directory" and
 *  reported the FIXED tree as leaking.) */
function refusalOf(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.stderr.trim()); } catch { parsed = null; }
  const message = parsed && typeof parsed.error === 'string' ? parsed.error : `${result.stderr}${result.stdout}`;
  const leaked = ERRNO_STRINGS.filter((needle) => message.includes(needle));
  return {
    exit: result.exit,
    code: parsed && typeof parsed.code === 'string' ? parsed.code : null,
    fix: parsed && typeof parsed.fix === 'string' ? parsed.fix : null,
    leakedErrno: leaked,
    text: `${result.stderr}${result.stdout}`.slice(0, 400),
  };
}

const cases = {};

function record(name, result) {
  cases[name] = refusalOf(result);
}

// --- the defect faces -------------------------------------------------------

const missing = path.join(tmpRoot, 'absent.json');
const directory = path.join(tmpRoot, 'a-directory');
fs.mkdirSync(directory, { recursive: true });
const notJson = path.join(tmpRoot, 'not-json.txt');
fs.writeFileSync(notJson, 'not json at all');
const unreadable = path.join(tmpRoot, 'unreadable.json');
fs.writeFileSync(unreadable, '{"instructions":[]}');
fs.chmodSync(unreadable, 0o000);

record('adoptMissing', run(['adopt', PROGRAM, missing, '--store', path.join(tmpRoot, 'store-a')]));
record('adoptDirectory', run(['adopt', PROGRAM, directory, '--store', path.join(tmpRoot, 'store-b')]));
record('adoptUnreadable', run(['adopt', PROGRAM, unreadable, '--store', path.join(tmpRoot, 'store-c')]));
record('adoptNotJson', run(['adopt', PROGRAM, notJson, '--store', path.join(tmpRoot, 'store-d')]));

record('conformMissing', run(['conform', missing, '--store', STORE]));
record('conformDirectory', run(['conform', directory, '--store', STORE]));
record('conformUnreadable', run(['conform', unreadable, '--store', STORE]));
record('conformNotJson', run(['conform', notJson, '--store', STORE]));

record('lockOutDirectory', run(['lock', '--store', STORE, '--out', directory]));

record('verifyMissing', run(['verify', '--store', STORE, '--lock', missing]));
record('verifyDirectory', run(['verify', '--store', STORE, '--lock', directory]));
record('verifyUnreadable', run(['verify', '--store', STORE, '--lock', unreadable]));

// --- the controls -----------------------------------------------------------

// lock --out into a real path, then verify what it wrote.
const lockOut = path.join(tmpRoot, 'sememe.lock');
const lockRun = run(['lock', '--store', STORE, '--out', lockOut]);
const lockWrote = fs.existsSync(lockOut);
const verifyRun = run(['verify', '--store', STORE, '--lock', lockOut]);
cases.lockOutOk = {
  exit: lockRun.exit,
  code: null,
  fix: null,
  leakedErrno: ERRNO_STRINGS.filter((n) => `${lockRun.stderr}${lockRun.stdout}`.includes(n)),
  lockWrote,
  verifyExit: verifyRun.exit,
  text: `${lockRun.stderr}${lockRun.stdout}`.slice(0, 400),
};

// conform over a real transaction file still answers with a report.
const conformRun = run(['conform', TX, '--store', STORE]);
cases.conformOk = {
  exit: conformRun.exit,
  code: null,
  fix: null,
  leakedErrno: ERRNO_STRINGS.filter((n) => `${conformRun.stderr}${conformRun.stdout}`.includes(n)),
  answered: conformRun.stdout.includes('byVerdict') || conformRun.stdout.includes('instructions'),
  text: `${conformRun.stderr}${conformRun.stdout}`.slice(0, 400),
};

// adopt of a real interface file still stores it.
const adoptStore = path.join(tmpRoot, 'store-ok');
const adoptRun = run(['adopt', PROGRAM, IDL, '--store', adoptStore]);
cases.adoptOk = {
  exit: adoptRun.exit,
  code: null,
  fix: null,
  leakedErrno: ERRNO_STRINGS.filter((n) => `${adoptRun.stderr}${adoptRun.stdout}`.includes(n)),
  stored: fs.existsSync(path.join(adoptStore, 'receipts')),
  text: `${adoptRun.stderr}${adoptRun.stdout}`.slice(0, 400),
};

console.log(JSON.stringify({ cases }, null, 2));

// Leave nothing behind: the unreadable file is 0000 on purpose, so the temp
// tree has to be put back before it can be removed.
try { fs.chmodSync(unreadable, 0o600); } catch { /* already gone */ }
fs.rmSync(tmpRoot, { recursive: true, force: true });
