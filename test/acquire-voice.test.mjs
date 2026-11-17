// test/acquire-voice.test.mjs — pins the acquisition surface's refusals.
//
// RED on the pre-fix tree (af0a8d2) and on the PUBLISHED sememe@0.4.36:
// every RPC failure of `sememe pull` reached the operator as bare prose
// ("RPC unavailable: HTTP 429", "RPC unavailable: fetch failed", …) with no
// `code`, no repair, and the endpoint's own JSON-RPC message thrown away.
// This file pins the product contract that replaced it:
//
//   V1 every refusal carries a PRODUCT CODE (rpc-* / program-id-*);
//   V2 every refusal carries a repair;
//   V3 the channel follows what ran: exit 2 when no request was made
//      (non-https URL, bad program id), exit 1 when sememe DID dispatch the
//      request and the answer failed;
//   V4 the kernel's and third parties' words are input, never output;
//   V5 the endpoint's own message is the SUBJECT, not dropped;
//   V6 an answer never rides on a refusal and a repair never rides on an
//      answer.
//
// Measured by tools/measure-acquire-voice.mjs against a local TLS mock RPC
// (no network); the committed artifact is research/acquire-voice-2026-11-17.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpcRefusal, httpsRefusal, programIdRefusal, isAcquireCode } from '../src/acquire-voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const URL = 'https://rpc.example.invalid/rpc';

test('V1+V2: every RPC failure carries a product code and a repair', () => {
  const failures = [
    { kind: 'http', status: 429 },
    { kind: 'http', status: 403 },
    { kind: 'http', status: 500 },
    { kind: 'body' },
    { kind: 'shape', detail: 'answered JSON without the account entries sememe asked for' },
    { kind: 'rpc-error', rpcCode: -32005, rpcMessage: 'node is behind, please try a healthy node' },
    { kind: 'transport', cause: 'ECONNREFUSED' },
  ];
  for (const failure of failures) {
    const error = rpcRefusal(URL, failure);
    assert.ok(isAcquireCode(error.code), `no product code for ${failure.kind}: ${error.code}`);
    assert.match(error.fix, /^fix: /, `no repair for ${failure.kind}`);
    assert.ok(error.message.length > 0);
  }
});

test('V1: the codes are distinct per cause — a script can tell them apart', () => {
  const codes = new Set([
    rpcRefusal(URL, { kind: 'http', status: 429 }).code,
    rpcRefusal(URL, { kind: 'http', status: 403 }).code,
    rpcRefusal(URL, { kind: 'http', status: 500 }).code,
    rpcRefusal(URL, { kind: 'http', status: 418 }).code,
    rpcRefusal(URL, { kind: 'body' }).code,
    rpcRefusal(URL, { kind: 'shape' }).code,
    rpcRefusal(URL, { kind: 'rpc-error', rpcCode: -32005 }).code,
    rpcRefusal(URL, { kind: 'transport', cause: 'ECONNREFUSED' }).code,
  ]);
  assert.ok(codes.size >= 7, `codes collapse: ${[...codes].join(',')}`);
});

test('V3: the work channel stays exit 1 — sememe DID dispatch the request', () => {
  for (const failure of [
    { kind: 'http', status: 429 },
    { kind: 'http', status: 500 },
    { kind: 'body' },
    { kind: 'shape' },
    { kind: 'rpc-error', rpcCode: -32005 },
    { kind: 'transport', cause: 'ECONNREFUSED' },
  ]) {
    assert.equal(rpcRefusal(URL, failure).exitCode, 1);
  }
});

test('V3: the usage channel is exit 2 — no request was made at all', () => {
  assert.equal(httpsRefusal('http://rpc.example.invalid').exitCode, 2);
  assert.equal(programIdRefusal('invalid', 'is not a base58 program address').exitCode, 2);
});

test('V4: the third parties\' words never reach the operator', () => {
  const error = rpcRefusal(URL, { kind: 'transport', cause: 'ECONNREFUSED' });
  assert.doesNotMatch(error.message, /fetch failed|ECONNREFUSED/);
  assert.doesNotMatch(error.message, /Unexpected token|is not valid JSON/);
  assert.doesNotMatch(error.message, /Non-base58 character|Invalid public key input/);
  // …but the raw cause travels as STRUCTURED input, for scripts (V4).
  assert.equal(error.cause, 'ECONNREFUSED');
});

test('V5: the endpoint\'s own JSON-RPC message is the subject, not dropped', () => {
  const error = rpcRefusal(URL, { kind: 'rpc-error', rpcCode: -32005, rpcMessage: 'node is behind, please try a healthy node' });
  assert.match(error.message, /node is behind, please try a healthy node/);
  assert.match(error.message, /-32005/);
});

test('V6: a refusal never claims to be an answer', () => {
  const error = rpcRefusal(URL, { kind: 'http', status: 500 });
  assert.notEqual(error.answer, true);
});

test('the refusal names the endpoint the caller asked for', () => {
  const error = rpcRefusal(URL, { kind: 'http', status: 429 });
  assert.match(error.message, /rpc\.example\.invalid/);
});

// --- the committed measurement -----------------------------------------------

test('the committed measurement is the one the tool produces, and its baseline really had the defect', () => {
  const artifact = JSON.parse(readFileSync(
    path.join(ROOT, 'research', 'acquire-voice-2026-11-17.json'), 'utf8'));
  assert.equal(artifact.verdict, 'acquire-voice-closed', 'the verdict must be closed');
  assert.equal(artifact.preFixUnnamedFaces, 9,
    'all nine faces must have been unnamed pre-fix: a baseline with no defect makes the fix unmeasurable');
  assert.equal(artifact.preFixRepairlessFaces, 9,
    'all nine faces must have been repairless pre-fix');
  assert.equal(artifact.fixedUnnamedFaces, 0, 'every refusal must carry a product code');
  assert.equal(artifact.fixedRepairlessFaces, 0, 'every refusal must carry a repair');
  assert.equal(artifact.fixedWrongChannelFaces, 0,
    'the channel contract must hold: no request made -> exit 2, request dispatched -> exit 1');
  assert.equal(artifact.controlRegression, 0, 'no control may change verdict');
  assert.equal(artifact.hostPathLeak, false,
    'research/ is committed — an artifact that prints this host\'s paths must never be committed');
});
