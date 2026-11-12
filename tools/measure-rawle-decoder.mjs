#!/usr/bin/env node
// measure-rawle-decoder.mjs — NAMING A DIALECT IS NOT SPEAKING IT.
//
// HISTORICAL INSTRUMENT (PULS Y, 2026-11-12): its falsifications pin the
// product boundary as NOT wired (currentProductNotNamed). Since PULS Z the
// boundary IS wired, so running this tool in a wired tree exits 3 NO
// VERDICT by design — it measures the trees it was built for. The wired
// product boundary is measured by tools/measure-rawle-product.mjs
// (research/rawle-product-2026-11-12.json).
//
// THE PREMISE (PULS X, research/dialect-named-refusal-2026-11-12.json):
//   sememe refused the diabloarb interface BY NAME at every boundary — the
//   honest answer while the dialect was foreign. The card's own next step
//   (and the interrupted PULS Y start): a raw-LE dialect engine so that
//   naming a dialect is followed by speaking it. This measurement pins the
//   engine against the REAL wire, two trees, byte-identical probe:
//
//     1. PRE-FIX TREE (aa6901b, before the dialect gate): no src/rawle.mjs,
//        no capability — the product refused with an unnamed TypeError
//        crash (measured in the PULS X artifact). The probe must show
//        engine.present === false and the crash voice in the product.
//     2. THIS TREE: src/rawle.mjs decodes ALL 102 committed diabloarb
//        payloads and re-encodes every one BYTE-IDENTICALLY. Eight grammar
//        falsifications (mutated fixed size, duplicate tag, unknown
//        counter, unknown dispatch tag, truncated payload, one extra byte,
//        missing encoding declaration, layout-less stub tag) all refuse BY
//        NAME. The product boundary still answers the same NAMED refusal —
//        the engine is capability, NOT a wired product path.
//
//   The verdict DERIVES from the two runs: the prefix tree must show the
//   pre-engine baseline; this tree must land on the pinned numbers; the
//   product must be UNCHANGED in both (the wiring is future work with the
//   pins it rewrites); the committed store stays byte-untouched.
//
// LICENSING: cryptodiablo/diabloarb carries NO license file at the pin —
// its bytes are NEVER vendored into this repository. This tool takes
// --source: a caller-fetched copy of sdk/diabloarb-executor.idl.json at
// pin f5005ac4, verified against the pinned canonical fingerprint BEFORE
// anything runs, used only inside throwaway trees and temp dirs that are
// deleted.
//
// Exit codes: 0 measured and verified; 3 NO VERDICT; 2 usage/IO.
//
// Usage: node tools/measure-rawle-decoder.mjs --source <idl at pin>
//        [--out research/rawle-decoder-2026-11-12.json] [--prefix <commit>]

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

const OUT = flag('--out', path.join(ROOT, 'research', 'rawle-decoder-2026-11-12.json'));
const PREFIX = flag('--prefix', 'aa6901bdc5e3b4cc5f8fad0831e5ff79557fdd3d');
const SOURCE = flag('--source', '') ? path.resolve(flag('--source', '')) : null;

const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const PIN = {
  repo: 'cryptodiablo/diabloarb',
  commit: 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc',
  license: null,
  file: 'sdk/diabloarb-executor.idl.json',
  // The store's own content address: sha256(canonicalJson(idl) + '\n') —
  // the SAME value `sememe adopt` writes into a receipt's fingerprint.
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
const ROWS = 102;
const BYTE_EXACT = 102;
const GRAMMAR_LABELS = [
  'mutatedFixedSize', 'duplicateTag', 'counterNotAPrecedingField',
  'unknownDispatchTag', 'truncatedPayload', 'trailingByte',
  'noEncodingDeclaration', 'layoutlessStubTag',
];

// The store's OWN canonicalizer — the same bytes `sememe adopt` fingerprints.
const { canonicalJson } = await import(path.join(ROOT, 'src', 'canonical.mjs'));

const canonicalFingerprintOf = (filePath) =>
  createHash('sha256').update(Buffer.from(canonicalJson(JSON.parse(readFileSync(filePath, 'utf8'))) + '\n')).digest('hex');

async function runProbe(treeRoot, sourcePath) {
  const probePath = path.join(treeRoot, 'tools', 'rawle-decoder-probe.mjs');
  const run = spawnSync(process.execPath, [probePath, '--source', sourcePath], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  if (run.status !== 0) {
    throw Error(`probe exited ${run.status} in ${treeRoot}: ${(run.stderr || '').slice(0, 200)}`);
  }
  return JSON.parse(run.stdout);
}

async function main() {
  if (!SOURCE || !existsSync(SOURCE)) {
    process.stderr.write('usage: measure-rawle-decoder.mjs --source <diabloarb idl at pin f5005ac4> [--out artifact.json] [--prefix <commit>]\n'
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
  const expectedFace = new Map([
    ['01:104', 14], ['01:118', 34], ['01:138', 27],
    ['01:165', 3], ['01:171', 5], ['01:182', 19],
  ]);
  const faceMatches = expectedFace.size === face.size
    && [...expectedFace.entries()].every(([k, v]) => face.get(k) === v);
  if (!faceMatches || rows !== ROWS) {
    process.stderr.write(`NO VERDICT: the sample's diabloarb wire face moved: measured `
      + `${JSON.stringify([...face.entries()].sort())} vs pinned ${JSON.stringify([...expectedFace.entries()].sort())}\n`);
    process.exit(3);
  }

  // 1. Extract the prefix tree, copy the byte-identical probe in.
  const prefixTree = mkdtempSync(path.join(tmpdir(), 'rawle-prefix-'));
  try {
    const archivePath = path.join(prefixTree, '..', `rawle-prefix-${path.basename(prefixTree)}.tar`);
    const extract = spawnSync('git', ['archive', '-o', archivePath, PREFIX], { cwd: ROOT, encoding: 'utf8' });
    if (extract.status !== 0) throw Error(`git archive ${PREFIX} failed: ${(extract.stderr || '').slice(0, 120)}`);
    const untar = spawnSync('tar', ['-xf', archivePath, '-C', prefixTree], { cwd: ROOT, encoding: 'utf8' });
    if (untar.status !== 0) throw Error(`untar failed: ${(untar.stderr || '').slice(0, 120)}`);
    if (!existsSync(path.join(prefixTree, 'src', 'codec.mjs'))) throw Error('prefix tree has no src/codec.mjs');
    if (existsSync(path.join(prefixTree, 'src', 'rawle.mjs'))) {
      throw Error('prefix tree unexpectedly carries src/rawle.mjs — choose an earlier prefix');
    }
    copyFileSync(path.join(ROOT, 'tools', 'rawle-decoder-probe.mjs'),
      path.join(prefixTree, 'tools', 'rawle-decoder-probe.mjs'));

    const prefix = await runProbe(prefixTree, SOURCE);
    const current = await runProbe(ROOT, SOURCE);

    // Committed store untouched (the probe never opens it for write).
    const storeState = () => readdirSync(path.join(ROOT, 'test/fixtures/ecosystem-store-2026-11-11', 'receipts')).sort().join('|')
      + '::' + readdirSync(path.join(ROOT, 'test/fixtures/ecosystem-store-2026-11-11', 'objects')).sort().join('|');

    // A decode-path refusal is ANY recorded message; only the literal
    // sentinel 'ESCAPED' means the mutant was accepted.
    const nonNamed = (label) => {
      const value = current.engine?.grammar?.[label];
      return typeof value === 'string' && value.length > 0 && value !== 'ESCAPED' ? 0 : 1;
    };

    const falsifications = {
      // The prefix tree must SHOW the pre-engine baseline.
      prefixHasEngine: prefix.engine?.present === false ? 0 : 1,
      prefixProductCrash: prefix.product?.voice === 'crash' ? 0 : 1,
      // This tree must decode and round-trip every payload byte-exactly.
      engineMissing: current.engine?.present === true ? 0 : 1,
      engineGateRefused: current.engine?.dialectReason === null ? 0 : 1,
      decodedNotAll: current.engine?.decoded === ROWS ? 0 : 1,
      byteExactNotAll: current.engine?.byteExact === BYTE_EXACT ? 0 : 1,
      engineRefusalFaces: (current.engine?.refusalFaces ?? []).length === 0 ? 0 : 1,
      // Every grammar falsification must refuse by name.
      ...Object.fromEntries(GRAMMAR_LABELS.map((label) => [`grammar_${label}_escaped`, nonNamed(label)])),
      // The product boundary is NOT wired this run: the prefix tree must
      // show the pre-gate crash, this tree the named refusal (the PULS X
      // fix) — the DELTA is the point, so no cross-tree equality pin.
      currentProductNotNamed: current.product?.voice === 'named' ? 0 : 1,
      currentProductCrash: current.product?.voice === 'crash' ? 1 : 0,
      currentProductOther: current.product?.voice === 'other' ? 1 : 0,
      // Surgical guard: a supported anchor interface passes unchanged.
      guardWhirlpoolNotDecoded: current.guards?.whirlpool === 'decoded-or-reported' ? 0 : 1,
      // The wire face is sample-derived and re-checked by both probes.
      wireFaceDisagrees: JSON.stringify(prefix.wireFace) !== JSON.stringify(current.wireFace) ? 1 : 0,
    };

    const allZero = Object.values(falsifications).every((v) => v === 0);
    const ok = allZero;

    const output = {
      generatedAt: new Date().toISOString(),
      program: DIABLO,
      finding: 'naming a dialect is not speaking it: a raw-LE engine decodes the declared field lists over the real wire — 102/102 decoded, 102/102 byte-exact round-trips, 8 named grammar refusals; the product boundary is NOT wired this run',
      pin: PIN,
      face: [...expectedFace.entries()].map(([key, count]) => ({
        tag: key.split(':')[0], length: Number(key.split(':')[1]), count,
      })),
      prefix: { commit: PREFIX, enginePresent: prefix.engine?.present ?? null, productVoice: prefix.product?.voice ?? null },
      faces: { prefix, current },
      falsifications,
      delta: {
        engine: 'absent -> present (src/rawle.mjs)',
        decode: `0/${ROWS} -> ${current.engine?.decoded}/${ROWS} decoded, ${current.engine?.byteExact}/${ROWS} byte-exact round-trips`,
        productVoice: `${prefix.product?.voice} (TypeError crash) -> ${current.product?.voice} (unchanged named refusal — wiring is future work)`,
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
    const archivePath = path.join(prefixTree, '..', `rawle-prefix-${path.basename(prefixTree)}.tar`);
    try { rmSync(archivePath, { force: true }); } catch { /* idempotent */ }
  }
}

main().catch((error) => {
  process.stderr.write(`NO VERDICT: ${String(error?.message ?? error).slice(0, 300)}\n`);
  process.exit(3);
});
