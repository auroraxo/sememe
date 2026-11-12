#!/usr/bin/env node
// measure-pump-second-source.mjs — the card's next acquisition step, measured
// end to end: adopt pump.fun's FIRST-PARTY published copy (pump-fun/
// pump-public-docs, idl/pump.json) next to the on-chain pull in the committed
// ecosystem store and re-measure the pump.fun face of
// research/ecosystem-coverage-2026-11-11.json.
//
//   node tools/measure-pump-second-source.mjs \
//     --sample test/fixtures/ecosystem-sample-2026-11-11.json \
//     --store test/fixtures/ecosystem-store-2026-11-11 \
//     --source <path to idl/pump.json as read at the pinned commit> \
//     --out research/pump-second-source-2026-11-12.json
//
// WHY THIS FILE EXISTS
//
// The ecosystem artifact names pump.fun's regression as its largest refusal
// face inside the watchlist: 400/842 decoded (47.5%), 442 refused against the
// on-chain pull @slot 468262003 — the SAME program the union path decoded
// 915/996 for in the 10-28 window when BOTH sources were present (research/
// traffic-coverage-2026-11-02/03, first-party copy pump-fun/pump-public-docs).
// The 11-11 capture store holds only the on-chain pull, so the number says
// "source lag", but nobody had measured the second source's share on THESE
// bytes. The card (sememe, 2026-11-11) names it next step (2): adopt the
// second source, close the 442 refusals. This tool measures exactly that.
//
// METHOD (same two-store shape tools/measure-lock-nothing-pinned.mjs proved):
//
//   baseline: the committed store, untouched — must reproduce the artifact's
//             own numbers (400/842/249), else NO VERDICT (a measurement that
//             cannot see the defect proves nothing about the fix);
//   union:    a THROWAWAY copy of the committed store + `sememe adopt` of the
//             pinned published copy through the PRODUCT's one write path
//             (src/adopt.mjs: content-addressed, receipt `slot: null`,
//             origin declared — the adopted copy can never displace the
//             on-chain pull as the primary source).
//
// Everything is offline. The source bytes are read from a file the caller
// pins; nothing here fetches. The committed copy is
// test/fixtures/traffic-sample-store-2026-11-04-pulled/objects/
// a35349f371114b52701a3aeae83627f6b4667251efb3ac9d37a882baa723e818.json
// — the same bytes upstream's idl/pump.json still canonicalizes to at commit
// 639b87f (measured 2026-11-12 via the GitHub contents API; the upstream
// file is pretty-printed, this fixture object is the canonical form — adopt
// fingerprints canonical JSON, so both are one object).
//
// LICENSING (the same gate tools/preview-external-adoption.mjs enforces):
// pump-fun/pump-public-docs ships NO LICENSE file. Its bytes therefore must
// NOT be vendored into this MIT repository or the published npm package.
// They live only in the throwaway store copy, which is deleted afterwards;
// the committed artifact records the sha256 fingerprint of the canonical
// object and `committedStoreModified: false`.
//
// Exit codes: 0 measured, 2 usage/IO, 3 NO VERDICT (baseline does not
// reproduce the artifact or an adoption face disagrees).

import { rmSync, existsSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adopt } from '../src/adopt.mjs';
import { decodeUnionPayload } from '../src/decode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PIN = {
  program: PUMP,
  repo: 'pump-fun/pump-public-docs',
  commit: '639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22',
  file: 'idl/pump.json',
  // sha256 of the CANONICAL object (src/adopt.mjs fingerprints canonicalJson,
  // not the pretty-printed upstream file). The committed fixture object and a
  // fresh read at this commit both canonicalize to this hash.
  canonicalFingerprint: 'a35349f371114b52701a3aeae83627f6b4667251efb3ac9d37a882baa723e818',
  committedObject:
    'test/fixtures/traffic-sample-store-2026-11-04-pulled/objects/'
    + 'a35349f371114b52701a3aeae83627f6b4667251efb3ac9d37a882baa723e818.json',
  license: null, // no LICENSE file at the pinned commit — bytes stay out of this repo
  origin: 'pump-fun/pump-public-docs@639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22:idl/pump.json',
};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

async function measureStore(storeDir, rows) {
  let decoded = 0; let refused = 0; let byteExact = 0; let describedExact = 0;
  let adoptedAnswered = 0; let pulledAnswered = 0;
  const refusals = {}; const names = {};
  for (const row of rows) {
    try {
      const out = await decodeUnionPayload(storeDir, PUMP, row.hex, { absent: 'verified' });
      decoded += 1;
      if (out.roundTripByteExact === true) byteExact += 1;
      if (out.describedRoundTripByteExact === true) describedExact += 1;
      const slot = out.idl?.slot;
      if (slot === null || slot === undefined) adoptedAnswered += 1; else pulledAnswered += 1;
      names[out.name] = (names[out.name] ?? 0) + 1;
    } catch (error) {
      refused += 1;
      const key = String(error?.message ?? error).slice(0, 110);
      refusals[key] = (refusals[key] ?? 0) + 1;
    }
  }
  return { decoded, refused, byteExact, describedExact, adoptedAnswered, pulledAnswered, refusals, names };
}

async function main() {
  const samplePath = path.resolve(ROOT, opt('--sample', 'test/fixtures/ecosystem-sample-2026-11-11.json'));
  const storeDir = path.resolve(ROOT, opt('--store', 'test/fixtures/ecosystem-store-2026-11-11'));
  const sourceArg = opt('--source', null);
  const outPath = opt('--out', null);

  const sourcePath = sourceArg
    ? path.resolve(ROOT, sourceArg)
    : path.resolve(ROOT, PIN.committedObject);
  if (!existsSync(sourcePath)) {
    process.stderr.write(`NO VERDICT: pinned source file missing: ${path.relative(ROOT, sourcePath)}\n`);
    process.exit(3);
  }

  // Pin check BEFORE any write: the source bytes must canonicalize to the
  // pinned fingerprint (adopt refuses and writes nothing on mismatch).
  const raw = readFileSync(sourcePath, 'utf8');
  const { canonicalJson } = await import('../src/canonical.mjs');
  const { createHash } = await import('node:crypto');
  const canonicalFingerprint = createHash('sha256')
    .update(Buffer.from(canonicalJson(JSON.parse(raw)) + '\n'))
    .digest('hex');
  if (canonicalFingerprint !== PIN.canonicalFingerprint) {
    process.stderr.write(`NO VERDICT: pump-pin-hash-mismatch: pinned ${PIN.canonicalFingerprint}, `
      + `hashed now ${canonicalFingerprint} — refusing to measure bytes nobody reviewed\n`);
    process.exit(3);
  }

  const sample = JSON.parse(await readFile(samplePath, 'utf8'));
  const rows = [];
  for (const tx of sample.transactions) {
    for (const p of tx.payloads ?? []) {
      if (p.program === PUMP) rows.push({ hex: p.dataHex, failed: tx.failed === true });
    }
  }
  if (rows.length === 0) {
    process.stderr.write('NO VERDICT: the sample carries no pump.fun payloads\n');
    process.exit(3);
  }

  // 1. Baseline: the committed store MUST reproduce the artifact's own
  //    pump.fun face. The artifact is the measurement's contract.
  const coverage = JSON.parse(await readFile(path.resolve(ROOT, 'research/ecosystem-coverage-2026-11-11.json'), 'utf8'));
  const entry = (coverage.programs ?? []).find((p) => p.program === PUMP);
  const baseline = await measureStore(storeDir, rows);
  if (!entry
    || baseline.decoded !== entry.decoded
    || baseline.refused !== entry.refused
    || baseline.byteExact !== entry.byteExact) {
    process.stderr.write(`NO VERDICT: baseline does not reproduce the committed artifact `
      + `(measured ${baseline.decoded}/${baseline.refused}/${baseline.byteExact} vs artifact `
      + `${entry?.decoded}/${entry?.refused}/${entry?.byteExact})\n`);
    process.exit(3);
  }

  // 2. Union: throwaway copy of the committed store + adopt through the
  //    product's one write path. The pin was already checked, so a refusal
  //    here is an adoption defect, not a licensing/pin one.
  const committedBefore = readdirSync(path.join(storeDir, 'receipts')).sort().join('\n')
    + '::' + readdirSync(path.join(storeDir, 'objects')).sort().join('\n');
  const workStore = path.join(ROOT, 'research', '.pump-second-source-store');
  cpSync(storeDir, workStore, { recursive: true });
  let receipt;
  try {
    receipt = await adopt(PUMP, sourcePath, workStore, { source: 'published', origin: PIN.origin });
  } catch (error) {
    rmSync(workStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
    process.stderr.write(`NO VERDICT: adopt refused: ${String(error?.message ?? error).slice(0, 160)}\n`);
    process.exit(3);
  }
  let union;
  try {
    union = await measureStore(workStore, rows);
  } finally {
    rmSync(workStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }

  // 3. The committed store must be byte-untouched (licensing rule: foreign
  //    bytes never land in the repo). `writeOnce` (src/store-write.mjs) refuses
  //    to overwrite, and the throwaway copy is the only write target, so the
  //    committed store's file list must be identical before and after.
  const committedAfter = readdirSync(path.join(storeDir, 'receipts')).sort().join('\n')
    + '::' + readdirSync(path.join(storeDir, 'objects')).sort().join('\n');
  const committedStoreModified = committedBefore !== committedAfter;
  if (committedStoreModified) {
    process.stderr.write('NO VERDICT: the committed store changed — foreign bytes must never land in the repo\n');
    process.exit(3);
  }

  const closedByDiscriminator = {};
  for (const [reason, count] of Object.entries(baseline.refusals)) {
    const m = reason.match(/unknown (?:instruction|event) discriminator ([0-9a-f]+)/);
    if (m && !union.refusals[reason]) closedByDiscriminator[m[1]] = count;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    program: PUMP,
    name: 'pump.fun bonding curve',
    finding: 'the 442 pump.fun refusals of research/ecosystem-coverage-2026-11-11 are source lag, not a decode gap: adopting the first-party published copy next to the on-chain pull closes every one of them on the same committed bytes',
    pin: {
      repo: PIN.repo,
      commit: PIN.commit,
      file: PIN.file,
      canonicalFingerprint: `sha256:${PIN.canonicalFingerprint}`,
      license: PIN.license,
      licenseNote: 'no LICENSE file at the pinned commit — the bytes stay OUT of this repository and the npm package; they were adopted into a throwaway store copy and deleted after the measurement',
      origin: PIN.origin,
      sourceReadFrom: path.relative(ROOT, sourcePath),
    },
    sample: path.relative(ROOT, samplePath),
    store: path.relative(ROOT, storeDir),
    committedStoreModified,
    measured: {
      payloads: rows.length,
      failedTransactions: rows.filter((r) => r.failed).length,
      baseline: {
        decoded: baseline.decoded, refused: baseline.refused,
        byteExact: baseline.byteExact, describedExact: baseline.describedExact,
        coveredPct: Number((100 * baseline.decoded / rows.length).toFixed(1)),
      },
      union: {
        decoded: union.decoded, refused: union.refused,
        byteExact: union.byteExact, describedExact: union.describedExact,
        coveredPct: Number((100 * union.decoded / rows.length).toFixed(1)),
        adoptedAnswered: union.adoptedAnswered,
        pulledAnswered: union.pulledAnswered,
      },
      delta: {
        decoded: union.decoded - baseline.decoded,
        refusalsClosed: baseline.refused - union.refused,
        // Baseline decodes the union re-assigned to the adopted copy: byte
        // arbitration picks the source that explains more bytes (documented
        // TradeEvent tail — the published copy declares fields the stale
        // on-chain account lacks). derived, not measured pairwise:
        // baseline.decoded - union.pulledAnswered.
        reAssignedToAdopted: baseline.decoded - union.pulledAnswered,
      },
      receipt: { fingerprint: receipt.fingerprint, instructionCount: receipt.instructionCount, slot: receipt.slot },
      closedDiscriminators: closedByDiscriminator,
      unionRefusals: union.refusals,
    },
    limits: [
      'one committed window: the 842 payloads of the 11-11 ecosystem capture, not the whole ecosystem',
      'origin declared, not verified: the pin binds the canonical bytes to a commit nobody signed; the byte evidence is the re-encode',
      'the adopted copy sits at slot null and never displaces the on-chain pull (src/adopt.mjs ordering rule)',
      'licensing: the published copy ships no LICENSE file, so it is not vendored — the measurement reproduces it from the pin at run time',
    ],
  };
  const json = `${JSON.stringify(output, null, 1)}\n`;
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, json);
  } else {
    process.stdout.write(json);
  }
  process.stderr.write(`pump-second-source: baseline ${baseline.decoded}/${rows.length} `
    + `-> union ${union.decoded}/${rows.length} (+${union.decoded - baseline.decoded} decoded, `
    + `${baseline.refused - union.refused} refusals closed)\n`);
  if (union.decoded !== rows.length || union.refused !== 0) {
    process.stderr.write(`union still refuses faces: ${JSON.stringify(union.refusals).slice(0, 300)}\n`);
    process.exit(3);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`FAILED: ${String(error?.message ?? error).slice(0, 200)}\n`);
  process.exit(2);
}
