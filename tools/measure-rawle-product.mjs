#!/usr/bin/env node
// measure-rawle-product.mjs — NAMING A DIALECT IS NOT SPEAKING IT, AND
// WIRING THE SPEAKER IS THE PRODUCT CHANGE.
//
// WHAT THIS MEASURES (12.11. PULS Z, the card's own declared next step):
//
//   PULS Y measured the engine (src/rawle.mjs) against the product's
//   refusal and left the boundary untouched: capability first, wiring
//   later. This run WIRES it — every boundary that refused the whole file
//   now lets the engine answer — and measures the boundary itself, in
//   both trees, with one byte-identical probe (tools/rawle-product-probe.mjs):
//
//   1. DECODE FACE: the PRODUCT entry decodeInstructionData + decodeData
//      answers all 102 committed diabloarb payloads, and the same entry
//      re-encodes each BYTE-IDENTICALLY. Prefix tree: the PULS X named
//      refusal, 0/102 — the honest baseline this change turns.
//   2. FAMILY FACE: the refusal family stays ONE. Unknown tag, truncated
//      payload, trailing bytes, unknown instruction on encode, missing
//      argument on encode — all come back as the product's CodecError
//      (RawLeError translated at the boundary), never a RawLeError leak
//      and never an unnamed crash.
//   3. WIRE FACE: every boundary the PULS X gate used to close. The
//      derivation passes WITHOUT filling Anchor sighashes (filled
//      {instructions: 0, events: 0} — the PULS X fill defect must not
//      re-arrive through the opened gate), idlDialect reports 'raw-le'
//      (a wired dialect, not 'unsupported'), adopt accepts the file under
//      its own program id, store-read reads it, the union decodes through
//      it. Mislabelling stays refused: the file under WSOL's id keeps the
//      PULS X named refusal via program_id.
//   4. GUARD FACE: no silent widening. Whirlpool (Anchor) decodes
//      unchanged; a file that defeats BOTH engines (raw-LE grammar broken
//      by removing the encoding declaration) keeps the exact PULS X named
//      refusal — codec AND union — with code unsupported-idl-dialect.
//   5. STORE FACE: the user's own loop, offline: `sememe adopt` of the
//      pinned interface into a temp store, then `sememe decode` of two
//      real payloads through that store. Prefix: adopt refuses, decode
//      has no object — 0/2. Now: 2/2.
//
// HOW (the repo's own two-tree convention): the prefix tree is extracted
// with `git archive <prefix>` (stable forever), the probe is COPIED into
// it byte-identically, both trees answer the same questions, and the
// verdict derives from the two runs against pinned expectations.
//
// LICENSING: unchanged from the PULS X/Y tools — diabloarb carries no
// license at the pin, its bytes are NEVER vendored; --source is a
// caller-fetched copy verified against the pinned canonical fingerprint
// before anything runs.
//
// Exit codes: 0 measured and verified; 3 NO VERDICT; 2 usage/IO.
//
// Usage: node tools/measure-rawle-product.mjs --source <idl at pin>
//        [--out research/rawle-product-2026-11-12.json] [--prefix <commit>]

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
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

const OUT = flag('--out', path.join(ROOT, 'research', 'rawle-product-2026-11-12.json'));
const PREFIX = flag('--prefix', 'AUTO');
const SOURCE = flag('--source', '') ? path.resolve(flag('--source', '')) : null;

const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const PIN = {
  repo: 'cryptodiablo/diabloarb',
  commit: 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc',
  license: null,
  file: 'sdk/diabloarb-executor.idl.json',
  // The store's own content address — the SAME value `sememe adopt`
  // writes into the receipt's fingerprint field.
  canonicalFingerprint: 'd6d4e8aac4eb4199fb7b5ff818fcf04d4bd43793b9fc72d0652163b1d0711ec9',
  rawSha256: 'ce582b4fbb67c9fc72b8189ad9873a183cb1aa49c920ddb6b0614820ee6165ce',
  programIdField: 'program_id',
  instructions: 4,
  encoding: 'little-endian',
  grammar: {
    primitives: ['u8', 'u16', 'u32', 'u64', 'i64'],
    namedTypes: ['Hop', 'Base', 'Route'],
    counterArrays: ['Base[n_bases]', 'Hop[n_windows]', 'Route[n_routes]', 'u8[n_hops]'],
  },
};
// The wire face, measured from the committed sample independently.
const FACE_COUNTS = [
  { tag: '01', length: 104, count: 14 },
  { tag: '01', length: 118, count: 34 },
  { tag: '01', length: 138, count: 27 },
  { tag: '01', length: 165, count: 3 },
  { tag: '01', length: 171, count: 5 },
  { tag: '01', length: 182, count: 19 },
];
const ROWS = 102;
const BYTE_EXACT = 102;
const DECODE_PROBE_ROWS = 2;

// The store's OWN canonicalizer — the same bytes `sememe adopt` fingerprints.
const { canonicalJson } = await import('../src/canonical.mjs');

const canonicalFingerprintOf = (filePath) =>
  createHash('sha256').update(Buffer.from(canonicalJson(JSON.parse(readFileSync(filePath, 'utf8'))) + '\n')).digest('hex');

async function runProbe(treeRoot, sourcePath) {
  const probePath = path.join(treeRoot, 'tools', 'rawle-product-probe.mjs');
  const run = spawnSync(process.execPath, [probePath, '--source', sourcePath], {
    cwd: treeRoot, encoding: 'utf8', timeout: 180_000,
  });
  if (run.status !== 0) {
    throw Error(`probe exited ${run.status} in ${treeRoot}: ${(run.stderr || '').slice(0, 200)}`);
  }
  return JSON.parse(run.stdout);
}

function prefixCommitOf() {
  if (PREFIX !== 'AUTO') return PREFIX;
  // The first commit that carries src/rawle.mjs — the PULS Y baseline:
  // the engine EXISTS, and every product boundary still refuses the file
  // by name. That is the face this wiring changes.
  const log = spawnSync('git', ['log', '--format=%H', '--reverse', '--', 'src/rawle.mjs'],
    { cwd: ROOT, encoding: 'utf8' });
  const first = (log.stdout || '').split('\n').filter(Boolean)[0];
  if (!first) throw Error('no commit carries src/rawle.mjs yet — commit the engine first');
  return first;
}

async function main() {
  if (!SOURCE || !existsSync(SOURCE)) {
    process.stderr.write('usage: measure-rawle-product.mjs --source <diabloarb idl at pin f5005ac4> [--out artifact.json] [--prefix <commit>]\n'
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
  if (typeof idl.encoding !== 'string' || !idl.encoding.startsWith('little-endian')) {
    process.stderr.write('NO VERDICT: the pinned interface no longer declares the little-endian encoding — premise moved\n');
    process.exit(3);
  }
  if (!idl.types || Array.isArray(idl.types)) {
    process.stderr.write('NO VERDICT: the pinned interface no longer carries the dict types — premise moved\n');
    process.exit(3);
  }
  if (!idl.types.Base || idl.types.Base.size !== 24 || !idl.types.Hop || idl.types.Hop.size !== 5) {
    process.stderr.write('NO VERDICT: the pinned grammar moved (Base/Hop fixed sizes) — premise moved\n');
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
  if (!faceMatches || rows !== ROWS) {
    process.stderr.write(`NO VERDICT: the sample's diabloarb wire face moved: measured `
      + `${JSON.stringify([...face.entries()].sort())} vs pinned ${JSON.stringify([...expectedFace.entries()].sort())}\n`);
    process.exit(3);
  }

  // 1. Extract the prefix tree, copy the byte-identical probe in.
  const prefixCommit = prefixCommitOf();
  const prefixTree = mkdtempSync(path.join(tmpdir(), 'rawle-product-prefix-'));
  try {
    const archivePath = path.join(prefixTree, '..', `rawle-product-prefix-${path.basename(prefixTree)}.tar`);
    const extract = spawnSync('git', ['archive', '-o', archivePath, prefixCommit], { cwd: ROOT, encoding: 'utf8' });
    if (extract.status !== 0) throw Error(`git archive ${prefixCommit} failed: ${(extract.stderr || '').slice(0, 120)}`);
    const untar = spawnSync('tar', ['-xf', archivePath, '-C', prefixTree], { cwd: ROOT, encoding: 'utf8' });
    if (untar.status !== 0) throw Error(`untar failed: ${(untar.stderr || '').slice(0, 120)}`);
    if (!existsSync(path.join(prefixTree, 'src', 'codec.mjs'))) throw Error('prefix tree has no src/codec.mjs');
    if (!existsSync(path.join(prefixTree, 'src', 'rawle.mjs'))) {
      throw Error('prefix tree has no src/rawle.mjs — the prefix must be the ENGINE commit (PULS Y), not an earlier one');
    }
    copyFileSync(path.join(ROOT, 'tools', 'rawle-product-probe.mjs'),
      path.join(prefixTree, 'tools', 'rawle-product-probe.mjs'));

    const prefix = await runProbe(prefixTree, SOURCE);
    const current = await runProbe(ROOT, SOURCE);

    // Committed store untouched (the probe works in temp stores only).
    const storeState = () => readdirSync(path.join(ROOT, 'test/fixtures/ecosystem-store-2026-11-11', 'receipts')).sort().join('|')
      + '::' + readdirSync(path.join(ROOT, 'test/fixtures/ecosystem-store-2026-11-11', 'objects')).sort().join('|');

    const namedCodec = (label) => current.family?.[label] === 'named-codec-error' ? 0 : 1;
    const falsifications = {
      // The prefix tree must SHOW the pre-wiring face: engine present,
      // product refusing by name, store loop closed.
      prefixDialectNotUnsupported: prefix.wire?.idlDialect === 'unsupported' ? 0 : 1,
      prefixProductNotRefused: (prefix.decode?.decoded ?? 0) === 0 ? 0 : 1,
      prefixStoreLoopClosed: prefix.store?.adopt === 'refused' && prefix.store?.decode === 'no-object' ? 0 : 1,
      // This tree must SPEAK the dialect at the product entry.
      engineMissing: current.decode?.decoded === ROWS ? 0 : 1,
      byteExactNotAll: current.decode?.byteExact === BYTE_EXACT ? 0 : 1,
      // One refusal family: every product-level refusal is a CodecError
      // face, never a crash and never a RawLeError leak.
      ...(Object.fromEntries([
        'unknownTag', 'truncatedPayload', 'trailingByte',
        'encodeUnknownInstruction', 'encodeMissingArgument',
      ].map((label) => [`family_${label}_escaped`, namedCodec(label)]))),
      // The wire: every boundary lets the engine answer, and the
      // derivation passes WITHOUT the Anchor sighash fill.
      derivationNotPassed: current.wire?.derivation === 'passes' ? 0 : 1,
      derivationFilledSighashes: JSON.stringify(current.wire?.derivationFilled) === JSON.stringify({ instructions: 0, events: 0 }) ? 0 : 1,
      idlDialectNotRawLe: current.wire?.idlDialect === 'raw-le' ? 0 : 1,
      adoptStillRefused: current.wire?.storeAdopt === 'adopts' ? 0 : 1,
      readBoundaryStillClosed: current.wire?.storeRead === 'reads' ? 0 : 1,
      unionNotDecoded: current.wire?.union === 'decoded' ? 0 : 1,
      // Mislabelling stays refused — the wiring is not a re-labelling gate.
      mislabelNowAdopted: current.guards?.mislabelAdopted === false ? 0 : 1,
      mislabelUnnamed: typeof current.guards?.mislabelRefusal === 'string'
        && current.guards.mislabelRefusal.includes('via program_id') ? 0 : 1,
      // Guards: no widening.
      guardWhirlpoolMoved: current.guards?.whirlpool === 'decoded-or-reported' ? 0 : 1,
      guardBrokenDialectNotNamed: current.guards?.brokenDialect === 'named'
        && current.guards?.brokenDialectCode === 'unsupported-idl-dialect' ? 0 : 1,
      guardBrokenDialectUnionNotNamed: current.guards?.brokenDialectUnion === 'named' ? 0 : 1,
      // The store loop end-to-end.
      storeAdoptRefused: current.store?.adopt === 'adopts' ? 0 : 1,
      storeDecodeNotBoth: current.store?.decoded === DECODE_PROBE_ROWS && current.store?.decode === 'decoded' ? 0 : 1,
      // The wire face is sample-derived and re-checked by both probes.
      wireFaceDisagrees: JSON.stringify(prefix.wireFace) !== JSON.stringify(current.wireFace) ? 1 : 0,
    };

    const allZero = Object.values(falsifications).every((v) => v === 0);
    const ok = allZero;

    const output = {
      generatedAt: new Date().toISOString(),
      program: DIABLO,
      finding: 'wiring the speaker changes the product answer: every boundary that refused the raw-LE file (codec, derivation, adopt, store-read, union) now answers through src/rawle.mjs — 102/102 decoded and byte-exact re-encoded at the product entry, the store loop closed end-to-end, refusals stay one CodecError family, no Anchor table is derived, and a file that defeats both engines keeps the named refusal',
      pin: PIN,
      face: FACE_COUNTS,
      prefix: { commit: prefixCommit, mode: 'engine-present product-refuses (PULS Y baseline)' },
      faces: { prefix, current },
      falsifications,
      delta: {
        productDecode: `0/${ROWS} (named refusal) -> ${current.decode?.decoded}/${ROWS} decoded, ${current.decode?.byteExact}/${ROWS} byte-exact re-encoded`,
        idlDialect: `${prefix.wire?.idlDialect} (unsupported) -> ${current.wire?.idlDialect} (wired)`,
        derivation: `${prefix.wire?.derivation ?? 'refused'} -> ${current.wire?.derivation}, filled ${JSON.stringify(prefix.wire?.derivationFilled ?? null)} -> ${JSON.stringify(current.wire?.derivationFilled ?? null)}`,
        storeLoop: `adopt ${prefix.store?.adopt} / decode ${prefix.store?.decode} -> adopt ${current.store?.adopt} / decode ${current.store?.decode} (${current.store?.decoded}/${current.store?.total})`,
        refusalFamily: `RawLeError stays inside the engine: ${Object.keys(current.family ?? {}).length}/5 product refusals are CodecError faces`,
        mislabelling: `${prefix.guards?.mislabelAdopted} -> ${current.guards?.mislabelAdopted} (refused in both trees)`,
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
    const archivePath = path.join(prefixTree, '..', `rawle-product-prefix-${path.basename(prefixTree)}.tar`);
    try { rmSync(archivePath, { force: true }); } catch { /* idempotent */ }
  }
}

main().catch((error) => {
  process.stderr.write(`NO VERDICT: ${String(error?.message ?? error).slice(0, 300)}\n`);
  process.exit(3);
});
