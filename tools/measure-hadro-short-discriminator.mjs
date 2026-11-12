#!/usr/bin/env node
// tools/measure-hadro-short-discriminator.mjs — STORED DISCRIMINATORS ARE STORED
// AT ANY LENGTH, AND KEEPING THEM IS MEASURED, NOT ASSERTED.
//
// THE DEFECT THIS MEASURES (found 2026-11-12, from committed fixtures — no
// network): withDerivedDiscriminators treated ONLY 8-byte arrays as "stored".
// A program that publishes 1-byte instruction discriminators (measured: HADRo
// …VDQ8, 38 of them, a real chain-accepted wire table unique in 0x00..0x26)
// had every stored byte OVERWRITTEN with Anchor's 8-byte sighash — against
// this module's own header rule ("stored discriminators are never changed").
// The replaced table matches no real payload: the product path refused
// 0/195 HADRo payloads; with the stored bytes kept, 123/195 decode (51 full
// byte-exact, 72 described-exact with reported trailing bytes; the 72
// setRiskCurve refusals stay honest — that IDL's vector length does not
// match the wire, named per payload, never silently counted).
//
// The same length===8 assumption sat in src/union.mjs prepare(): short stored
// discriminators never entered the rename-evidence map. The fix is one rule
// applied in both places: stored means a non-empty byte array, any length.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question — same convention as tools/measure-conform-filter.mjs):
//
//   1. tools/hadro-short-discriminator-probe.mjs runs in the PRE-FIX tree,
//      extracted with `git archive c304e80` (the last commit before the fix,
//      stable forever). The probe file is COPIED into the extracted tree, so
//      both trees run byte-identical probe code; only src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict is DERIVED from the two runs against hard-pinned expected
//      numbers. The tool fails when the pre-fix tree shows NO defect (a
//      baseline without the defect makes the fix unmeasurable), when the
//      fixed tree does not land on the pinned numbers, or when any face that
//      has no short stored discriminators moved at all (pump.fun 400/442/249,
//      pfeeU 5/459, Eternal 227/15/227 byte-exact and 76/76 events preserved
//      — the fix must be surgical, not a widening).
//
// Exit codes: 0 measured and verified; 1 a falsification count is non-zero;
//             3 NO VERDICT (a tree could not run).
//
// Usage: node tools/measure-hadro-short-discriminator.mjs
//        [--out <file>] [--prefix <commit>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};
const OUT = flag('--out', path.join(ROOT, 'research', 'hadro-short-discriminator-2026-11-12.json'));
const PREFIX = flag('--prefix', 'c304e80');

const PROBE = path.join(HERE, 'hadro-short-discriminator-probe.mjs');
if (!fs.existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(3);
}

class Unmeasurable extends Error {}

function extractPrefix(commit, dir) {
  const probe = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
  if (probe.status !== 0) {
    // `git fetch origin <sha>` fails on servers that do not allow fetching a
    // raw SHA (GitHub answers "couldn't find remote ref"), and every CI
    // runner starts shallow: fetch history, then recheck.
    spawnSync('git', ['fetch', '--depth=50', 'origin', commit], { cwd: ROOT, stdio: 'ignore' });
    let recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    if (recheck.status !== 0) {
      spawnSync('git', ['fetch', '--unshallow', 'origin'], { cwd: ROOT, stdio: 'ignore' });
      recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    }
    if (recheck.status !== 0) {
      spawnSync('git', ['fetch', 'origin'], { cwd: ROOT, stdio: 'ignore' });
      recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    }
    if (recheck.status !== 0) {
      throw new Unmeasurable(`the pre-fix commit ${commit} is neither local nor fetchable from origin (tried sha fetch, --unshallow, full fetch)`);
    }
  }
  const archive = spawnSync('git', ['archive', commit], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new Unmeasurable(`git archive ${commit} failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Unmeasurable(`extracting ${commit} failed: ${untar.stderr}`);
}

function runProbe(treeDir, label) {
  fs.mkdirSync(path.join(treeDir, 'tools'), { recursive: true });
  fs.copyFileSync(PROBE, path.join(treeDir, 'tools', 'hadro-short-discriminator-probe.mjs'));
  const result = spawnSync(process.execPath, [path.join(treeDir, 'tools', 'hadro-short-discriminator-probe.mjs')], {
    cwd: treeDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Unmeasurable(`${label} probe failed (exit ${result.status}): ${String(result.stderr || '').slice(0, 400)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Unmeasurable(`${label} probe did not produce JSON: ${String(result.stdout || '').slice(0, 200)}`);
  }
}

// --- run both trees -------------------------------------------------------

let prefix = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-shortdisc-prefix-'));
try {
  extractPrefix(PREFIX, tmp);
  prefix = runProbe(tmp, 'prefix');
} catch (error) {
  if (error instanceof Unmeasurable) {
    console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: error.message }));
    process.exit(3);
  }
  throw error;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const worktree = runProbe(ROOT, 'worktree');

// --- the pinned expected numbers (measured, not asserted) ------------------

// Pre-fix faces of the defect: every short stored discriminator overwritten.
const prefixShowsNoDefect
  = prefix.unit.preservesShortInstruction
  && prefix.unit.preservesShortEvent
  && prefix.hadroStore.shortDiscriminatorsPreserved === prefix.hadroStore.storedShortInstructions
  && prefix.wire.hadro.decoded > 0;

// Post-fix: unit preserves, store keeps all 38, wire decodes exactly the
// pinned numbers, and every decode is named.
const expected = {
  unit: {
    preservesShortInstruction: true,
    preservesShortEvent: true,
    instructionsFilled: 1,
    eventsFilled: 1,
    eightByteConflictReported: true,
    keepsEightByteStored: true,
  },
  hadroStore: {
    totalInstructions: 38,
    storedShortInstructions: 38,
    storedShortEvents: 0,
    shortDiscriminatorsPreserved: 38,
    instructionsFilled: 0,
    eventsFilled: 0,
    conflicts: 0,
  },
  hadroWire: {
    totalPayloads: 195,
    decoded: 123,
    refused: 72,
    fullExact: 51,
    describedExact: 72,
    decodedByInstruction: {
      setCurve: 72,
      updateMidpriceAndSpreadFactor: 41,
      switchPriceCurve: 6,
      updateMidprice: 3,
      swapExactIn: 1,
    },
  },
};

/** Canonical JSON: object KEY ORDER must not decide a verdict (the counts
 * are the measurement; the insertion order of two named faces is noise). */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function mismatches(expectedObj, actualObj, where, list) {
  for (const [key, want] of Object.entries(expectedObj)) {
    const got = actualObj[key];
    if (JSON.stringify(canonical(got)) !== JSON.stringify(canonical(want))) {
      list.push({ face: where, key, want, got });
    }
  }
}

const landed = [];
mismatches(expected.unit, worktree.unit, 'unit', landed);
mismatches(expected.hadroStore, worktree.hadroStore, 'hadroStore', landed);
mismatches(expected.hadroWire, worktree.wire.hadro, 'hadroWire', landed);
const landedOnPinnedNumbers = landed.length === 0;

// The 72 refusals must be the NAMED setRiskCurve disagreement in both trees'
// post face — never an anonymous refusal count.
const setRiskCurveNamed = Object.entries(worktree.wire.hadro.refusalReasons)
  .filter(([face, n]) => face.includes('setRiskCurve') && n > 0)
  .reduce((acc, entry) => acc + entry[1], 0);
const refusalsNotNamed = worktree.wire.hadro.refused - setRiskCurveNamed;

// Surgical-guards: faces without short INSTRUCTION discriminators must be
// byte-identical between the trees — the fix may not move any verdict that
// does not depend on the kept bytes. (ETRN's short EVENTS were already dead
// weight on this wire path: event dispatch reads 8-byte heads, so its 227
// decodes are unchanged pre/post — the guard is the equality, not a number.)
const wireFaces = ['hadro', 'etrn', 'pump', 'pfee'];
const guardMoves = [];
for (const face of wireFaces) {
  if (face === 'hadro') continue; // the measured face is EXPECTED to move
  if (JSON.stringify(canonical(prefix.wire[face])) !== JSON.stringify(canonical(worktree.wire[face]))) {
    guardMoves.push(face);
  }
}
// The pump.fun and pfeeU baselines the ecosystem artifact pins (400/842 with
// 249 byte-exact; 5/464) must be exactly what the fixed tree still measures.
const guardPins = [
  ['pump', { totalPayloads: 842, decoded: 400, refused: 442, fullExact: 249 }],
  ['pfee', { totalPayloads: 464, decoded: 5, refused: 459 }],
  ['etrn', { totalPayloads: 242, decoded: 227, refused: 15, fullExact: 227 }],
];
const pinMoves = [];
for (const [face, want] of guardPins) {
  mismatches(want, worktree.wire[face], `guardPin:${face}`, pinMoves);
}

// Eternal's 76 short events must be preserved post-fix too (same rule, second
// program) even though they carry no wire effect in this window — and its two
// genuine 8-byte conflicts must still be reported, unchanged between trees.
const etrnPreservedPostFix = worktree.etrnStore.shortDiscriminatorsPreserved === 76;
const etrnConflictsStable = prefix.etrnStore.conflicts === worktree.etrnStore.conflicts
  && worktree.etrnStore.conflicts === 2;

const falsifications = {
  prefixShowsNoDefect,
  landedOnPinnedNumbers,
  landed,
  refusalsNotNamed,
  guardMoves,
  pinMoves,
  etrnPreservedPostFix,
  etrnConflictsStable,
};

const ok = !prefixShowsNoDefect
  && landedOnPinnedNumbers
  && refusalsNotNamed === 0
  && guardMoves.length === 0
  && pinMoves.length === 0
  && etrnPreservedPostFix
  && etrnConflictsStable;

const artifact = {
  tool: 'tools/measure-hadro-short-discriminator.mjs',
  measuredAt: new Date().toISOString(),
  rule: 'a stored discriminator is stored at ANY length: withDerivedDiscriminators keeps it verbatim, fills only true gaps, and conflict-checks only Anchor\'s 8-byte form',
  prefix: { commit: PREFIX },
  faces: { prefix, worktree },
  delta: {
    hadroWireDecoded: worktree.wire.hadro.decoded - prefix.wire.hadro.decoded,
    hadroShortDiscriminatorsPreserved: worktree.hadroStore.shortDiscriminatorsPreserved
      - prefix.hadroStore.shortDiscriminatorsPreserved,
    unitPreservesShortInstruction: `${prefix.unit.preservesShortInstruction} -> ${worktree.unit.preservesShortInstruction}`,
    unitPreservesShortEvent: `${prefix.unit.preservesShortEvent} -> ${worktree.unit.preservesShortEvent}`,
  },
  honestLimits: {
    setRiskCurve: '72 payloads stay refused: the stored IDL declares points as a vector whose length does not match the wire bytes; refused and NAMED, never counted as coverage',
    setCurve: '72 payloads decode the described prefix byte-exactly but carry trailing bytes the IDL does not explain — describedRoundTripByteExact, not full byte-exact',
    etrnEvents: 'Eternal stores 76 1-byte event discriminators; the event wire path dispatches on 8-byte heads, so preservation changes no decode in this window (227/242 byte-exact before and after) — kept is right, measurable effect none',
  },
  falsifications,
  ok,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const written = JSON.stringify(artifact, null, 2);
if (/\/home\/|\/tmp\//.test(written)) {
  console.error('the artifact would carry a host path — refusing to write it');
  process.exit(1);
}
fs.writeFileSync(OUT, `${written}\n`);

console.log(JSON.stringify({
  delta: artifact.delta,
  falsifications,
  ok,
  out: path.relative(ROOT, OUT),
}, null, 2));

process.exit(ok ? 0 : 1);
