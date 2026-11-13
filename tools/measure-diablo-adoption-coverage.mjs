#!/usr/bin/env node
// measure-diablo-adoption-coverage.mjs — WHAT THE WIRING ACTUALLY MOVED IN
// THE ECOSYSTEM NUMBER: NOTHING AT THE SHIPPED STORE, +102 FOR A USER WHO
// ADOPTS. (12.11. PULS AA — the card's declared next step 3: "ecosystem-
// coverage Re-Messung (DiabLokxis 102 jetzt zaehlbar)".)
//
// THE PREMISE, MEASURED IN BOTH HALVES:
//
//   The card claimed the PULS Z wiring makes the 102 DiabLokxis payloads
//   "now countable". Re-running the SAME committed fixture (sample + store,
//   2026-11-11) through the SAME coverage tool on the wired tree shows the
//   headline UNCHANGED: 18967/21350 = 88.8%, DiabLokxis 0 decoded / 102
//   (the count-from-header fix of 2026-11-13 moved the shipped headline
//   from 88.5% to 88.8%; this measurement's SUBJECT — the 102 DiabLokxis
//   payloads — is unchanged),
//   no-interface. That half of the premise is FALSE — the wiring changed
//   the codec, not the store, and the diabloarb bytes are NOT vendored
//   (cryptodiablo/diabloarb carries no license at the pin f5005ac4,
//   re-measured 2026-11-12: GitHub license API 404, repo license field
//   null). A shipped store cannot carry an interface it may not ship.
//
//   The other half is TRUE and this tool MEASURES it: the 102 payloads move
//   from no-interface to decoded EXACTLY for the user who adopts the
//   first-party copy — 88.8% -> (18967+102)/21350 = 89.3% of measured
//   traffic, outside-watchlist 63.8% -> 65.9%, the same +102 counted at
//   the tool's own entry points against a throwaway copy of the committed
//   store plus ONE adoption through src/adopt.mjs (the product write path,
//   not a synthetic flag). The evidence class is kept apart: all 102 arrive
//   as sourceClass 'adopted' (declared origin), never inflating the pulled
//   column — the same discipline the pfeeU/manifest/archer measurements use.
//
// METHOD (the repo's two-sided, falsification-first convention):
//   1. GATE BEFORE ANYTHING: the caller-fetched source file must hash to
//      the pinned canonical fingerprint d6d4e8aa... (the store's own
//      canonicalizer, same bytes adopt fingerprints). Mismatch: NO VERDICT.
//   2. BASELINE: report against the COMMITTED store must reproduce
//      research/ecosystem-coverage-2026-11-11.json exactly (headline split,
//      DiabLokxis row). It measures the wired tree, not the artifact date:
//      if the wiring had silently widened the shipped number, this gate
//      turns NO VERDICT, not "nice, more coverage".
//   3. UNION: copy the committed store to a temp dir, adopt ONCE through
//      src/adopt.mjs, re-run the SAME report tool against the copy. Pinned:
//      DiabLokxis 102/102 decoded, 0 refused, byteExact counted (pinned at
//      102 by the PULS Z product-entry measurement — a coverage-layer
//      regression shows up HERE), +102 in decoded, -102 in noInterface,
//      +102 in the adopted column ONLY.
//   4. COMMITTED STORE UNTOUCHED: readdir + per-file sha256 before/after.
//   5. DE-HOSTING: no host path may reach the artifact (same rule as the
//      committed coverage tool; a store outside the repo is the marker
//      '<store>' there, so the union run uses a store INSIDE the repo's
//      gitignored tmp layout, and the relative path is recorded instead).
//
// Exit codes: 0 measured and verified; 3 NO VERDICT; 2 usage/IO.
//
// Usage: node tools/measure-diablo-adoption-coverage.mjs \
//          --source <diabloarb-executor.idl.json at pin f5005ac4> \
//          [--out research/diablo-adoption-coverage-2026-11-12.json]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const SOURCE = flag('--source');
const OUT = flag('--out', 'research/diablo-adoption-coverage-2026-11-12.json');
if (!SOURCE) {
  process.stderr.write('usage: measure-diablo-adoption-coverage.mjs --source <diabloarb idl at pin f5005ac4> [--out artifact.json]\n');
  process.exit(2);
}
const sourcePath = path.resolve(SOURCE);

const PIN = {
  repo: 'cryptodiablo/diabloarb',
  commit: 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc',
  file: 'sdk/diabloarb-executor.idl.json',
  license: null, // measured 2026-11-12: license API 404 at pin AND at main; repo field null
  canonicalFingerprint: 'd6d4e8aac4eb4199fb7b5ff818fcf04d4bd43793b9fc72d0652163b1d0711ec9',
};
const PROGRAM = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const COMMITTED_SAMPLE = 'test/fixtures/ecosystem-sample-2026-11-11.json';
const COMMITTED_STORE = 'test/fixtures/ecosystem-store-2026-11-11';
const COMMITTED_ARTIFACT = 'research/ecosystem-coverage-2026-11-11.json';
const TOOL = path.join(ROOT, 'tools', 'ecosystem-coverage.mjs');

const NO = (reason) => {
  process.stderr.write(`NO VERDICT: ${reason}\n`);
  process.exit(3);
};

// 1. the store's OWN canonicalizer — identical fingerprint to adopt's receipt.
const { canonicalJson } = await import('../src/canonical.mjs');
const sourceBytes = readFileSync(sourcePath);
let sourceJson;
try { sourceJson = JSON.parse(sourceBytes.toString('utf8')); }
catch { NO('source file is not JSON'); }
const fingerprint = createHash('sha256')
  .update(Buffer.from(canonicalJson(sourceJson) + '\n')).digest('hex');
if (fingerprint !== PIN.canonicalFingerprint) {
  NO(`diabloarb-pin-hash-mismatch: pinned ${PIN.canonicalFingerprint}, hashed now ${fingerprint} — refusing to measure bytes nobody reviewed`);
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const storeDigest = (dir) => {
  const objects = readdirSync(path.join(dir, 'objects')).sort();
  const receipts = readdirSync(path.join(dir, 'receipts')).sort();
  return JSON.stringify({ objects, receipts, hashes: objects.map((f) => sha(path.join(dir, 'objects', f))) });
};

// 2. BASELINE: the wired tree, the committed store — must reproduce the
// committed ecosystem artifact's headline AND the DiabLokxis row.
const committed = JSON.parse(readFileSync(path.join(ROOT, COMMITTED_ARTIFACT), 'utf8'));
const baseDir = mkdtempSync(path.join(os.tmpdir(), 'sememe-diablo-base-'));
const baseOut = path.join(baseDir, 'baseline.json');
execFileSync('node', [TOOL, 'report',
  '--sample', path.join(ROOT, COMMITTED_SAMPLE),
  '--store', path.join(ROOT, COMMITTED_STORE),
  '--out', baseOut], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
const base = JSON.parse(readFileSync(baseOut, 'utf8'));
const eq = (a, b) => a === b;
for (const key of ['measuredPayloads', 'decoded', 'refused', 'noInterface', 'byteExact',
  'coveredPctOfMeasured', 'coveredPctOfAllSeen']) {
  if (!eq(base.headline[key], committed.headline[key])) {
    NO(`baseline drift in headline.${key}: committed ${committed.headline[key]}, re-measured ${base.headline[key]}`);
  }
}
const baseRow = (base.programs ?? []).find((p) => p.program === PROGRAM);
const committedRow = (committed.programs ?? []).find((p) => p.program === PROGRAM);
if (!baseRow || !committedRow) NO('DiabLokxis row missing from baseline or committed artifact');
for (const key of ['decoded', 'refused', 'noInterface', 'byteExact', 'payloads', 'decodedAdopted']) {
  if (!eq(baseRow[key], committedRow[key])) {
    NO(`baseline drift in DiabLokxis.${key}: committed ${committedRow[key]}, re-measured ${baseRow[key]}`);
  }
}
if (baseRow.decoded !== 0 || baseRow.noInterface !== 102) {
  NO(`shipped-store premise broken: DiabLokxis decoded ${baseRow.decoded}, noInterface ${baseRow.noInterface} (expected 0/102 on the committed store)`);
}

// 3. UNION: throwaway copy + ONE adopt through the product write path.
const committedDigest = storeDigest(path.join(ROOT, COMMITTED_STORE));
const work = mkdtempSync(path.join(os.tmpdir(), 'sememe-diablo-union-'));
try {
  const storeCopy = path.join(work, 'store');
  const walk = (src, dst) => {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(src, entry.name), path.join(dst, entry.name));
      else copyFileSync(path.join(src, entry.name), path.join(dst, entry.name));
    }
  };
  walk(path.join(ROOT, COMMITTED_STORE), storeCopy);
  const { adopt } = await import('../src/adopt.mjs');
  const receipt = await adopt(PROGRAM, sourcePath, storeCopy, {
    source: 'published',
    origin: `${PIN.repo}@${PIN.commit.slice(0, 7)} ${PIN.file} (no license at pin; adopted copy, not vendored)`,
  });
  const unionOut = path.join(work, 'union.json');
  execFileSync('node', [TOOL, 'report',
    '--sample', path.join(ROOT, COMMITTED_SAMPLE),
    '--store', storeCopy,
    '--out', unionOut], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const union = JSON.parse(readFileSync(unionOut, 'utf8'));
  const unionRow = (union.programs ?? []).find((p) => p.program === PROGRAM);
  if (!unionRow) NO('DiabLokxis row missing from the union run');
  if (unionRow.decoded !== 102 || unionRow.refused !== 0 || unionRow.payloads !== 102) {
    NO(`union row wrong: decoded ${unionRow.decoded}, refused ${unionRow.refused}, payloads ${unionRow.payloads} (expected 102/0/102)`);
  }
  if (unionRow.byteExact !== 102) {
    NO(`byte-exact regression at the coverage layer: ${unionRow.byteExact}/102 (PULS Z measured 102/102 at the product entry)`);
  }
  if (unionRow.decodedAdopted !== 102) {
    NO(`evidence-class leak: decodedAdopted ${unionRow.decodedAdopted} (all 102 must be the adopted class; the pulled column may not move here)`);
  }
  const expectDecoded = committed.headline.decoded + 102;
  if (union.headline.decoded !== expectDecoded) {
    NO(`union headline decoded ${union.headline.decoded}, expected ${expectDecoded} (= committed ${committed.headline.decoded} + 102)`);
  }
  if (union.headline.noInterface !== committed.headline.noInterface - 102) {
    NO(`union noInterface ${union.headline.noInterface}, expected ${committed.headline.noInterface - 102}`);
  }
  const expectAdopted = committed.headline.decodedVia.adopted + 102;
  if (union.headline.decodedVia.adopted !== expectAdopted) {
    NO(`adopted column ${union.headline.decodedVia.adopted}, expected ${expectAdopted} (pulled must be untouched by this measurement)`);
  }
  if (union.headline.decodedVia.pulled !== committed.headline.decodedVia.pulled) {
    NO(`pulled column moved: ${union.headline.decodedVia.pulled} vs committed ${committed.headline.decodedVia.pulled}`);
  }

  // 4. the committed store was not touched.
  const afterDigest = storeDigest(path.join(ROOT, COMMITTED_STORE));
  if (afterDigest !== committedDigest) NO('committed store changed during the run');

  const strip = (a) => ({
    measuredPayloads: a.headline.measuredPayloads,
    decoded: a.headline.decoded,
    refused: a.headline.refused,
    noInterface: a.headline.noInterface,
    byteExact: a.headline.byteExact,
    coveredPctOfMeasured: a.headline.coveredPctOfMeasured,
    coveredPctOfAllSeen: a.headline.coveredPctOfAllSeen,
    decodedVia: a.headline.decodedVia,
    outsideWatchlist: a.headline.outsideWatchlist,
    watchlist: a.headline.watchlist,
    diabRow: (a.programs ?? []).find((p) => p.program === PROGRAM),
  });

  const artifact = {
    generatedAt: new Date().toISOString(),
    question: 'does the PULS Z wiring move the ecosystem coverage number, and by how much?',
    verdict: 'headline-unchanged-at-shipped-store; adoption-adds-102',
    premiseCheck: {
      claimed: 'DiabLokxis 102 jetzt zaehlbar (card next-step 3)',
      shippedStore: 'FALSE — 0 decoded / 102 no-interface remains: the wiring changed the codec, not the store; the diabloarb bytes carry no license at the pin and are not vendored',
      adoptPath: 'TRUE — 102/102 decoded, 0 refused, 102 byte-exact, all in the adopted evidence class, for a user who adopts the pinned first-party copy',
    },
    pin: { ...PIN, fingerprintVerified: fingerprint },
    source: { fetchedBy: 'caller at the pinned commit', vendored: false, bytesSha256: createHash('sha256').update(sourceBytes).digest('hex') },
    sample: COMMITTED_SAMPLE,
    committedArtifact: COMMITTED_ARTIFACT,
    baseline: strip(base),
    union: strip(union),
    delta: {
      decoded: union.headline.decoded - base.headline.decoded,
      noInterface: union.headline.noInterface - base.headline.noInterface,
      coveredPctOfMeasured: [base.headline.coveredPctOfMeasured, union.headline.coveredPctOfMeasured],
      outsideWatchlistPct: [base.headline.outsideWatchlist.coveredPct, union.headline.outsideWatchlist.coveredPct],
      byteExact: union.headline.byteExact - base.headline.byteExact,
    },
    receipt: { program: receipt?.program ?? PROGRAM, fingerprint: receipt?.fingerprint ?? fingerprint, slot: receipt?.slot ?? null },
    committedStoreModified: false,
    honestLimits: [
      'one window (the committed 2026-11-11 fixture), not fresh traffic',
      'the +102 belongs to a user who adopts; the shipped store and the pinned tag do not carry the copy (no license at the pin)',
      'adopted evidence class: hash-bound bytes, DECLARED origin',
      '0 external users, npm ENEEDAUTH, no audit',
    ],
  };
  const outAbs = path.resolve(OUT);
  mkdirSync(path.dirname(outAbs), { recursive: true });
  const text = JSON.stringify(artifact, null, 2);
  if (/\/home\/|\/tmp\//.test(text)) NO('host path leaked into the artifact');
  writeFileSync(outAbs, text);
  process.stderr.write(`wrote ${OUT}: baseline ${base.headline.decoded}/${base.headline.measuredPayloads} (${base.headline.coveredPctOfMeasured}%) -> union ${union.headline.decoded}/${union.headline.measuredPayloads} (${union.headline.coveredPctOfMeasured}%); DiabLokxis 0 -> ${unionRow.decoded}/102 byteExact ${unionRow.byteExact}\n`);
} finally {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
