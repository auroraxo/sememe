#!/usr/bin/env node
// tools/measure-shipped-status-line.mjs — DOES THE STATUS LINE THE SHIPPED
// README OPENS WITH NAME THE VERSION THE PACKAGE ACTUALLY IS?
//
// MEASURED 2026-11-19, on the sememe tree at main 36a1905.
//
// The front page (README line 5) opens with "**Status: v0.4.37 — published on
// the npm registry AND as a git tag…**". The npm tarball of 0.4.38 — the
// bytes a stranger actually downloads — ships that line with its install pins
// reading `github:auroraxo/sememe#v0.4.38` and its package.json saying 0.4.38.
// The first sentence a stranger reads on the package page therefore names a
// version that is NOT the one they hold: the pin-lag defect class on the
// landing line itself.
//
// WHY NO GATE CAUGHT IT: the one-pin gate (tools/gate-shipped-readme-pin.mjs)
// counts `github:auroraxo/sememe#vX` occurrences — the Status line is prose,
// not a pin, and it escaped every check. Every release commit bumped
// package.json and the pins; the Status line was the only version mention on
// the landing page that nobody bumped.
//
// THIS TOOL measures the question, per published version, from the registry —
// the bytes a stranger downloads:
//
//   R1 the shipped README has a Status line
//   R2 that Status line names `v<version>` — the version of the package it
//      ships with (npm's own tarball, not the checkout)
//
// CLASSIFICATION per published version:
//
//   clean        a Status line present and naming this version's own tag
//   stale-status the Status line names a DIFFERENT tag (the defect: the
//                landing line advertises a release the package is not)
//   no-status    no Status line at all (versions shipped before the front
//                page existed on 2026-11-13 — absence, not a lie)
//
// It also measures THIS tree's OWN packed tarball, so the difference between
// "what this checkout would ship" and "what is already published" is a number,
// not an opinion.
//
// EXIT CODES: 0 = measured (artifact written); 2 = usage/IO;
//             3 = NO VERDICT (registry unreachable — never "clean").
//
// The immutable versions are NOT repaired: an npm version cannot be rewritten.
// The remedy is a NAMED, MEASURED record plus a gate in FRONT of the next
// publish (tools/gate-shipped-readme-pin.mjs R5, wired as `prepublishOnly`).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The Status-line extraction and judgement live in the GATE file: it is the
// publish-time refusal, so the measurement must use the very same code and
// not a second copy (two copies would be two answers).
import { judgeStatus, statusOf } from './gate-shipped-readme-pin.mjs';

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

const limits = [
  'measures README bytes a stranger RECEIVES (registry tarball), not whether any stranger read them — zero external users, one machine, no audit',
  'an npm version is immutable: a published stale Status line cannot be repaired, only named',
  'the Status line is judged only where it exists: versions shipped before the front page existed (2026-11-13) carry no Status line and are classified no-status, not defective',
];

// The Status line of a README: the first line carrying `Status:`, and the
// version token it names. The extraction and the judgement live in the GATE
// file (tools/gate-shipped-readme-pin.mjs) — it is the publish-time
// refusal, so the measurement uses the very same code and not a second copy
// (two copies would be two answers).
export { statusOf };

function judgeStatusLine(readme, version) {
  const judgement = judgeStatus({ readme, version });
  if (judgement.ok) return { verdict: 'clean', statusVersion: judgement.status };
  if (judgement.status === null) return { verdict: 'no-status', statusVersion: null };
  return { verdict: 'stale-status', statusVersion: judgement.status };
}

function npmJson(spec) {
  const specArgs = Array.isArray(spec) ? spec : [spec];
  const result = spawnSync('npm', ['view', ...specArgs, '--json'], { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function packedReadme(spec, scratch) {
  // npm pack <spec> into a scratch dir: the tarball the registry serves (or
  // the tree's own bytes for --ignore-scripts). Then read the shipped README.
  const packed = spawnSync('npm', ['pack', spec, '--pack-destination', scratch, '--json', '--ignore-scripts'],
    { encoding: 'utf8', timeout: 180000 });
  if (packed.status !== 0) return null;
  let files;
  try { files = JSON.parse(packed.stdout); } catch { files = null; }
  const tarball = Array.isArray(files) && files[0] && files[0].filename
    ? path.join(scratch, files[0].filename)
    : readdirSync(scratch).filter((f) => f.endsWith('.tgz'))[0];
  if (!tarball) return null;
  const readme = spawnSync('tar', ['-xOf', tarball, 'package/README.md'], { encoding: 'utf8', timeout: 60000 });
  if (readme.status !== 0) return null;
  const pkg = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8', timeout: 60000 });
  if (pkg.status !== 0) return null;
  let version = null;
  try { version = JSON.parse(pkg.stdout).version; } catch { /* not a pass */ }
  return { readme: readme.stdout, version };
}

function main() {
  const outPath = option('--out', null);
  const versionsOption = option('--versions', null);
  const wantTree = args.includes('--tree');
  if (!outPath) {
    console.error('usage: node tools/measure-shipped-status-line.mjs --out <file.json> [--tree] [--versions 0.4.37,0.4.38]');
    process.exit(2);
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sememe-status-line-'));
  try {
    const published = versionsOption
      ? versionsOption.split(',').map((s) => s.trim()).filter(Boolean)
      : (() => {
          const view = npmJson(['sememe', 'versions']);
          const list = Array.isArray(view) ? view : (view ? [view] : []);
          // The stage placeholder is not a release; measure only release-shaped
          // versions (the same rule channel-parity applies).
          return list.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
        })();

    if (published.length === 0) {
      console.error('measure-shipped-status-line: NO VERDICT — the registry answered no versions (network?); never "clean"');
      process.exit(3);
    }

    const rows = [];
    for (const version of published) {
      const packed = packedReadme(`sememe@${version}`, scratch);
      if (!packed) {
        rows.push({ version, verdict: 'no-verdict', statusVersion: null, publishedAt: null });
        continue;
      }
      const judgement = judgeStatusLine(packed.readme, packed.version);
      rows.push({
        version,
        verdict: judgement.verdict,
        statusVersion: judgement.statusVersion,
        shippedVersion: packed.version,
        publishedAt: null, // filled below from one npm view, not per version
      });
    }

    const versionsMeta = npmJson(['sememe', 'time']);
    for (const row of rows) {
      if (versionsMeta && typeof versionsMeta === 'object') row.publishedAt = versionsMeta[row.version] ?? null;
    }

    let tree = null;
    if (wantTree) {
      // This tree's OWN packed tarball — exactly what `npm publish` from this
      // checkout would ship (scripts ignored so the pin gate's own refusal
      // cannot block the measurement of the pre-fix tree).
      const packed = spawnSync('npm', ['pack', '--pack-destination', scratch, '--json', '--ignore-scripts'],
        { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
      let treePacked = null;
      if (packed.status === 0) {
        let files = null;
        try { files = JSON.parse(packed.stdout); } catch { files = null; }
        const tarball = Array.isArray(files) && files[0] && files[0].filename
          ? path.join(scratch, files[0].filename)
          : readdirSync(scratch).filter((f) => f.endsWith('.tgz'))[0];
        if (tarball) {
          const readme = spawnSync('tar', ['-xOf', tarball, 'package/README.md'], { encoding: 'utf8', timeout: 60000 });
          const pkg = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8', timeout: 60000 });
          if (readme.status === 0 && pkg.status === 0) {
            treePacked = { readme: readme.stdout, version: JSON.parse(pkg.stdout).version };
          }
        }
      }
      if (!treePacked) {
        console.error('measure-shipped-status-line: NO VERDICT — this tree could not be packed (IO?); never "clean"');
        process.exit(3);
      }
      const judgement = judgeStatusLine(treePacked.readme, treePacked.version);
      tree = {
        verdict: judgement.verdict,
        statusVersion: judgement.statusVersion,
        shippedVersion: treePacked.version,
        commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
      };
    }

    const measured = rows.filter((r) => r.verdict !== 'no-verdict');
    const counts = {
      measured: measured.length,
      clean: rows.filter((r) => r.verdict === 'clean').length,
      staleStatus: rows.filter((r) => r.verdict === 'stale-status').length,
      noStatus: rows.filter((r) => r.verdict === 'no-status').length,
      noVerdict: rows.filter((r) => r.verdict === 'no-verdict').length,
      thisTree: tree ? tree.verdict : null,
    };
    const latest = measured[measured.length - 1] ?? null;
    const verdict = (latest && latest.verdict === 'stale-status') || (tree && tree.verdict === 'stale-status')
      ? 'shipped-status-line-stale'
      : 'shipped-status-line-clean';

    const artifact = {
      tool: 'tools/measure-shipped-status-line.mjs',
      measuredAt: new Date().toISOString(),
      package: 'sememe',
      question: 'does the Status line the shipped README opens with name the version the package actually is?',
      verdict,
      counts,
      latestPublished: latest ? { version: latest.version, statusVersion: latest.statusVersion, verdict: latest.verdict } : null,
      thisTree: tree,
      versions: rows,
      limits,
    };

    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.error(`measure-shipped-status-line: ${verdict} — ${counts.staleStatus}/${counts.measured} published versions carry a stale Status line; this tree: ${tree ? tree.verdict : 'not measured'} (${tree ? tree.statusVersion : '-'})`);
    process.exit(verdict === 'shipped-status-line-stale' ? 0 : 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The importable judgement for the gate's R5 lives in the gate file
// (tools/gate-shipped-readme-pin.mjs) — see the import above. This re-export
// keeps the historical import path of this tool working.
export { judgeStatus };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
