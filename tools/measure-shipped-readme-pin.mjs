#!/usr/bin/env node
// tools/measure-shipped-readme-pin.mjs — what does the README a stranger
// RECEIVES actually say?
//
// MEASURED 2026-11-15, on the sememe tree at main 27ebc41.
//
// The one-pin rule was enforced on the checkout's README by eight different
// gates and on NOTHING that leaves the machine. Publishing is manual, so the
// order was wrong: `npm publish` ran from release commit 729bbaa, whose
// README carried TWO pins (v0.4.28 in the install blocks, v0.4.27 in the
// channel-parity paragraph), npm accepted it, and only afterwards did CI go
// red on that very commit (runs 43741650634 + 43741650472, both failure).
// The gate that should have refused the publish ran after it.
//
// This tool measures the gap per PUBLISHED version, from the registry —
// the bytes a stranger actually downloads:
//
//   R1 the shipped README pins exactly ONE tag
//   R2 that tag equals the version it ships with
//   R3 the README the npm PAGE shows (registry readme) pins the same tag the
//      NEWEST published tarball ships — the page and the tarball must not
//      disagree
//   R4 the pinned tag EXISTS upstream (a pin to a tag nobody can install is
//      an ambiguous pin of the worst kind)
//
// MEASURED CORRECTION (2026-11-15, from this very artifact): npm keeps ONE
// package-level `readme` document and serves it for every version —
// `npm view sememe@0.4.25 readme` returned the pins of 0.4.29 after 0.4.29
// published, and the per-version documents under registry.npmjs.org/sememe/<v>
// carry NO readme key at all. So "the page readme for version X" is not a
// thing: the page always shows the CURRENT readme. R3 is therefore measured
// once, at the package level, against the newest tarball — and a per-version
// `pageAgreesWithTarball` is only meaningful for that newest version; older
// rows record `null` and say why, rather than reporting a false disagreement.
//
// It also measures the tree's OWN packed tarball, so the difference between
// "what this checkout would ship" and "what is already published" is a
// number, not an opinion.
//
// CLASSIFICATION per published version:
//
//   clean        one pin, and it is the version's own tag
//   two-pins     the shipped README names two different tags
//   wrong-tag    one pin, but it is not this version's tag
//   no-pin       the shipped README names no install tag
//
// EXIT CODES: 0 = measured (artifact written); 2 = usage/IO;
//             3 = NO VERDICT (registry unreachable — never "clean").
//
// The immutable versions are NOT repaired: an npm version cannot be
// rewritten. The remedy is a NAMED, MEASURED record plus a gate in FRONT of
// the next publish (tools/gate-shipped-readme-pin.mjs, wired as
// `prepublishOnly`).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinsOf } from './gate-shipped-readme-pin.mjs';

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
const versions = option('--versions', null);
if (!outPath) {
  console.error('usage: node tools/measure-shipped-readme-pin.mjs --out <file.json> [--versions 0.4.26,0.4.27]');
  process.exit(2);
}

const limits = [
  'this measures the README bytes a stranger RECEIVES (registry tarball + registry readme), not whether any stranger read it — zero external users, one machine, no audit',
  'an npm version and a git tag are immutable: a published two-pin README cannot be repaired, only named',
  'the registry README is what npm renders on the package page; the tarball README is what lands in node_modules — both are measured because a stranger can read either',
];

function npmJson(spec) {
  // spec is an ARRAY of npm view arguments. Passing it as one value joins the
  // parts into a single token ("sememe,versions") and npm answers
  // EINVALIDTAGNAME — measured, and the reason this helper spreads.
  const specArgs = Array.isArray(spec) ? spec : [spec];
  const res = spawnSync('npm', ['view', ...specArgs, '--json'], { encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0) return { error: (res.stderr || res.error?.message || 'npm view failed').trim().slice(0, 300) };
  try { return { value: JSON.parse(res.stdout) }; } catch { return { error: 'npm view returned non-JSON' }; }
}

function classify(pins, version) {
  if (pins.length === 0) return 'no-pin';
  if (pins.length > 1) return 'two-pins';
  if (pins[0] !== `v${version}`) return 'wrong-tag';
  return 'clean';
}

// --- which published versions do we measure? ------------------------------
let list = versions ? versions.split(',').map((s) => s.trim()).filter(Boolean) : null;
if (!list) {
  const all = npmJson(['sememe', 'versions']);
  if (all.error) {
    console.error(`shipped-readme-pin: npm registry unreachable: ${all.error}`);
    console.error('NO VERDICT — refusing to write a clean artifact.');
    process.exit(3);
  }
  const versionsList = Array.isArray(all.value) ? all.value : [];
  // 0.0.0-stage is a deliberate placeholder stub, not a release; skip it.
  list = versionsList.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'sememe-shipped-pin-measure-'));
const rows = [];

// npm serves ONE package-level readme for the whole package (see the R3 note
// above), so it is fetched once and compared against the newest tarball.
const pageReadme = npmJson(['sememe', 'readme']);
const pagePins = pageReadme.error ? null : pinsOf(String(pageReadme.value || ''));

try {
  for (const version of list) {
    const row = { version, pins: null, verdict: null, registryReadmePins: null, pageAgreesWithTarball: null, pinnedTagExists: null };

    const readmeView = npmJson([`sememe@${version}`, 'readme']);
    if (readmeView.error) {
      row.verdict = 'no-verdict';
      row.note = readmeView.error;
      rows.push(row);
      continue;
    }
    // Kept for the record: this is the PACKAGE-LEVEL readme npm returns for
    // every version, not this version's readme. Stored under a name that
    // says so, so no later reader mistakes it for per-version evidence.
    row.npmPackageLevelReadmePins = pinsOf(typeof readmeView.value === 'string' ? readmeView.value : '');

    const packed = spawnSync('npm', ['pack', `sememe@${version}`, '--pack-destination', scratch, '--json', '--ignore-scripts'], {
      cwd: scratch, encoding: 'utf8', timeout: 180000,
    });
    if (packed.status !== 0) {
      row.verdict = 'no-verdict';
      row.note = (packed.stderr || 'npm pack failed').trim().slice(0, 200);
      rows.push(row);
      continue;
    }
    let files = null;
    try { files = JSON.parse(packed.stdout); } catch { /* fall through to the directory scan */ }
    const tarball = Array.isArray(files) && files[0] && files[0].filename
      ? path.join(scratch, files[0].filename)
      : readdirSync(scratch).filter((f) => f.endsWith('.tgz'))[0];
    const extract = spawnSync('tar', ['-xOf', tarball, 'package/README.md'], { encoding: 'utf8', timeout: 60000 });
    if (extract.status !== 0) {
      row.verdict = 'no-verdict';
      row.note = 'tarball carries no README';
      rows.push(row);
      continue;
    }
    row.pins = pinsOf(extract.stdout);
    row.verdict = classify(row.pins, version);
    // The page is package-level: it is compared with the NEWEST tarball
    // below, once the list is complete. Older rows record null explicitly
    // instead of a false disagreement.
    row.pageAgreesWithTarball = null;
    row.pageIsPackageLevel = true;

    if (row.pins.length) {
      // Does the pinned tag exist upstream? A pin to a tag nobody can install
      // is an ambiguous pin of the worst kind.
      const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${row.pins[0]}^{commit}`], { cwd: ROOT, encoding: 'utf8' });
      row.pinnedTagExists = probe.status === 0;
    }
    rows.push(row);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --- this tree's own packed tarball --------------------------------------
function shippedByThisTree() {
  const packDir = mkdtempSync(path.join(os.tmpdir(), 'sememe-shipped-pin-tree-'));
  try {
    const packed = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    if (packed.status !== 0) return { error: 'npm pack failed' };
    let files = null;
    try { files = JSON.parse(packed.stdout); } catch { /* fall through */ }
    const tarball = Array.isArray(files) && files[0] && files[0].filename
      ? path.join(packDir, files[0].filename)
      : readdirSync(packDir).filter((f) => f.endsWith('.tgz'))[0];
    const extract = spawnSync('tar', ['-xOf', tarball, 'package/README.md'], { encoding: 'utf8', timeout: 60000 });
    if (extract.status !== 0) return { error: 'no README in the tarball' };
    const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const pins = pinsOf(extract.stdout);
    return { version, pins, verdict: classify(pins, version) };
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

const thisTree = shippedByThisTree();
const defective = rows.filter((r) => r.verdict === 'two-pins' || r.verdict === 'wrong-tag' || r.verdict === 'no-pin');
const measured = rows.filter((r) => r.verdict !== 'no-verdict');
const verdict = defective.length === 0 ? 'shipped-readme-pins-clean' : 'shipped-readme-pin-defective';

// The package-level page readme, compared with the NEWEST tarball's README.
const newest = measured[measured.length - 1];
let pageAgreesWithNewest = null;
if (newest && pagePins) {
  pageAgreesWithNewest = pagePins.length === newest.pins.length
    && pagePins.every((p) => newest.pins.includes(p));
  if (newest) newest.pageAgreesWithTarball = pageAgreesWithNewest;
}

const artifact = {
  tool: 'tools/measure-shipped-readme-pin.mjs',
  measuredAt: new Date().toISOString(),
  question: 'does the README a stranger receives pin exactly one install tag — and is that tag the version it ships with?',
  registry: 'registry.npmjs.org',
  method: 'npm pack <version> from the registry -> tarball README -> pin set; npm view <version> readme -> the page README; pins compared with the version itself',
  verdict,
  counts: {
    measured: measured.length,
    clean: measured.filter((r) => r.verdict === 'clean').length,
    twoPins: rows.filter((r) => r.verdict === 'two-pins').length,
    wrongTag: rows.filter((r) => r.verdict === 'wrong-tag').length,
    noPin: rows.filter((r) => r.verdict === 'no-pin').length,
    noVerdict: rows.filter((r) => r.verdict === 'no-verdict').length,
  },
  versions: rows,
  packageLevelPageReadme: {
    note: 'npm keeps ONE package-level readme and serves it for every version; this is what the npm page shows for the package, compared with the newest tarball',
    pins: pagePins,
    agreesWithNewestTarball: pageAgreesWithNewest,
    newestVersion: newest ? newest.version : null,
  },
  thisTree,
  limits,
};

import { writeFileSync } from 'node:fs';
writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
console.error(`shipped-readme-pin: verdict ${verdict} — ${artifact.counts.clean}/${artifact.counts.measured} published versions carry exactly one correct pin; ${artifact.counts.twoPins} carry two.`);
for (const r of rows) {
  if (r.verdict !== 'clean') console.error(`  ${r.version}: ${r.verdict} pins=${JSON.stringify(r.pins || r.registryReadmePins)}`);
}
console.error(`  this tree would ship: ${JSON.stringify(thisTree)}`);
process.exit(0);
