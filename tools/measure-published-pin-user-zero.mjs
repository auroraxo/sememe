#!/usr/bin/env node
// tools/measure-published-pin-user-zero.mjs — the published-pin user-zero,
// made repeatable.
//
// WHY THIS TOOL EXISTS
//
// The card's standing next step 3 is "user-zero am PUBLISHED Pin je Puls" —
// a stranger's first run against the version the channels actually serve.
// Every pulse so far ran that by hand and wrote research/registry-install-
// *.json; nothing committed produced it, so the numbers could drift between
// pulses without a gate noticing. This tool is the repeatable half: it
// installs the PUBLISHED version from the npm registry into an empty app
// (the channel a stranger who copies `npm install sememe` gets), then asks
// the same questions against the INSTALLED copy — never against this
// checkout's src/.
//
// WHAT IT MEASURES (each check is a separate entry in the artifact)
//
//   install        npm install sememe@<README pin> into an empty scratch app;
//                  node_modules holds exactly `sememe` (zero runtime deps)
//   channel        npm dist-tags.latest equals the README pin — the pin a
//                  stranger receives is the pin the README names
//   readme-example the README's OWN install-section decode command, run
//                  verbatim through `npx --no-install sememe` from inside
//                  the app, answers swap_v2 / roundTripByteExact true
//   count-header   the byte-identical committed probe
//                  (tools/hadro-count-header-probe.mjs) with only its ROOT
//                  retargeted to the installed copy: 144 payloads, 144
//                  decoded, 0 refused, header count matched on every one
//   live-witness   both chain-accepted updateSpreadConfig (0x0e) witnesses
//                  decode through the installed src/decode.mjs with the
//                  installed wire-layout table entry (elementBytes 66)
//
// The expected numbers for count-header are NOT hardcoded: the same probe is
// run against THIS checkout first, and the installed copy must answer the
// identical question identically. A number that differs between the two
// trees is the finding, not a tolerance.
//
// Network: npm registry (install + dist-tags). Everything else is local
// fixture data — the store, the sample and the witness artifact are read
// from this checkout as LOCAL TEST DATA, exactly as the hand-run pulses did.
//
// Exit codes: 0 measured; 2 usage/IO; 3 NO VERDICT (npm/network refused —
// never written as a clean run).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};
const outPath = option('--out', null);
const keep = args.includes('--keep');
if (!outPath) {
  console.error('usage: node tools/measure-published-pin-user-zero.mjs --out <file.json> [--keep]');
  process.exit(2);
}

const HADRO = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const README_SWIRLPOOL_PAYLOAD =
  '2b04ed0b1ac91e62a40d0100000000000100000000000000af331ba8327fbb35b1c4feff00000000010001010000000601';

const checks = [];
const limits = [];
let verdict = 'measured';

function record(name, pass, detail, extra = {}) {
  // The extras must never overwrite the check's own identity: a field named
  // `name` inside `extra` would silently rename the check (measured: the
  // readme-example check was reported as "swap_v2").
  const { name: _ignored, ...rest } = extra;
  checks.push({ name, pass: Boolean(pass), detail, ...rest });
  return Boolean(pass);
}
function noVerdict(reason) {
  verdict = 'no-verdict';
  limits.push(reason);
}

// --- the README pin, the single source of truth --------------------------
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const pinMatches = [...readme.matchAll(/github:auroraxo\/sememe#(v[\d.]+\.[\d.]+[-\w.]*)/g)]
  .map((m) => m[1]);
const pins = [...new Set(pinMatches)];
if (pins.length !== 1) {
  console.error(`README must pin exactly one install tag, found: ${pins.join(', ') || 'none'}`);
  process.exit(2);
}
const PIN = pins[0];
const PIN_VERSION = PIN.slice(1);

// --- npm: what does the registry actually serve? -------------------------
function npmJson(args) {
  const res = spawnSync('npm', ['view', ...args, '--json'], { encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0) return { error: (res.stderr || res.error?.message || 'npm view failed').trim().slice(0, 300) };
  try { return { value: JSON.parse(res.stdout) }; } catch { return { error: 'npm view returned non-JSON' }; }
}

const latest = npmJson(['sememe', 'version']);
if (latest.error) {
  noVerdict(`npm registry unreachable: ${latest.error}`);
} else {
  const served = String(latest.value);
  record('channel',
    served === PIN_VERSION,
    `README pins ${PIN}; registry dist-tags.latest serves ${served}`,
    { readmePin: PIN, registryLatest: served });
}

// --- the empty app a stranger starts from --------------------------------
const scratch = mkdtempSync(path.join(os.tmpdir(), 'sememe-published-pin-'));
const store = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');
const witnessArtifact = path.join(ROOT, 'research', 'live-layout-scan-hadro-witness-2026-11-14.json');
const probeCopy = path.join(ROOT, 'tools', 'hadro-count-header-probe.mjs');

try {
  writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'published-pin-user-zero', private: true }, null, 2));
  const install = spawnSync('npm',
    ['install', `sememe@${PIN_VERSION}`, '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: scratch, encoding: 'utf8', timeout: 600000 });
  const installed = path.join(scratch, 'node_modules', 'sememe');
  const installOk = install.status === 0 && readdirSync(path.join(scratch, 'node_modules')).filter((n) => !n.startsWith('.')).length === 1;
  record('install',
    installOk,
    installOk
      ? `npm install sememe@${PIN_VERSION} into an empty app: exit 0, node_modules holds exactly ['sememe'] (zero runtime deps)`
      : `install failed: exit ${install.status}: ${(install.stderr || install.error?.message || '').trim().slice(0, 300)}`,
    { installedVersion: installOk ? JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')).version : null });

  if (installOk) {
    // --- the README's own decode example, verbatim, through npx ----------
    const example = spawnSync('npx',
      ['--no-install', 'sememe', 'decode', WHIRLPOOL, README_SWIRLPOOL_PAYLOAD, '--store', store],
      { cwd: scratch, encoding: 'utf8', timeout: 120000 });
    let exampleJson = null;
    try { exampleJson = JSON.parse(example.stdout.trim()); } catch { /* reported below */ }
    record('readme-example',
      example.status === 0 && exampleJson?.name === 'swap_v2' && exampleJson?.roundTripByteExact === true,
      example.status === 0 && exampleJson
        ? `npx --no-install sememe decode (README install section, verbatim): name ${exampleJson.name}, roundTripByteExact ${exampleJson.roundTripByteExact}`
        : `example failed: exit ${example.status}: ${(example.stderr || '').trim().slice(0, 300)}`,
      { name: exampleJson?.name ?? null, roundTripByteExact: exampleJson?.roundTripByteExact ?? null });

    // --- the byte-identical probe, ROOT retargeted to the installed copy --
    // The probe resolves ROOT as its own parent directory, so the question it
    // asks is unchanged; only WHERE the product code and the fixtures live
    // moves. src -> the installed copy, test/fixtures -> this checkout's
    // local test data.
    const probeDir = path.join(scratch, 'probe');
    mkdirSync(path.join(probeDir, 'probe'), { recursive: true });
    const probePath = path.join(probeDir, 'probe', 'hadro-count-header-probe.mjs');
    copyFileSync(probeCopy, probePath);
    symlinkSync(path.join(installed, 'src'), path.join(probeDir, 'src'));
    mkdirSync(path.join(probeDir, 'test'), { recursive: true });
    symlinkSync(path.join(ROOT, 'test', 'fixtures'), path.join(probeDir, 'test', 'fixtures'));

    const runProbe = (dir) => {
      const res = spawnSync('node', [path.join(dir, 'probe', 'hadro-count-header-probe.mjs')], { encoding: 'utf8', timeout: 120000 });
      if (res.status !== 0) return { error: (res.stderr || res.error?.message || `exit ${res.status}`).trim().slice(0, 300) };
      try { return { value: JSON.parse(res.stdout) }; } catch { return { error: 'probe returned non-JSON' }; }
    };

    // checkout first: the expectation is this tree's own answer, not a number
    // written down in a previous pulse.
    const checkoutDir = path.join(scratch, 'checkout-probe');
    mkdirSync(path.join(checkoutDir, 'probe'), { recursive: true });
    copyFileSync(probeCopy, path.join(checkoutDir, 'probe', 'hadro-count-header-probe.mjs'));
    symlinkSync(path.join(ROOT, 'src'), path.join(checkoutDir, 'src'));
    mkdirSync(path.join(checkoutDir, 'test'), { recursive: true });
    symlinkSync(path.join(ROOT, 'test', 'fixtures'), path.join(checkoutDir, 'test', 'fixtures'));

    const checkout = runProbe(checkoutDir);
    const fromInstalled = runProbe(probeDir);
    if (checkout.error || fromInstalled.error) {
      record('count-header', false,
        `probe failed: checkout=${checkout.error ?? 'ok'} installed=${fromInstalled.error ?? 'ok'}`);
    } else {
      const a = checkout.value;
      const b = fromInstalled.value;
      const identical = JSON.stringify(a) === JSON.stringify(b);
      record('count-header',
        identical && b.total === 144 && b.decoded === 144 && b.refused === 0 && b.pointsMatchHeaderCount === 144,
        identical
          ? `byte-identical probe, ROOT retargeted to the installed copy: total ${b.total}, decoded ${b.decoded}, refused ${b.refused}, pointsMatchHeaderCount ${b.pointsMatchHeaderCount}, points ${b.pointsDecoded} — identical to this checkout's answer`
          : `installed copy answers DIFFERENTLY from this checkout: checkout ${JSON.stringify({ total: a.total, decoded: a.decoded, refused: a.refused })} vs installed ${JSON.stringify({ total: b.total, decoded: b.decoded, refused: b.refused })}`,
        { checkout: { total: a.total, decoded: a.decoded, refused: a.refused, pointsDecoded: a.pointsDecoded }, installed: { total: b.total, decoded: b.decoded, refused: b.refused, pointsDecoded: b.pointsDecoded } });
    }

    // --- both live 0x0e witnesses through the INSTALLED decode path -------
    const witness = JSON.parse(readFileSync(witnessArtifact, 'utf8'));
    const witnessPayloads = (witness.payloadSample ?? []).filter((p) => p.dataHex?.startsWith('0e'));
    if (witnessPayloads.length === 0) {
      record('live-witness', false, 'the committed witness artifact carries no 0x0e payload — cannot measure');
    } else {
      const { decodeUnionPayload } = await import(path.join(installed, 'src', 'decode.mjs'));
      const { countFromHeader } = await import(path.join(installed, 'src', 'wire-layout.mjs'));
      const rule = countFromHeader({ address: HADRO }, 'updateSpreadConfig');
      const results = [];
      for (const payload of witnessPayloads) {
        try {
          const out = await decodeUnionPayload(store, HADRO, payload.dataHex, {});
          results.push({
            signature: payload.signature,
            name: out.name,
            numTriggers: out.args?.numTriggers,
            triggers: Array.isArray(out.args?.triggers) ? out.args?.triggers.length : -1,
            describedRoundTripByteExact: out.describedRoundTripByteExact ?? false,
          });
        } catch (error) {
          results.push({ signature: payload.signature, error: String(error?.message ?? error).slice(0, 200) });
        }
      }
      const ok = rule?.elementBytes === 66
        && results.every((r) => !r.error && r.name === 'updateSpreadConfig' && r.numTriggers === r.triggers && r.describedRoundTripByteExact);
      record('live-witness', ok,
        ok
          ? `both chain-accepted 0x0e witnesses decode through the installed src/decode.mjs: ${results.map((r) => `${r.name} numTriggers ${r.numTriggers}=${r.triggers} byte-exact`).join('; ')}; installed count-from-header table entry elementBytes ${rule?.elementBytes}`
          : `witness decode failed: rule elementBytes ${rule?.elementBytes}; results ${JSON.stringify(results).slice(0, 400)}`,
        { rule, witnesses: results });
    }
  }
} finally {
  if (!keep) rmSync(scratch, { recursive: true, force: true });
}

if (!record('readme-pin-unique', pins.length === 1, `README pins exactly one tag: ${PIN}`)) {
  // unreachable in practice (checked above), kept so the pin has one gate
}

limits.push('this is my own user-zero against the published channel, not a foreign user; zero external users, one machine, no audit');
limits.push('the store, sample and witness bytes are LOCAL FIXTURE DATA from this checkout — the install channel is the registry, the evidence is committed');

const artifact = {
  tool: 'tools/measure-published-pin-user-zero.mjs',
  measuredAt: new Date().toISOString(),
  package: 'sememe',
  pin: PIN,
  checks,
  verdict,
  limits,
};
writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ out: outPath, verdict, checks: checks.map((c) => ({ name: c.name, pass: c.pass })) }, null, 2));
if (verdict !== 'measured' || checks.some((c) => !c.pass)) process.exit(3);
