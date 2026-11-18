#!/usr/bin/env node
// tools/acquire-voice-probe.mjs — DOES THE ACQUISITION SURFACE (pull/gap
// against a failing RPC) ANSWER IN THE PRODUCT'S VOICE, OR IN THE KERNEL'S?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix) and on the
// PUBLISHED channel. It starts a LOCAL TLS mock RPC (no network, no real
// endpoint), spawns THAT tree's bin/sememe.mjs, and reads only what the
// operator would read: exit code, stdout, stderr. Nothing here asserts which
// tree is right — the tool that runs the probe derives the verdict from runs.
//
// THE DEFECT THIS MEASURES (measured 2026-11-17, this host, pre-fix tree
// af0a8d2, reproduced by hand against every failure mode before this file):
//
// Every other classifier in the product names its refusals — the path
// (file-input), the store path (store-input), store damage (store-damage),
// the lock gate (lock-voice), the answers (store-answer). The ONE surface
// that was never classified is the network the caller pointed at. Every
// failure of `sememe pull` / `sememe gap` reaches the operator as:
//
//   sememe pull <program> --store <dir> --rpc <failing endpoint>
//     -> {"error":"RPC unavailable: HTTP 429"}            exit 1
//     -> {"error":"RPC unavailable: HTTP 500"}            exit 1
//     -> {"error":"RPC unavailable: fetch failed"}        exit 1
//     -> {"error":"RPC unavailable: Unexpected token 'o',
//         "not json at all" is not valid JSON"}           exit 1
//     -> {"error":"RPC unavailable: RPC error -32602"}    exit 1
//     -> {"error":"RPC unavailable: malformed RPC response"} exit 1
//
// Three faults, the same three the other classifiers ended:
//   1. NO NAME — no code a script can branch on. A rate limit (retry later),
//      an outage (retry later), a wrong endpoint URL (fix the flag) and a
//      garbage response (fix the endpoint) share one anonymous shape, so a
//      pipeline cannot decide between "retry" and "you are using it wrong".
//   2. NO SUBJECT — which RPC endpoint failed, and why, lives only in prose.
//   3. THE WRONG VOCABULARY — undici's own text ("fetch failed", the JSON
//      parser's exact words, the transport's cause) quoted verbatim, the
//      JSON-RPC error object's MESSAGE dropped (only its numeric code kept).
//
// Cases (every one a failure the CALLER's --rpc pointed at — these are
// USAGE-class refusals by contract: nothing ran, the endpoint was wrong or
// unreachable, so exit 2 after the fix; they share exit 1 today only because
// nothing named them):
//   rpcHttp403        endpoint answers 403 (the crates.io-403 lesson)
//   rpcHttp429        endpoint answers 429 with retry-after
//   rpcHttp500        endpoint answers 500
//   rpcGarbageBody    endpoint answers 200 with a non-JSON body
//   rpcJsonError      endpoint answers a JSON-RPC error object
//   rpcShortResult    endpoint answers 200 JSON with the wrong value shape
//   rpcUnreachable    nothing listens on the endpoint (ECONNREFUSED)
//   rpcNotHttps       caller passes an http:// RPC URL
//   rpcBadProgramId   caller passes a program id that is not base58
//
// The CONTROLS (they must behave the SAME in both trees):
//   pullOk            a healthy endpoint still pulls a receipt (exit 0)
//   gapUnknownHolds   `gap` keeps its unknown-verdict contract: RPC failure
//                     is verdict=unknown, exit 3, never absence (pinned by
//                     test/acquisition-gap.test.mjs T4 — the fix must not
//                     swallow it)
//   storeAnswerVoice  `decode` against a missing store still answers
//                     no-sememe-store (the OTHER voice must not regress)
//   flagVoice         an unknown flag is still the flag voice, exit 2
//                     (the new classifier must not swallow usage)
//
// WHAT WOULD FALSIFY THE FIX (counted by the tool, nothing hand-written):
//   * preFixUnnamedFaces / fixedUnnamedFaces — refusal without a product
//     code. Expected LARGE before, must be 0 after.
//   * preFixRepairlessFaces / fixedRepairlessFaces — refusal without a fix.
//     Expected LARGE before, must be 0 after.
//   * fixedWrongChannelFaces — a usage-class acquisition refusal must be
//     exit 2 (nothing ran), pullOk exit 0, gapUnknown exit 3. Must be 0.
//   * controlRegression — a control changed verdict between trees. Must be 0.
//   * hostPathLeak — the artifact quotes this host's paths. Must be 0.
//
// Exit codes: 0 the probe ran; 3 NO VERDICT (the tree could not run).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SEMEME_PROBE_ROOT
  ? path.resolve(process.env.SEMEME_PROBE_ROOT)
  : path.resolve(HERE, '..');

const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const IDL_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');

// A throwaway self-signed CA for the LOCAL mock only: the probe writes it to
// a temp file and points NODE_EXTRA_CA_CERTS at it, so the real endpoint
// trust store is never touched. No key or cert is committed.
const MOCK_CA_CERT = process.env.SEMEME_PROBE_CA_CERT;
const MOCK_CA_KEY = process.env.SEMEME_PROBE_CA_KEY;

const FACES = [
  'rpcHttp403', 'rpcHttp429', 'rpcHttp500', 'rpcGarbageBody',
  'rpcJsonError', 'rpcShortResult', 'rpcUnreachable', 'rpcNotHttps',
  'rpcBadProgramId',
];
const CONTROLS = ['pullOk', 'gapUnknownHolds', 'storeAnswerVoice', 'flagVoice'];

if (!existsSync(BIN)) { console.error('no bin/sememe.mjs in this tree'); process.exit(3); }

// The mock RPC is LOCAL and throwaway: the pair may be supplied by the
// measurement tool (SEMEME_PROBE_CA_CERT / SEMEME_PROBE_CA_KEY) or — when
// nobody supplied one (the published pin re-derives the artifact inside a
// plain `npm test`, CI included) — generated here with openssl into a temp
// directory that dies with this process. No key or cert is committed, and a
// caller without the env vars still gets the same measurement.
const caWork = mkdtempSync(path.join(os.tmpdir(), 'sememe-probe-ca-'));
const GENERATED_CA_CERT = path.join(caWork, 'cert.pem');
const GENERATED_CA_KEY = path.join(caWork, 'key.pem');
process.on('exit', () => { try { rmSync(caWork, { recursive: true, force: true }); } catch { /* temp */ } });

function resolveCa() {
  if (MOCK_CA_CERT && MOCK_CA_KEY && existsSync(MOCK_CA_CERT) && existsSync(MOCK_CA_KEY)) {
    return { cert: MOCK_CA_CERT, key: MOCK_CA_KEY };
  }
  const res = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', GENERATED_CA_KEY, '-out', GENERATED_CA_CERT,
    '-days', '3650', '-subj', '/CN=sememe-local-mock',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8' });
  if (res.status !== 0 || !existsSync(GENERATED_CA_CERT) || !existsSync(GENERATED_CA_KEY)) {
    console.error('no SEMEME_PROBE_CA_CERT / SEMEME_PROBE_CA_KEY and openssl could not generate one'
      + (res.stderr ? `: ${String(res.stderr).slice(-200)}` : ''));
    process.exit(3);
  }
  return { cert: GENERATED_CA_CERT, key: GENERATED_CA_KEY };
}
const ca = resolveCa();
if (!existsSync(IDL_FIXTURE)) { console.error('missing test/fixtures/whirlpool-idl.json'); process.exit(3); }

const storeRoot = mkdtempSync(path.join(os.tmpdir(), 'sememe-acquire-probe-'));
const caFile = path.join(storeRoot, 'mock-ca.pem');
writeFileSync(caFile, readFileSync(ca.cert));

// The HEALTHY endpoint must answer with a REAL anchor-format account, or the
// pullOk control would measure the "no verified on-chain IDL" refusal instead
// of a successful pull. The account is built from the committed fixture, in
// the same on-disk shape src/acquire.mjs decodes.
let healthyAccountCache = null;
function healthyAnchorAccount() {
  if (healthyAccountCache) return healthyAccountCache;
  const idl = JSON.parse(readFileSync(IDL_FIXTURE, 'utf8'));
  const body = deflateSync(Buffer.from(JSON.stringify(idl)));
  const header = Buffer.alloc(44);
  Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]).copy(header);
  header.writeUInt32LE(body.length, 40);
  healthyAccountCache = {
    owner: PROGRAM,
    data: [Buffer.concat([header, body]).toString('base64'), 'base64'],
  };
  return healthyAccountCache;
}

const mockRpc = (mode) => {
  const responder = (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    };
    switch (mode) {
      case 'http403': return send(403, 'forbidden');
      case 'http429': return send(429, 'slow down', { 'retry-after': '30' });
      case 'http500': return send(500, 'boom');
      case 'garbage': return send(200, 'not json at all\n');
      case 'jsonError': return send(200, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'node is behind, please try a healthy node' } }));
      case 'shortResult': return send(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 5 }, value: [] } }));
      default: return send(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 424242 }, value: [null, healthyAnchorAccount()] } }));
    }
  };
  return new Promise((resolve) => {
    const srv = https.createServer({ key: readFileSync(ca.key), cert: readFileSync(ca.cert) }, responder);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
};

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile, ...env },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exit: code, stdout, stderr });
    });
  });
}

const parseStderr = (stderr) => {
  try { return JSON.parse(stderr.trim()); } catch { return null; };
};

function record(result) {
  const json = parseStderr(result.stderr);
  const error = json?.error ?? (result.exit === 2 ? result.stderr.trim().split('\n')[0] : '');
  return {
    exit: result.exit,
    error,
    code: json?.code ?? null,
    fix: json?.fix ?? null,
    answer: json?.answer ?? null,
    stdoutHead: result.stdout.slice(0, 200),
  };
}

async function main() {
  const cases = {};
  const store = path.join(storeRoot, 'store');

  // --- the failure cases, each against its own mock endpoint ---------------
  const modes = {
    rpcHttp403: 'http403', rpcHttp429: 'http429', rpcHttp500: 'http500',
    rpcGarbageBody: 'garbage', rpcJsonError: 'jsonError', rpcShortResult: 'shortResult',
    pullOk: 'healthy', gapUnknownHolds: 'http500',
  };
  const servers = {};
  for (const [face, mode] of Object.entries(modes)) servers[face] = await mockRpc(mode);
  const url = (face) => `https://127.0.0.1:${servers[face].address().port}/rpc`;

  try {
    cases.rpcHttp403 = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', url('rpcHttp403')]));
    cases.rpcHttp429 = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', url('rpcHttp429')]));
    cases.rpcHttp500 = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', url('rpcHttp500')]));
    cases.rpcGarbageBody = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', url('rpcGarbageBody')]));
    cases.rpcJsonError = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', url('rpcJsonError')]));
    cases.rpcShortResult = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', url('rpcShortResult')]));
    cases.rpcBadProgramId = record(await runCli(['pull', 'not-a-program-id', '--store', store, '--rpc', url('pullOk')]));
    cases.rpcNotHttps = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', 'http://127.0.0.1:1/rpc']));

    // Nothing listens on 127.0.0.1:1 — the transport itself refuses.
    cases.rpcUnreachable = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', 'https://127.0.0.1:1/rpc']));

    // --- controls ----------------------------------------------------------
    cases.pullOk = record(await runCli(['pull', PROGRAM, '--store', store, '--rpc', url('pullOk')]));
    cases.gapUnknownHolds = record(await runCli(['gap', PROGRAM, '--store', store, '--rpc', url('gapUnknownHolds')]));
    cases.storeAnswerVoice = record(await runCli(['decode', PROGRAM, 'AA==', '--store', path.join(storeRoot, 'no-such-store')]));
    cases.flagVoice = record(await runCli(['pull', PROGRAM, '--store', store, '--stor', 'x']));
  } finally {
    for (const srv of Object.values(servers)) srv.close();
  }

  const faceCases = Object.fromEntries(FACES.map((n) => [n, cases[n]]));
  const controlCases = Object.fromEntries(CONTROLS.map((n) => [n, cases[n]]));
  const out = { faces: FACES, controls: CONTROLS, cases: { ...faceCases, ...controlCases } };
  rmSync(storeRoot, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((error) => { console.error(String(error?.stack ?? error)); process.exit(3); });
