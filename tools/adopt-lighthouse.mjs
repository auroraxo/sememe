#!/usr/bin/env node
// adopt-lighthouse.mjs — close the LARGEST remaining acquisition gap
// (Lighthouse, 1,214 payloads; research/ecosystem-coverage-2026-11-11.json
// acquisitionQueue[0]) through the ONE write path `sememe adopt` uses, with
// the vendored first-party copy verified against its pin BEFORE any write.
//
//   node tools/adopt-lighthouse.mjs --store <dir> \
//     [--sample test/fixtures/ecosystem-sample-2026-11-11.json] \
//     [--out research/lighthouse-acquisition-2026-11-11.json]
//
// What this proves and what it does not:
//   PROVES  the vendored bytes equal the copy read at the pinned commit
//           (sha256), the file self-binds the program id, its shank
//           discriminant table is self-consistent, and every payload the
//           measurement counted decodes through the product's own union
//           decoder and re-encodes byte-exactly.
//   DOES NOT prove the bytes describe the DEPLOYED program: the receipt's
//           origin stays `declared` (src/adopt.mjs), and a foreign git commit
//           is content-addressed but not signed. The byte evidence (1,214/1,214
//           re-encode exact on live traffic) is what a consumer checks; the
//           chain-verdict stays with the decoder, refusal named.
//
// Host paths never enter the artifact: the store is recorded by name, not by
// absolute path (same rule tools/ecosystem-coverage.mjs enforces).
//
// Exit codes: 0 measured, 2 usage/IO, 3 NO VERDICT (pin refusal).

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIGHTHOUSE_PROGRAM, LIGHTHOUSE_PIN, loadVendoredLighthouse, lighthouseOriginLabel } from '../src/lighthouse.mjs';
import { adopt } from '../src/adopt.mjs';
import { decodeUnionPayload } from '../src/decode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

async function main() {
  const storeDir = opt('--store', null);
  if (!storeDir) throw Error('--store <dir> is required');
  const store = path.resolve(ROOT, storeDir);
  const samplePath = path.resolve(ROOT, opt('--sample', 'test/fixtures/ecosystem-sample-2026-11-11.json'));
  const outPath = opt('--out', null);

  // 1. Pin check BEFORE any write. A refusal here means nothing was adopted.
  const loaded = loadVendoredLighthouse();

  // 2. Reproduce the MEASURED gap first: without the copy in the store, the
  //    committed payloads refuse as no-interface. (An empty store directory
  //    is refused as `no-sememe-store`, not as a gap — so the pre-check runs
  //    against the real store only when it already exists, and the artifact
  //    records whichever face the store presented.)
  const sample = require(samplePath);
  const rows = [];
  for (const tx of sample.transactions) {
    for (const p of tx.payloads ?? []) {
      if (p.program === LIGHTHOUSE_PROGRAM) rows.push(p.dataHex);
    }
  }
  let preFace = null;
  try {
    await decodeUnionPayload(store, LIGHTHOUSE_PROGRAM, rows[0], { absent: 'verified' });
    preFace = 'decoded-before-adoption';
  } catch (error) {
    preFace = String(error?.code ?? error?.message ?? error).split(':')[0].slice(0, 60);
  }

  // 3. Adopt through the product's one write path.
  const receipt = await adopt(LIGHTHOUSE_PROGRAM, loaded.path, store, {
    source: 'published',
    origin: lighthouseOriginLabel(),
  });

  // 4. Measure every payload through the product's union entry point, the
  //    SAME policy the ecosystem report uses ('verified', evidence-gated).
  let decoded = 0; let refused = 0; let byteExact = 0; let describedExact = 0;
  const names = {}; const refusals = {};
  for (const hex of rows) {
    try {
      const out = await decodeUnionPayload(store, LIGHTHOUSE_PROGRAM, hex, { absent: 'verified' });
      decoded += 1;
      if (out.roundTripByteExact === true) byteExact += 1;
      if (out.describedRoundTripByteExact === true) describedExact += 1;
      names[out.instruction] = (names[out.instruction] ?? 0) + 1;
    } catch (error) {
      refused += 1;
      const key = String(error?.message ?? error).slice(0, 160);
      refusals[key] = (refusals[key] ?? 0) + 1;
    }
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    program: LIGHTHOUSE_PROGRAM,
    name: 'lighthouse',
    nameEvidence: 'upstream programs/lighthouse/src/lib.rs declare_id + solana-foundation/explorer app/utils/programs.ts bind this id to lighthouse',
    finding: 'acquisitionQueue[0] of ecosystem-coverage-2026-11-11 (1,214 no-interface payloads) closes through adopt of the first-party published copy, verified against a vendored pin',
    pin: {
      repo: LIGHTHOUSE_PIN.repo,
      commit: LIGHTHOUSE_PIN.commit,
      license: LIGHTHOUSE_PIN.license,
      files: LIGHTHOUSE_PIN.files.map((f) => ({ file: f.file, sha256: f.sha256 })),
      vendoredAt: `vendor/lighthouse/${LIGHTHOUSE_PIN.commit}`,
      hashedNow: `sha256:${loaded.sha256}`,
    },
    origin: lighthouseOriginLabel(),
    originStatus: receipt.originStatus,
    originNote: 'declared, not verified: the pin binds the BYTES to a commit the owner read; nothing checks that the commit is signed or that the bytes describe the deployed program. The byte evidence for THAT is below.',
    receipt: {
      fingerprint: receipt.fingerprint,
      instructionCount: receipt.instructionCount,
    },
    sample: path.relative(ROOT, samplePath),
    store: storeDir,
    measured: {
      payloads: rows.length,
      preAdoptionFace: preFace,
      decoded, refused, byteExact, describedExact,
      byteExactPct: rows.length ? Number((100 * byteExact / rows.length).toFixed(1)) : null,
      names,
      refusals,
    },
    limits: [
      'one window: these 1,214 payloads come from the 6 committed blocks, not from the whole ecosystem',
      'origin declared, not verified: the commit is not checked for a signature',
      'the adopted copy sits at slot 0 and can never displace an on-chain pull',
      'decode + re-encode byte-exact is consistency evidence, not an audit of the program',
    ],
  };
  const json = `${JSON.stringify(artifact, null, 1)}\n`;
  if (outPath) {
    await mkdir(path.dirname(path.resolve(ROOT, outPath)), { recursive: true });
    await writeFile(path.resolve(ROOT, outPath), json);
  } else {
    process.stdout.write(json);
  }
  process.stderr.write(`lighthouse: ${decoded}/${rows.length} decoded, ${byteExact} byte-exact `
    + `(${artifact.measured.byteExactPct}%), pre-adoption face: ${preFace}\n`);
  if (decoded !== rows.length) {
    throw Error(`refusal after adoption: ${JSON.stringify(refusals)}`);
  }
}

try {
  await main();
} catch (error) {
  if (error?.name === 'LighthousePinError') {
    process.stderr.write(`NO VERDICT (${error.reason}): ${error.message}\n`);
    process.exit(3);
  }
  process.stderr.write(`FAILED: ${String(error?.message ?? error)}\n`);
  process.exit(2);
}
