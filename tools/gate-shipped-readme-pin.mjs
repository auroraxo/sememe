#!/usr/bin/env node
// tools/gate-shipped-readme-pin.mjs — the README that SHIPS must pin exactly
// one tag, and it must be the version being published.
//
// WHY THIS TOOL EXISTS (measured 2026-11-15)
//
// The one-pin rule was enforced everywhere EXCEPT on the bytes that leave the
// machine. Every gate that checks the pin (base58-journey, flag-tag-journey,
// installed-tag-journey, peer-tag-journey, lock-journey,
// multi-copy-store-tag-journey, readme-history-move, published-pin-user-zero)
// reads `<checkout>/README.md` — never the README inside the packed tarball.
// Publishing is manual: `npm publish` was run from the release commit
// 729bbaa, that README carried TWO pins (`github:auroraxo/sememe#v0.4.28` in
// the install blocks AND `github:auroraxo/sememe#v0.4.27` in the
// channel-parity paragraph), npm accepted it, and only THEN did CI go red on
// the same commit (runs 43741650634 + 43741650472, both failure). The gate
// ran after the publish instead of in front of it.
//
// CONSUMER IMPACT (research/shipped-readme-pin-2026-11-15.json): the version
// a stranger is told to install is ambiguous in the very README npm renders
// on the package page. `npm view sememe readme` for 0.4.28 serves both pins.
//
// WHAT THIS GATE DOES
//
// It packs THIS tree exactly the way `npm publish` does, opens the tarball,
// and reads the README the consumer would receive:
//
//   R1 the shipped README pins exactly ONE tag (two pins = ambiguous)
//   R2 that pin equals `v<package.json version>` — a tarball whose README
//      points at the PREVIOUS release ships a stranger the wrong tag
//   R3 the shipped package.json version equals the version being published
//   R4 README.md is actually in the tarball (a missing README would make
//      R1 vacuously "clean" on an empty string)
//
// HOOK: `prepublishOnly`. npm runs it before `npm publish` and NOT before
// `npm pack`, so the channel-parity tool (`tools/measure-channel-parity.mjs`
// packs every historical tag, several of which carry two pins forever) keeps
// working unchanged — the defect stays measurable on the immutable versions
// while the NEXT publish is refused. Measured, not assumed: npm pack exits 0
// without running this hook (see test/shipped-readme-pin.test.mjs G1).
//
// Exit 0 = the shipped README is unambiguous, publish may proceed.
//         1 = REFUSED (do not publish; fix README/package.json first).
//         2 = usage/IO failure (never a pass).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export function pinsOf(readme) {
  return [...new Set((readme.match(/github:auroraxo\/sememe#(v[\d.]+\.[\d.]+[-\w.]*)/g) || []).map((s) => s.split('#')[1]))];
}

// The judgement, as a pure function so the test can aim it at any README.
export function judgeShipped({ readme, version }) {
  const pins = pinsOf(readme);
  const problems = [];
  if (readme.length === 0) problems.push('R4 the shipped README is empty');
  if (pins.length === 0) problems.push('R1 the shipped README pins no install tag at all');
  else if (pins.length > 1) problems.push(`R1 the shipped README pins ${pins.length} tags at once: ${pins.join(', ')} — a stranger cannot tell which release the page describes`);
  if (pins.length === 1 && pins[0] !== `v${version}`) problems.push(`R2 the shipped README pins ${pins[0]} but package.json says ${version} — a stranger installing the documented tag gets a different release`);
  if (!/^\d+\.\d+\.\d+/.test(version)) problems.push(`R3 package.json version ${JSON.stringify(version)} is not a release version`);
  return { pins, ok: problems.length === 0, problems };
}

function refuse(reason) {
  console.error(`shipped-readme-pin REFUSED: ${reason}`);
  console.error('fix: make README.md pin exactly one tag — `github:auroraxo/sememe#v<package.json version>` — and keep the prose from naming another version as an install target.');
  process.exit(1);
}

function main() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sememe-shipped-pin-'));
  try {
    const packed = spawnSync('npm', ['pack', '--pack-destination', scratch, '--json', '--ignore-scripts'], {
      cwd: ROOT, encoding: 'utf8', timeout: 180000,
    });
    if (packed.status !== 0) {
      console.error('shipped-readme-pin: npm pack failed (IO), not a pass');
      process.exit(2);
    }
    let files;
    try { files = JSON.parse(packed.stdout); } catch { files = null; }
    const tarball = Array.isArray(files) && files[0] && files[0].filename
      ? path.join(scratch, files[0].filename)
      : readdirSync(scratch).filter((f) => f.endsWith('.tgz'))[0];
    if (!tarball) {
      console.error('shipped-readme-pin: no tarball produced (IO), not a pass');
      process.exit(2);
    }

    const extract = spawnSync('tar', ['-xOf', tarball, 'package/README.md'], { encoding: 'utf8', timeout: 60000 });
    if (extract.status !== 0) refuse('the tarball carries no package/README.md at all');

    const pkgExtract = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8', timeout: 60000 });
    if (pkgExtract.status !== 0) {
      console.error('shipped-readme-pin: the tarball carries no package/package.json (IO), not a pass');
      process.exit(2);
    }
    const shippedVersion = JSON.parse(pkgExtract.stdout).version;

    const verdict = judgeShipped({ readme: extract.stdout, version: shippedVersion });
    if (!verdict.ok) refuse(verdict.problems.join('; '));
    console.error(`shipped-readme-pin: PUBLISHED-README pins exactly one tag: ${verdict.pins[0]} (package ${shippedVersion})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
