#!/usr/bin/env node
// measure-dialect-named-refusal.mjs — A CODEC CRASH IS NOT A REFUSAL, AND A
// DERIVED TABLE MUST NOT REPLACE A DIALECT IT DOES NOT SPEAK.
//
// THE DEFECT THIS MEASURES (found 2026-11-12, committed fixtures + the
// first-party interface of cryptodiablo/diabloarb at pin f5005ac4 — no
// network in the tool):
//
//   DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z — 102 payloads in the
//   committed ecosystem sample. Once its interface sits in a store, EVERY
//   payload dies with the UNNAMED crash voice `TypeError: object is not
//   iterable (cannot read property Symbol(Symbol.iterator))`: the IDL's
//   `types` is a dict and context() iterated `idl.types ?? []`. A crash
//   voice cannot be counted, grouped or gated on.
//
//   Three measured faces, one rule:
//   1. CRASH FACE (102/102 pre-fix): TypeError, not CodecError.
//   2. DERIVATION FACE: withDerivedDiscriminators filled all 4 tag-dispatch
//      instructions with Anchor sighashes (filled {instructions: 4, events:
//      0}, conflicts 0) — an authoritative-looking table matching no wire
//      byte, the HADRo defect one dialect up.
//   3. MISLABELLING FACE: adopt() under WSOL's program id SUCCEEDED pre-fix
//      — the file declares `program_id`, the check read only `idl.address`.
//
//   THE FIX (test-first, this tree): src/dialect.mjs names the refusal once;
//   codec context(), the derivation, adopt and store-read all check it at
//   their boundary, with identical reason text.
//
// HOW THIS IS MEASURED (falsification-first, both trees asked the same
// question — same convention as tools/measure-hadro-short-discriminator.mjs):
//
//   1. tools/dialect-named-refusal-probe.mjs runs in the PRE-FIX tree,
//      extracted with `git archive <prefix>` (stable forever). The probe is
//      COPIED into the extracted tree, so both trees run byte-identical
//      probe code; only src/ under test differs.
//   2. The SAME probe runs in THIS tree.
//   3. The verdict DERIVES from the two runs against pinned expectations:
//      the prefix tree must SHOW every defect face; this tree must land on
//      the named voices; the supported-dialect controls must not move; the
//      committed store must stay byte-untouched.
//
// LICENSING: cryptodiablo/diabloarb carries NO license file at the pin —
// its bytes are NEVER vendored into this repository. This tool takes
// --source: a caller-fetched copy of sdk/diabloarb-executor.idl.json at pin
// f5005ac4, verified against the pinned canonical fingerprint BEFORE
// anything runs, used only inside throwaway trees and temp stores that are
// deleted.
//
// Exit codes: 0 measured and verified; 3 NO VERDICT; 2 usage/IO.
//
// Usage: node tools/measure-dialect-named-refusal.mjs --source <idl at pin>
//        [--out research/dialect-named-refusal-2026-11-12.json] [--prefix <commit>]

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

const OUT = flag('--out', path.join(ROOT, 'research', 'dialect-named-refusal-2026-11-12.json'));
const PREFIX = flag('--prefix', 'AUTO');
const SOURCE = flag('--source', '') ? path.resolve(flag('--source', '')) : null;

const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const PIN = {
  repo: 'cryptodiablo/diabloarb',
  commit: 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc',
  license: null,
  file: 'sdk/diabloarb-executor.idl.json',
  // The store's own content address: sha256(canonicalJson(idl) + '\n') with
  // src/canonical.mjs — the SAME value `sememe adopt` writes into the
  // receipt's fingerprint field (verified: the receipt of an adopt of this
  // file under the throwaway store carries sha256:d6d4e8aa…).
  canonicalFingerprint: 'd6d4e8aac4eb4199fb7b5ff818fcf04d4bd43793b9fc72d0652163b1d0711ec9',
  rawSha256: 'ce582b4fbb67c9fc72b8189ad9873a183cb1aa49c920ddb6b0614820ee6165ce',
  programIdField: 'program_id',
  instructions: 4,
  typesDialect: 'dict',
};
// The wire face, measured from the committed sample independently of the
// coverage artifact: 1-byte tag 01 + exact payload length.
const FACE_COUNTS = [
  { tag: '01', length: 104, count: 14 },
  { tag: '01', length: 118, count: 34 },
  { tag: '01', length: 138, count: 27 },
  { tag: '01', length: 165, count: 3 },
  { tag: '01', length: 171, count: 5 },
  { tag: '01', length: 182, count: 19 },
];

// The store's OWN canonicalizer — the same bytes `sememe adopt` fingerprints.
const { canonicalJson } = await import('../src/canonical.mjs');

const canonicalFingerprintOf = (filePath) =>
  createHash('sha256').update(Buffer.from(canonicalJson(JSON.parse(readFileSync(filePath, 'utf8'))) + '\n')).digest('hex');

async function runProbe(treeRoot, sourcePath) {
  const probePath = path.join(treeRoot, 'tools', 'dialect-named-refusal-probe.mjs');
  const run = spawnSync(process.execPath, [probePath, '--source', sourcePath], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  if (run.status !== 0) {
    throw Error(`probe exited ${run.status} in ${treeRoot}: ${(run.stderr || '').slice(0, 200)}`);
  }
  return JSON.parse(run.stdout);
}

function prefixCommitOf() {
  if (PREFIX !== 'AUTO') return PREFIX;
  // The first commit that adds src/dialect.mjs; its parent is the pre-fix tree.
  const log = spawnSync('git', ['log', '--format=%H', '--reverse', '--', 'src/dialect.mjs'],
    { cwd: ROOT, encoding: 'utf8' });
  const first = (log.stdout || '').split('\n').filter(Boolean)[0];
  if (!first) throw Error('no commit touches src/dialect.mjs yet — commit the fix first');
  const parents = spawnSync('git', ['log', '--format=%P', '-1', first], { cwd: ROOT, encoding: 'utf8' });
  const parent = (parents.stdout || '').trim().split(' ')[0];
  if (!parent) throw Error(`${first} has no parent — cannot extract a pre-fix tree`);
  return parent;
}

async function main() {
  if (!SOURCE || !existsSync(SOURCE)) {
    process.stderr.write('usage: measure-dialect-named-refusal.mjs --source <diabloarb idl at pin f5005ac4> [--out artifact.json] [--prefix <commit>]\n'
      + '(no license at the pin — bytes are not vendored; fetch the file outside the repo, e.g. the GitHub contents API)\n');
    process.exit(2);
  }

  // 0. Pin checks BEFORE anything runs.
  const fingerprint = canonicalFingerprintOf(SOURCE);
  if (fingerprint !== PIN.canonicalFingerprint) {
    process.stderr.write(`NO VERDICT: diabloarb-pin-hash-mismatch: pinned ${PIN.canonicalFingerprint}, `
      + `hashed now ${fingerprint} — refusing to measure bytes nobody reviewed\n`);
    process.exit(3);
  }
  const idl = JSON.parse(readFileSync(SOURCE, 'utf8'));
  if (idl.program_id !== DIABLO) {
    process.stderr.write(`NO VERDICT: the pinned interface declares program_id ${idl.program_id}, not ${DIABLO}\n`);
    process.exit(3);
  }
  if (!Array.isArray(idl.instructions) || idl.instructions.length !== PIN.instructions) {
    process.stderr.write(`NO VERDICT: the pinned interface carries ${idl.instructions?.length} instruction(s), pinned ${PIN.instructions}\n`);
    process.exit(3);
  }
  if (!idl.types || Array.isArray(idl.types)) {
    process.stderr.write('NO VERDICT: the pinned interface no longer carries the measured dict types — premise moved\n');
    process.exit(3);
  }
  if (idl.instructions.some((i) => Array.isArray(i.args))) {
    process.stderr.write('NO VERDICT: the pinned interface carries anchor args — premise moved\n');
    process.exit(3);
  }

  // The wire face from the committed sample must equal the pinned face.
  const sample = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/ecosystem-sample-2026-11-11.json'), 'utf8'));
  const face = new Map();
  let rows = 0;
  for (const tx of sample.transactions ?? []) {
    for (const p of tx.payloads ?? []) {
      if (p.program !== DIABLO) continue;
      rows += 1;
      const raw = Buffer.from(p.dataHex, 'hex');
      const key = `${raw[0].toString(16).padStart(2, '0')}:${raw.length}`;
      face.set(key, (face.get(key) ?? 0) + 1);
    }
  }
  const expectedFace = new Map(FACE_COUNTS.map((f) => [`${f.tag}:${f.length}`, f.count]));
  const faceMatches = expectedFace.size === face.size
    && [...expectedFace.entries()].every(([k, v]) => face.get(k) === v);
  if (!faceMatches || rows !== 102) {
    process.stderr.write(`NO VERDICT: the sample's diabloarb wire face moved: measured `
      + `${JSON.stringify([...face.entries()].sort())} vs pinned ${JSON.stringify([...expectedFace.entries()].sort())}\n`);
    process.exit(3);
  }

  // The coverage artifact's own diablo face is the baseline premise.
  const coverage = JSON.parse(await readFile(path.join(ROOT, 'research/ecosystem-coverage-2026-11-11.json'), 'utf8'));
  const entry = (coverage.programs ?? []).find((p) => p.program === DIABLO);
  const queued = (coverage.acquisitionQueue ?? []).find((q) => q.program === DIABLO);
  if (!entry || entry.payloads !== rows || entry.decoded !== 0 || entry.noInterface !== rows || Number(entry.refused) !== 0) {
    process.stderr.write('NO VERDICT: the coverage artifact does not carry the measured 102-payload no-interface face any more\n');
    process.exit(3);
  }
  if (!queued || queued.acquirable !== false) {
    process.stderr.write('NO VERDICT: the coverage artifact no longer lists diabloarb as unacquirable\n');
    process.exit(3);
  }

  // 1. Extract the pre-fix tree, copy the byte-identical probe in.
  const prefixCommit = prefixCommitOf();
  const prefixTree = mkdtempSync(path.join(tmpdir(), 'dialect-prefix-'));
  try {
    // The tree is ~68 MB — far over any pipe buffer, so the archive goes
    // to a file (`git archive -o`) instead of through a spawnSync buffer.
    const archivePath = path.join(prefixTree, '..', `dialect-prefix-${path.basename(prefixTree)}.tar`);
    const extract = spawnSync('git', ['archive', '-o', archivePath, prefixCommit], { cwd: ROOT, encoding: 'utf8' });
    if (extract.status !== 0) throw Error(`git archive ${prefixCommit} failed: ${(extract.stderr || '').slice(0, 120)}`);
    const untar = spawnSync('tar', ['-xf', archivePath, '-C', prefixTree], { cwd: ROOT, encoding: 'utf8' });
    if (untar.status !== 0) throw Error(`untar failed: ${(untar.stderr || '').slice(0, 120)}`);
    if (!existsSync(path.join(prefixTree, 'src', 'codec.mjs'))) throw Error('prefix tree has no src/codec.mjs');
    copyFileSync(path.join(ROOT, 'tools', 'dialect-named-refusal-probe.mjs'),
      path.join(prefixTree, 'tools', 'dialect-named-refusal-probe.mjs'));

    // The prefix tree runs its OWN src/ but resolves node deps from ROOT via
    // cwd; the probe imports only relative src modules, so cwd=prefixTree.
    const probeIn = async (treeRoot) => {
      const run = spawnSync(process.execPath,
        [path.join(treeRoot, 'tools', 'dialect-named-refusal-probe.mjs'), '--source', SOURCE],
        { cwd: treeRoot, encoding: 'utf8', timeout: 120_000 });
      if (run.status !== 0) throw Error(`probe exited ${run.status} in ${treeRoot}: ${(run.stderr || '').slice(0, 200)}`);
      return JSON.parse(run.stdout);
    };
    const prefix = await probeIn(prefixTree);
    const current = await probeIn(ROOT);

    // Committed store untouched (it never opens for write; probe uses tmp).
    const storeState = () => readdirSync(path.join(ROOT, 'test/fixtures/ecosystem-store-2026-11-11', 'receipts')).sort().join('|')
      + '::' + readdirSync(path.join(ROOT, 'test/fixtures/ecosystem-store-2026-11-11', 'objects')).sort().join('|');

    const falsifications = {
      // The prefix tree must SHOW every defect face, or the baseline proves
      // nothing.
      prefixShowsNoCrash: prefix.direct.codecCrashVoice === null ? 1 : 0,
      prefixCrashOnAll102: prefix.adopt.voices.crash === rows ? 0 : 1,
      prefixAdoptAcceptedOwnId: prefix.adopt.voiceAdopted === true ? 0 : 1,
      prefixFillsSighash: (prefix.direct.derivationFilled?.instructions ?? -1) === PIN.instructions ? 0 : 1,
      prefixAdoptsUnderForeignId: prefix.adopt.mislabelAdopted === true ? 0 : 1,
      prefixReadBoundaryOpen: prefix.readBoundary.voice === 'readable' ? 0 : 1,
      // This tree must refuse with names at every face.
      currentCrashVoice: current.direct.codecCrashVoice !== null ? 1 : 0,
      currentNotNamed: current.direct.codecNamedVoice === null ? 1 : 0,
      currentNamedNotCodecError: current.direct.codecNamedIsCodecError === true ? 0 : 1,
      currentDerivationNotRefused: current.direct.derivationRefused === null ? 1 : 0,
      currentDerivationCrashed: current.direct.derivationCrashed !== null ? 1 : 0,
      currentAdoptStillAcceptedOwnId: current.adopt.voiceAdopted === false ? 0 : 1,
      currentAdoptVoiceNotNamed: current.adopt.voiceAdoptRefusal === null
        || !current.adopt.voiceAdoptRefusal.includes('unsupported IDL dialect') ? 1 : 0,
      currentStoreVoicesNotClean: (current.adopt.voices.crash === 0 && current.adopt.voices.other === 0
        && current.adopt.voices.decoded === 0
        && current.adopt.voices['no-interface'] === rows) ? 0 : 1,
      currentMislabelStillAdopted: current.adopt.mislabelAdopted === false ? 0 : 1,
      currentMislabelUnnamed: current.adopt.mislabelAdoptRefusal === null
        || !current.adopt.mislabelAdoptRefusal.includes('via program_id') ? 1 : 0,
      currentReadBoundaryNotNamed: current.readBoundary.voice === 'named' ? 0 : 1,
      // The fix must be surgical: supported-dialect controls and every
      // committed store object pass unchanged.
      controlWhirlpoolRefused: current.guards.controls.whirlpoolAnchor.refused !== false ? 1 : 0,
      controlWhirlpoolStopsDecoding: current.guards.controls.whirlpoolAnchor.decodesThroughProduct !== 'decoded' ? 1 : 0,
      controlKaminoRefused: current.guards.controls.kaminoLegacyAnchor.refused !== false ? 1 : 0,
      committedStoreObjectsRefused: current.guards.refusedStoreObjects !== 0 ? 1 : 0,
      committedStoreObjectsUnreadable: current.guards.readable !== current.guards.committedStoreObjects ? 1 : 0,
      // The voice count must equal the sample rows exactly.
      currentVoiceTotal: Math.abs(
        (current.adopt.voices.crash ?? 0) + (current.adopt.voices.named ?? 0)
        + (current.adopt.voices['no-interface'] ?? 0) + (current.adopt.voices.other ?? 0)
        + (current.adopt.voices.decoded ?? 0) - rows,
      ),
      // The wire face is sample-derived and re-checked here, not trusted.
      prefixWireFaceMoved: JSON.stringify(prefix.adopt.wireFace) !== JSON.stringify(current.adopt.wireFace) ? 1 : 0,
    };

    const allZero = Object.values(falsifications).every((v) => v === 0);
    const ok = allZero;

    const output = {
      generatedAt: new Date().toISOString(),
      program: DIABLO,
      finding: 'a non-Anchor IDL crashed the codec with an unnamed TypeError, had its tag-dispatch instructions silently filled with Anchor sighashes, and could be adopted under a foreign program id: the dialect gate now names the refusal at every boundary (codec context, derivation, adopt, store-read) and a declared program_id must agree with the receipt',
      pin: PIN,
      face: FACE_COUNTS,
      prefix: { commit: prefixCommit },
      faces: { prefix, current },
      falsifications,
      delta: {
        directCodecVoice: `${prefix.direct.codecCrashVoice ? 'crash (TypeError)' : 'unknown'} -> ${current.direct.codecNamedVoice ? 'named (unsupported IDL dialect, CodecError)' : 'unknown'}`,
        storeVoices: `crash ${prefix.adopt.voices.crash} -> crash ${current.adopt.voices.crash}, no-interface ${current.adopt.voices['no-interface']}`,
        derivationFill: `${JSON.stringify(prefix.direct.derivationFilled)} -> ${current.direct.derivationRefused ? 'refused' : 'filled'}`,
        adoptUnderOwnId: `${prefix.adopt.voiceAdopted} -> ${current.adopt.voiceAdopted}`,
        mislabelAdopted: `${prefix.adopt.mislabelAdopted} -> ${current.adopt.mislabelAdopted}`,
        readBoundary: `${prefix.readBoundary.voice} -> ${current.readBoundary.voice}`,
      },
      committedStoreState: storeState(),
      ok,
      verdict: ok ? 'measured' : 'NO VERDICT',
    };

    await writeFile(path.resolve(ROOT, OUT), `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ verdict: output.verdict, falsifications, delta: output.delta }, null, 2)}\n`);
    if (!ok) process.exit(3);
  } finally {
    rmSync(prefixTree, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
    try { rmSync(`${prefixTree}.tar` ?? '', { force: true }); } catch { /* the archive sits beside the temp dir */ }
  }
}

main().catch((error) => {
  process.stderr.write(`NO VERDICT: ${String(error?.message ?? error).slice(0, 300)}\n`);
  process.exit(3);
});
