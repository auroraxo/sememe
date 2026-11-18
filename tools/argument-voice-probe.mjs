#!/usr/bin/env node
// tools/argument-voice-probe.mjs — DOES A CALLER WHO FORGETS AN ARGUMENT GET
// THE PRODUCT'S VOICE, OR A CODELESS, REPAIRLESS ANSWER ON THE WORK CHANNEL?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix). It spawns THAT
// tree's bin/sememe.mjs and reads nothing else about the tree. Nothing here
// asserts a verdict about which tree is right — tools/measure-argument-voice.mjs
// derives the verdict from the two runs.
//
// THE DEFECT (measured 2026-11-18, this tree at 55a5114 = published 0.4.37;
// the same faces were observed verbatim on the published package):
//
//   sememe decode
//     -> {"error":"decode needs a program id"} exit 1
//   sememe decode <program>
//     -> {"error":"decode needs an instruction payload"} exit 1
//   sememe decode --trailing bogus <program> <payload>
//     -> {"error":"--trailing must be \"report\" or \"error\""} exit 1
//   sememe pull
//     -> {"error":"pull needs a program id"} exit 1
//
// Every other input sememe touches had learned to refuse by name — the flag
// (src/cli-surface.mjs), the file (file-input), the store directory
// (store-input), the damage inside it (store-damage), the lock gate
// (lock-voice), the answers (answer-voice), the endpoint (acquire-voice) —
// but the ARGUMENTS THE CALLER FORGOT were the one input class still
// answering as bare prose: no code, no repair, and the caller's mistake
// sharing exit 1 with the work's own failures (a drifted store, a tampered
// receipt), so a CI script cannot tell "you called me wrong" from "the work
// failed" without parsing prose.
//
// FACES (each names the argument and the command in the code):
//   pullMissingId            pull — the program id argument is missing
//   gapMissingId             gap — the program id argument is missing
//   adoptMissingId           adopt — the program id argument is missing
//   adoptMissingFile         adopt <program> — the interface file is missing
//   decodeMissingId          decode — the program id is missing
//   decodeMissingPayload     decode <program> — the payload is missing
//   decodeTrailingBadValue   decode --trailing <bogus>
//   decodeAbsentBadValue     decode --absent <bogus>
//   conformMissingFile       conform — the transaction file is missing
//   decodeNativeTrailingBadValue  decode-native --trailing <bogus>
//   decodeTokenTrailingBadValue   decode-token --trailing <bogus>
//   decodeRaydiumTrailingBadValue decode-raydium --trailing <bogus>
//   decodeAtaTrailingBadValue     decode-ata --trailing <bogus>
//   decodeNativeMissingId    decode-native — the program id is missing
//   decodeNativeMissingPayload  decode-native <program> — the payload is missing
//   decodeTokenMissingId     decode-token — the program id is missing
//   decodeTokenMissingPayload   decode-token <program> — the payload is missing
//   decodeRaydiumMissingId   decode-raydium — the program id is missing
//   decodeRaydiumMissingPayload  decode-raydium <program> — the payload is missing
//   decodeAtaMissingId       decode-ata — the program id is missing
//   decodeAtaMissingPayload  decode-ata <program> — neither payload nor --empty
//   decodeAtaBothPayloads    decode-ata <program> <payload> --empty
//   accountMissingId         account — the program id is missing
//   accountMissingData       account <program> — the account data is missing
//   accountTrailingBadValue  account --trailing <bogus>
//   verifyModeBadValue       verify --mode <bogus>
//   conformOnlyBadValue      conform <tx> --only <not-a-program-id>
//
// CONTROLS (they must answer the SAME way in both trees — a fix that breaks
// the paths that already work is a regression, and the measurement says so):
//   absentHelpOk             sememe absent-help still exits 0
//   nativeProvenanceOk       sememe native-provenance still exits 0
//   ataEmptyOk               decode-ata <ATA id> --empty still exits 0
//   conformOnlyValid         conform <tx> --only <real program id> still
//                            reaches the store answer (exit 1, no-sememe-store)
//   conformOnlyMissingValue  conform --only without a value keeps the USAGE
//                            voice (exit 2, "missing value for --only")
//
// OBSERVED FIELDS PER CASE: exit, hasCode, hasFix, stderr — enough for the
// tool to count unnamed / repairless / wrong-channel faces without
// interpreting prose.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BIN = path.join(HERE, '..', 'bin', 'sememe.mjs');
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYS = '11111111111111111111111111111111';

// A minimal valid transaction envelope: enough shape for the conformance
// gate to run, so --only faces exercise the filter, not the transaction
// parser. No store is contacted for the filter refusal.
const txPath = path.join(os.tmpdir(), `sememe-arg-voice-tx-${process.pid}.json`);
fs.writeFileSync(txPath, JSON.stringify({
  transaction: {
    message: {
      accountKeys: [SYS],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 0, accounts: [], data: '' }],
    },
    meta: { err: null },
  },
}));

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: HERE, encoding: 'utf8', timeout: 120000 });
  return { exit: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function face(args) {
  const r = run(args);
  let doc = null;
  try { doc = JSON.parse(r.stderr.trim()); } catch { doc = null; }
  return {
    exit: r.exit,
    hasCode: !!(doc && typeof doc.code === 'string' && doc.code),
    hasFix: !!(doc && typeof doc.fix === 'string' && String(doc.fix).startsWith('fix: ')),
    stderr: r.stderr.trim().slice(0, 400),
  };
}

const caseArgs = {
  pullMissingId: ['pull'],
  gapMissingId: ['gap'],
  adoptMissingId: ['adopt'],
  adoptMissingFile: ['adopt', SYS],
  decodeMissingId: ['decode'],
  decodeMissingPayload: ['decode', SYS],
  decodeTrailingBadValue: ['decode', SYS, '00', '--trailing', 'bogus'],
  decodeAbsentBadValue: ['decode', SYS, '00', '--absent', 'bogus'],
  conformMissingFile: ['conform'],
  decodeNativeTrailingBadValue: ['decode-native', SYS, '00', '--trailing', 'bogus'],
  decodeTokenTrailingBadValue: ['decode-token', SYS, '00', '--trailing', 'bogus'],
  decodeRaydiumTrailingBadValue: ['decode-raydium', SYS, '00', '--trailing', 'bogus'],
  decodeAtaTrailingBadValue: ['decode-ata', ATA, '00', '--trailing', 'bogus'],
  decodeNativeMissingId: ['decode-native'],
  decodeNativeMissingPayload: ['decode-native', SYS],
  decodeTokenMissingId: ['decode-token'],
  decodeTokenMissingPayload: ['decode-token', SYS],
  decodeRaydiumMissingId: ['decode-raydium'],
  decodeRaydiumMissingPayload: ['decode-raydium', SYS],
  decodeAtaMissingId: ['decode-ata'],
  decodeAtaMissingPayload: ['decode-ata', ATA],
  decodeAtaBothPayloads: ['decode-ata', ATA, '00', '--empty'],
  accountMissingId: ['account'],
  accountMissingData: ['account', SYS],
  accountTrailingBadValue: ['account', SYS, 'AA==', '--trailing', 'bogus'],
  verifyModeBadValue: ['verify', '--mode', 'bogus'],
};

const controlArgs = {
  absentHelpOk: ['absent-help'],
  nativeProvenanceOk: ['native-provenance'],
  ataEmptyOk: ['decode-ata', ATA, '--empty'],
  // A relative --store keeps this control's answer identical in both trees
  // (the pre-fix tree runs from a different temp directory) and free of
  // this host's home path — research/ is committed.
  conformOnlyValid: ['conform', txPath, '--store', './arg-voice-store', '--only', SYS],
  conformOnlyMissingValue: ['conform', txPath, '--only'],
};

const cases = {};
for (const [name, args] of Object.entries(caseArgs)) cases[name] = face(args);
const controls = {};
for (const [name, args] of Object.entries(controlArgs)) controls[name] = face(args);
fs.rmSync(txPath, { force: true });

process.stdout.write(JSON.stringify({ cases, controls }, null, 2));
