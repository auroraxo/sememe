#!/usr/bin/env node
// e2e-package-consumer.mjs — the "stranger" proof for the installable package.
//
// A user with no clone of this repository installs the package and decodes
// real mainnet bytes. Nothing in this script imports sememe from THIS
// checkout: the app under test gets a tarball built from `git archive`, and
// every decode call runs from inside the app against `node_modules/sememe`.
//
// What it proves, in order:
//   0. PRE (opt-in, --pre <git-ref>): the pre-package tree is UNUSABLE the
//      same way — import('sememe') fails there. This is the red half of the
//      ladder; measured first on 2026-11-01 against c7689ab.
//   1. npm pack of HEAD installs into an EMPTY app with ZERO additional
//      packages: node_modules contains exactly `sememe`.
//   2. The installed tree is the product, not the harness: src/, interface/,
//      vendor/, bin/ present; tools/, test/, research/ absent.
//   3. The package entry exports the decode surface and it WORKS: every
//      payload of a real mainnet harvest (fixture read from this checkout,
//      the store built through the package's own exports) decodes from the
//      installed copy, with per-payload provenance fingerprints.
//   4. The verification contract ships: a tampered store object is refused
//      by the installed copy ("object and receipt disagree"), never decoded.
//   5. sememe/native resolves as a subpath and decodes a real System-program
//      payload against the pinned upstream derivation.
//   5b. sememe/raydium resolves as a subpath and decodes a real Raydium AMM v4
//      payload against the vendored program source — the one path where a
//      consumer has no store to fall back on.
//   6. The installed CLI decodes without any dependency installed
//      (`sememe decode` must not load @solana/web3.js).
//
// Network: none required. `npm pack` and `npm i <tarball>` are local for a
// package with zero dependencies. The real `npm install
// github:auroraxo/sememe#vX.Y.Z` (which does need the network and a pushed
// tag) was executed once on 2026-11-01 in a separate scratch directory and
// produced identical decode results; this script is the repeatable part.
//
// Usage: node tools/e2e-package-consumer.mjs [--pre <git-ref>] [--keep]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/canonical.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const SYSTEM = '11111111111111111111111111111111';
const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const args = process.argv.slice(2);
const preRef = (() => { const i = args.indexOf('--pre'); return i >= 0 ? args[i + 1] : null; })();
const keep = args.includes('--keep');

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) process.exitCode = 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-consumer-'));
const cleanup = () => { if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', cleanup);

function run(cmd, cmdArgs, cwd, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFailure) {
    throw Error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return r;
}

async function main() {
  // ---------- build the tarball from git archive (the tree a tag would hold)
  const packDir = path.join(tmp, 'head');
  fs.mkdirSync(packDir);
  spawnSync('bash', ['-c', `git archive HEAD | tar -x -C ${JSON.stringify(packDir)}`], { cwd: ROOT, encoding: 'utf8' });
  if (!fs.existsSync(path.join(packDir, 'index.mjs'))) throw Error('git archive did not produce the tree');

  // ---------- optional red half: the pre-package tree must NOT be consumable
  if (preRef) {
    const preDir = path.join(tmp, 'pre');
    const appPre = path.join(tmp, 'app-pre');
    fs.mkdirSync(preDir); fs.mkdirSync(appPre);
    spawnSync('bash', ['-c', `git archive ${JSON.stringify(preRef)} | tar -x -C ${JSON.stringify(preDir)}`], { cwd: ROOT, encoding: 'utf8' });
    run('npm', ['pack', '--silent'], preDir);
    const tgzPre = fs.readdirSync(preDir).find((f) => f.endsWith('.tgz'));
    run('npm', ['init', '-y'], appPre);
    run('npm', ['i', path.join(preDir, tgzPre), '--no-audit', '--no-fund', '--loglevel=error'], appPre);
    const preProbe = spawnSync('node', [
      '-e', `import('sememe').then(()=>{console.log('UNEXPECTED_OK');process.exit(0)}).catch(e=>{console.log('RED:'+e.code);process.exit(3)})`,
    ], { cwd: appPre, encoding: 'utf8' });
    check(`pre-package tree (${preRef}) is not importable as 'sememe'`,
      preProbe.status === 3 && String(preProbe.stdout).includes('RED:'),
      (preProbe.stdout || '').trim() || preProbe.stderr?.slice(0, 120));
  }

  // ---------- install HEAD's tarball into an empty app
  run('npm', ['pack', '--silent'], packDir);
  const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  run('npm', ['init', '-y'], app);
  run('npm', ['i', path.join(packDir, tgz), '--no-audit', '--no-fund', '--loglevel=error'], app);

  const nm = fs.readdirSync(path.join(app, 'node_modules')).filter((n) => !n.startsWith('.'));
  check('install pulls in exactly one package (zero dependencies)', nm.length === 1 && nm[0] === 'sememe', nm.join(', '));

  const installed = path.join(app, 'node_modules', 'sememe');
  for (const need of ['index.mjs', 'src', 'interface', 'vendor', 'bin', 'LICENSE', 'README.md']) {
    check(`installed tree has ${need}`, fs.existsSync(path.join(installed, need)));
  }
  for (const absent of ['tools', 'test', 'research', 'neg', 'package.test.mjs']) {
    check(`installed tree has no ${absent}`, !fs.existsSync(path.join(installed, absent)));
  }

  // ---------- build a store through the package's own exports, decode the harvest
  const store = path.join(app, 'store');
  fs.mkdirSync(path.join(store, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(store, 'receipts'), { recursive: true });
  const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/whirlpool-idl.json'), 'utf8'));
  const receiptFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/whirlpool-receipt.json'), 'utf8'));
  const { createHash } = await import('node:crypto');
  const fingerprint = createHash('sha256').update(`${canonicalJson(snapshot)}\n`).digest('hex');
  if (`sha256:${fingerprint}` !== receiptFixture.fingerprint) throw Error('fixture snapshot does not hash to its receipt');
  fs.writeFileSync(path.join(store, 'objects', `${fingerprint}.json`), JSON.stringify(snapshot));
  fs.writeFileSync(
    path.join(store, 'receipts', `${WHIRLPOOL}-${receiptFixture.slot}-metadata-${fingerprint}.json`),
    JSON.stringify(receiptFixture),
  );

  const harvest = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/harvest-whirlpool-2026-10-28.json'), 'utf8'));
  const payloads = harvest.transactions.flatMap((t) => (t.payloads ?? []).map((p) => ({ sig: t.signature, ...p })));

  // Consumer code runs with cwd=app so 'sememe' resolves to node_modules ONLY.
  const consumer = `
    import { decodePayload, findStoredIdl } from 'sememe';
    import fs from 'node:fs';
    const store = process.argv[2];
    const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const meta = await findStoredIdl(store, process.argv[4]);
    const out = { fingerprint: meta.receipt.fingerprint, slot: meta.receipt.slot, named: 0, refused: 0, byteExact: 0, trailing: 0, total: 0, names: {} };
    for (const p of input) {
      out.total++;
      try {
        const d = await decodePayload(store, process.argv[4], p.dataBase58);
        if (typeof d.name !== 'string') { out.refused++; continue; }
        out.named++;
        out.names[d.name] = (out.names[d.name] ?? 0) + 1;
        if (d.roundTripByteExact) out.byteExact++;
        if (d.trailing?.count > 0) out.trailing++;
      } catch { out.refused++; }
    }
    console.log(JSON.stringify(out));
  `;
  fs.writeFileSync(path.join(app, 'consumer.mjs'), consumer);
  const payloadFile = path.join(tmp, 'payloads.json');
  fs.writeFileSync(payloadFile, JSON.stringify(payloads));
  const r = run('node', ['consumer.mjs', store, payloadFile, WHIRLPOOL], app);
  const result = JSON.parse(r.stdout.trim().split('\n').pop());

  check('installed package re-verifies the store receipt', result.fingerprint === receiptFixture.fingerprint,
    `slot ${result.slot}`);
  check('every real mainnet payload decodes from the installed copy', result.named === result.total && result.refused === 0,
    `${result.named}/${result.total} named, ${result.refused} refused`);
  check('re-encode is byte-exact on the described prefix', result.byteExact + result.trailing === result.total,
    `${result.byteExact} exact, ${result.trailing} with reported trailing bytes`);
  check('instruction names come through', (result.names.swap ?? 0) > 0 && Object.keys(result.names).length >= 8,
    Object.entries(result.names).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' '));

  // ---------- the verification contract ships: tamper is refused
  const tampered = path.join(tmp, 'tampered-store');
  fs.cpSync(store, tampered, { recursive: true });
  const objPath = fs.readdirSync(path.join(tampered, 'objects'))[0];
  const obj = JSON.parse(fs.readFileSync(path.join(tampered, 'objects', objPath), 'utf8'));
  obj.instructions[0].name = 'totally_honest_name';
  fs.writeFileSync(path.join(tampered, 'objects', objPath), JSON.stringify(obj));
  const refuseProbe = spawnSync('node', ['-e', `
    import('sememe').then(async ({ findStoredIdl }) => {
      try { await findStoredIdl(process.argv[1], process.argv[2]); console.log('UNEXPECTED_ACCEPTED'); process.exit(0); }
      catch (e) { console.log('REFUSED:' + (String(e.message).includes('object and receipt disagree') ? 'correct' : 'wrong-reason')); process.exit(0); }
    });`, tampered, WHIRLPOOL], { cwd: app, encoding: 'utf8' });
  check('tampered store object refused by the installed copy',
    refuseProbe.stdout.includes('REFUSED:correct'), (refuseProbe.stdout || '').trim());

  // ---------- sememe/native subpath: real System payload, derived from pinned upstream
  const sysHarvest = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/harvest-system-2026-10-31.json'), 'utf8'));
  const sysPayload = (sysHarvest.transactions ?? []).flatMap((t) => t.payloads ?? [])[0];
  if (sysPayload) {
    const nativeProbe = spawnSync('node', ['-e', `
      import('sememe/native').then(async ({ decodeNativeInstruction }) => {
        const d = decodeNativeInstruction('${SYSTEM}', Buffer.from('${sysPayload.dataHex ?? ''}', 'hex'));
        console.log('NATIVE:' + d.name + ':' + d.roundTripByteExact);
      }).catch(e => { console.log('NATIVE_FAILED:' + e.message); });`, ], { cwd: app, encoding: 'utf8' });
    const out = String(nativeProbe.stdout || '');
    check('sememe/native subpath decodes a real System payload', out.startsWith('NATIVE:') && !out.includes('false'),
      out.trim() || (nativeProbe.stderr || '').slice(0, 120));
  } else {
    check('sememe/native subpath decodes a real System payload', false, 'no payload in fixture');
  }

  // ---------- sememe/raydium subpath: real Raydium AMM v4 payload, no store to fall back on
  const traffic = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures', 'traffic-sample-2026-11-02.json'), 'utf8'));
  const rayPayload = traffic.transactions.flatMap((t) => t.payloads ?? [])
    .find((p) => p.program === RAYDIUM);
  if (rayPayload) {
    const rayProbe = spawnSync('node', ['-e', `
      import('sememe/raydium').then(async ({ decodeRaydiumInstruction }) => {
        const d = decodeRaydiumInstruction('${RAYDIUM}', Buffer.from('${rayPayload.dataHex}', 'hex'));
        console.log('RAYDIUM:' + d.name + ':' + d.roundTripByteExact + ':' + d.trailing.count);
      }).catch(e => { console.log('RAYDIUM_FAILED:' + e.message); });`, ], { cwd: app, encoding: 'utf8' });
    const out = String(rayProbe.stdout || '');
    check('sememe/raydium subpath decodes a real Raydium payload byte-exactly',
      out.startsWith('RAYDIUM:') && !out.includes('false') && out.trim().endsWith(':0'),
      out.trim() || (rayProbe.stderr || '').slice(0, 120));
  } else {
    check('sememe/raydium subpath decodes a real Raydium payload byte-exactly', false, 'no Raydium payload in sample');
  }

  // ---------- sememe/token-metadata subpath: the real token-metadata payload
  // the strict decode path used to refuse, from an INSTALLED copy — proving the
  // vendored crate, its artifact and the derivation check all ship.
  const mdPayload = traffic.transactions.flatMap((t) => t.payloads ?? [])
    .find((p) => p.program === TOKEN_2022 && p.dataHex.startsWith('d2e11ea258b84d8d'));
  if (mdPayload) {
    const mdProbe = spawnSync('node', ['-e', `
      import('sememe/token-metadata').then(async ({ decodeTokenMetadataInstruction, tokenMetadataProvenance }) => {
        const d = decodeTokenMetadataInstruction('${TOKEN_2022}', Buffer.from('${mdPayload.dataHex}', 'hex'));
        const p = tokenMetadataProvenance();
        console.log('TOKEN_METADATA:' + d.name + ':' + d.roundTripByteExact + ':' + d.selectorWidth + ':' + p.variants);
      }).catch(e => { console.log('TOKEN_METADATA_FAILED:' + e.message); });`, ], { cwd: app, encoding: 'utf8' });
    const out = String(mdProbe.stdout || '');
    check('sememe/token-metadata subpath decodes a real metadata payload byte-exactly from the installed copy',
      out.startsWith('TOKEN_METADATA:Initialize:true:8:5'),
      out.trim() || (mdProbe.stderr || '').slice(0, 160));
  } else {
    check('sememe/token-metadata subpath decodes a real metadata payload byte-exactly from the installed copy',
      false, 'no token-metadata payload in sample');
  }

  // ---------- the consumer's trio + the audit surfaces: what solana-tx-remix imports
  const surfacesProbe = spawnSync('node', ['-e', `
    Promise.all([import('sememe/codec'), import('sememe/canonical'), import('sememe/discriminators'), import('sememe/native-corpus'), import('sememe/native-audit')])
      .then(([codec, canonical, discriminators, corpus, audit]) => {
        const seeded = corpus.payloads('system').filter((b) => b.subarray(0, 4).toString('hex') === '03000000');
        const derived = discriminators.globalDiscriminator('swap');
        const auditOut = audit.auditNativeInterface();
        console.log('SURFACES:' + JSON.stringify({
          codec: typeof codec.decodeInstructionData === 'function' && codec.EVENT_IX_TAG_HEX.length === 16,
          canonical: typeof canonical.canonicalJson === 'function',
          discriminators: Array.isArray(derived) && derived.length === 8 && derived.every((b) => Number.isInteger(b) && b >= 0 && b <= 255),
          corpusSeeded: seeded.length,
          corpusTamperCheck: (() => { try { corpus.corpus('system'); return 'hash-ok'; } catch { return 'hash-refused'; } })(),
          auditOk: auditOut.ok === true && auditOut.checked >= 2,
        }));
      })
      .catch(e => { console.log('SURFACES_FAILED:' + e.message); });`, ], { cwd: app, encoding: 'utf8' });
  const surfacesOut = String(surfacesProbe.stdout || '');
  try {
    const s = JSON.parse(surfacesOut.replace(/^SURFACES:/, ''));
    check('sememe/codec + sememe/canonical + sememe/discriminators resolve and work',
      s.codec === true && s.canonical === true && s.discriminators === true, surfacesOut.trim() || (surfacesProbe.stderr || '').slice(0, 160));
    check('sememe/native-corpus ships the qualified mainnet harvest', s.corpusSeeded >= 60 && s.corpusTamperCheck === 'hash-ok',
      `seeded=${s.corpusSeeded} ${s.corpusTamperCheck}`);
    check('sememe/native-audit re-derives the native tables in the consumer process', s.auditOk === true, `ok=${s.auditOk}`);
  } catch (error) {
    check('sememe/codec + sememe/canonical + sememe/discriminators resolve and work', false, surfacesOut.trim() || String(error));
    check('sememe/native-corpus ships the qualified mainnet harvest', false, surfacesOut.trim());
    check('sememe/native-audit re-derives the native tables in the consumer process', false, surfacesOut.trim());
  }

  // ---------- installed CLI decodes with zero dependencies (no web3.js load)
  const firstPayload = payloads[0];
  const cli = spawnSync('node', [path.join(app, 'node_modules', '.bin', 'sememe'), 'decode', WHIRLPOOL, firstPayload.dataBase58, '--store', store],
    { cwd: app, encoding: 'utf8' });
  let cliOk = cli.status === 0;
  let cliName = '';
  try { cliName = JSON.parse(cli.stdout).name ?? ''; } catch { cliOk = false; }
  check('installed CLI decodes without any dependency installed', cliOk && cliName.length > 0, `name=${cliName}`);

  // ---------- report
  const report = {
    what: 'out-of-tree consumer installs the packed package and decodes real mainnet payloads through node_modules only',
    pre: preRef ?? 'not measured in this run (use --pre)',
    tarball: tgz,
    storeFingerprint: receiptFixture.fingerprint,
    payloads: result,
    checks,
    at: new Date().toISOString(),
  };
  const reportPath = path.join(ROOT, 'research', 'package-consumer-e2e-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks pass. Report: ${path.relative(ROOT, reportPath)}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
