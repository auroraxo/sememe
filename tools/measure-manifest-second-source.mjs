#!/usr/bin/env node
// measure-manifest-second-source.mjs — the acquisition queue's largest entry,
// measured end to end. Manifest (MNFSTqtC9…) is the single biggest
// no-interface face of research/ecosystem-coverage-2026-11-11.json: 307
// payloads, 307 no-interface, acquirable:false ("no on-chain IDL at either
// address"). The card names it GPL-3.0 → vendor refused, adopt-and-measure.
//
//   node tools/measure-manifest-second-source.mjs \
//     --source <fuzz/crucible/idls/manifest.json as read at the pinned commit> \
//     --client-source <client/idl/manifest.json as read at the SAME commit> \
//     --out research/manifest-second-source-2026-11-12.json
//
// FINDINGS THIS MEASUREMENT PINS (2026-11-12, committed fixtures + two
// caller-supplied files read at the pin; the tool itself never fetches):
//
//   1. BASELINE: the committed store holds no manifest interface at all —
//      all 307 payloads refuse with `no stored interface`. The tool pins the
//      wire face independently of the coverage artifact: first-byte counts
//      2:46 3:46 4:3 6:201 10:1 13:10. Baseline must reproduce the artifact's
//      own manifest face (0 decoded / 307 no-interface), else NO VERDICT.
//   2. UNION: adopting the program's OWN GENERATED WIRE TABLE
//      (Bonasa-Tech/manifest — the annotated successor of CKS-Systems/manifest,
//      the repo this program's research had already cited as upstream;
//      fuzz/crucible/idls/manifest.json @d4e908b3…) closes ALL 307: decoded
//      307/307, 0 refused, 307 byte-exact, offline. Names per discriminant:
//      Deposit 46, Withdraw 46, Swap 3, BatchUpdate 201, GlobalWithdraw 1,
//      SwapV2 10.
//   3. THE DEFECT FACE IS THE UPSTREAM'S OWN CLIENT COPY, MEASURED: at the
//      SAME commit client/idl/manifest.json lists BOTH "Swap" (value 4) and
//      "SwapV2" (value 4) — a duplicate 1-byte discriminant. Adopted into a
//      second throwaway store the product refuses EVERY payload by name
//      (`duplicate instruction discriminator 04 (Swap / SwapV2)`) — 0 decoded.
//      The client copy also adds a `traderIndexHint` option to ClaimSeat the
//      wire does not carry; it is excluded BY THIS GATE (no duplicate
//      discriminants) and its refusal is asserted against the real bytes, not
//      a synthetic one. An adopt-and-measure area that only ever shows the
//      sunny path would have trusted a table that matches no wire.
//
// METHOD (the two-store shape tools/measure-pfee-second-source.mjs proved,
// plus a third store for the defect face):
//
//   union:  throwaway copy of the committed store + `sememe adopt` of the
//           pinned wire-table copy through the product's ONE write path
//           (src/adopt.mjs: content-addressed, receipt `slot: null`, origin
//           declared — no on-chain pull exists to displace, but the receipt
//           still says exactly where the bytes did NOT come from);
//   defect: throwaway copy + adopt of the pinned CLIENT copy — the product
//           must refuse dispatch on every payload by name.
//
// LICENSING: Bonasa-Tech/manifest ships GPL-3.0 (LICENSE at the pin, measured
// via the API 2026-11-12). Copyleft bytes must NOT be vendored into this MIT
// repository or the npm package. Both source files are read at the pin OUTSIDE
// this repo by the test or the operator, verified against the pinned canonical
// fingerprints BEFORE any write, and adopted only into throwaway copies that
// get deleted. The committed store is byte-untouched (readdir before/after).
//
// Exit codes: 0 measured, 2 usage/IO, 3 NO VERDICT.

import { existsSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { adopt } from '../src/adopt.mjs';
import { decodeUnionPayload } from '../src/decode.mjs';
import { canonicalJson } from '../src/canonical.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MANIFEST = 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms';
const PIN = {
  repo: 'Bonasa-Tech/manifest', // annotated successor of CKS-Systems/manifest
  commit: 'd4e908b34f7a050d63cad38cb7175b2e88008465', // main head 2026-11-10
  license: 'GPL-3.0', // LICENSE at the pin — vendor stays OFF, adopt stays ON
  wireTable: {
    file: 'fuzz/crucible/idls/manifest.json',
    canonicalFingerprint: 'd13f0aed26ffd07112c4b2740549d8e58706aeb259024d755cd3ba7e35f0fc3e',
    origin: 'Bonasa-Tech/manifest@d4e908b34f7a050d63cad38cb7175b2e88008465:fuzz/crucible/idls/manifest.json',
    instructionCount: 15,
  },
  clientCopy: {
    file: 'client/idl/manifest.json',
    canonicalFingerprint: '9cc6490d7519f1917a14b3dfbe347320a4051d52e4d8b50a1c98b0670e60a028',
    origin: 'Bonasa-Tech/manifest@d4e908b34f7a050d63cad38cb7175b2e88008465:client/idl/manifest.json',
    instructionCount: 16,
    duplicatedDiscriminator: '04',
    duplicatedNames: ['Swap', 'SwapV2'],
  },
};
// The wire face: first-byte counts of the 307 committed payloads, and the
// names the union must return per discriminant.
const FACE_COUNTS = [
  { discriminator: '02', name: 'Deposit', count: 46 },
  { discriminator: '03', name: 'Withdraw', count: 46 },
  { discriminator: '04', name: 'Swap', count: 3 },
  { discriminator: '06', name: 'BatchUpdate', count: 201 },
  { discriminator: '0a', name: 'GlobalWithdraw', count: 1 },
  { discriminator: '0d', name: 'SwapV2', count: 10 },
];

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const canonicalFingerprintOf = (filePath) => {
  const json = canonicalJson(JSON.parse(readFileSync(filePath, 'utf8')));
  return createHash('sha256').update(Buffer.from(json + '\n')).digest('hex');
};

async function measureStore(storeDir, rows) {
  let decoded = 0; let refused = 0; let noInterface = 0; let duplicateRefusals = 0;
  let duplicateRefusalClause = null; let byteExact = 0; let describedExact = 0;
  let adoptedAnswered = 0; let pulledAnswered = 0;
  const refusals = {}; const names = {};
  for (const row of rows) {
    try {
      const out = await decodeUnionPayload(storeDir, MANIFEST, row.hex, { absent: 'verified' });
      decoded += 1;
      if (out.roundTripByteExact === true) byteExact += 1;
      if (out.describedRoundTripByteExact === true) describedExact += 1;
      const slot = out.idl?.slot;
      if (slot === null || slot === undefined) adoptedAnswered += 1; else pulledAnswered += 1;
      names[out.name] = (names[out.name] ?? 0) + 1;
    } catch (error) {
      const message = String(error?.message ?? error).replaceAll(`${ROOT}/`, '');
      // `no stored IDL` is the ACQUISITION face (nothing to read), not
      // a decode refusal — the coverage artifact counts it as noInterface.
      if (message.includes('no stored IDL') || message.includes('no-sememe-store')) {
        noInterface += 1;
      } else {
        refused += 1;
      }
      // The duplicate-dispatch refusal is named independently of the 110-
      // char key window: the defect face counts it per payload and keeps the
      // clause itself (the key window truncates it away).
      const duplicateClause = message.match(/duplicate instruction discriminator [0-9a-f]+ \([^)]*\)/);
      if (duplicateClause) {
        duplicateRefusals += 1;
        duplicateRefusalClause = duplicateClause[0];
      }
      const key = message.slice(0, 110);
      refusals[key] = (refusals[key] ?? 0) + 1;
    }
  }
  return { decoded, refused, noInterface, duplicateRefusals, duplicateRefusalClause, byteExact, describedExact, adoptedAnswered, pulledAnswered, refusals, names };
}

function withThrowawayStore(baseStore, name, fn) {
  const workStore = path.join(ROOT, 'research', `.manifest-${name}-store`);
  rmSync(workStore, { recursive: true, force: true });
  cpSync(baseStore, workStore, { recursive: true });
  return Promise.resolve()
    .then(() => fn(workStore))
    .finally(() => rmSync(workStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 }));
}

function duplicateDiscriminants(idl) {
  const seen = new Map();
  const duplicates = [];
  for (const instruction of idl.instructions ?? []) {
    const value = instruction?.discriminant?.value;
    if (!Number.isInteger(value)) continue;
    const key = value.toString(16).padStart(2, '0');
    if (seen.has(key)) duplicates.push({ discriminator: key, names: [seen.get(key), instruction.name] });
    else seen.set(key, instruction.name);
  }
  return duplicates;
}

async function main() {
  const samplePath = path.resolve(ROOT, opt('--sample', 'test/fixtures/ecosystem-sample-2026-11-11.json'));
  const storeDir = path.resolve(ROOT, opt('--store', 'test/fixtures/ecosystem-store-2026-11-11'));
  const sourceArg = opt('--source', null);
  const clientArg = opt('--client-source', null);
  const outPath = opt('--out', null);
  if (!sourceArg || !clientArg) {
    process.stderr.write('usage: measure-manifest-second-source.mjs --source <fuzz crucible idl at the pin> --client-source <client idl at the SAME pin> [--out artifact.json]\n(GPL-3.0 bytes are not vendored — read both from the pin, e.g. the GitHub contents API)\n');
    process.exit(2);
  }
  const sourcePath = path.resolve(sourceArg);
  const clientPath = path.resolve(clientArg);
  for (const [flag, p] of [['--source', sourcePath], ['--client-source', clientPath]]) {
    if (!existsSync(p)) {
      process.stderr.write(`NO VERDICT: ${flag} file missing: ${p}\n`);
      process.exit(3);
    }
  }

  // 0. Pin checks BEFORE any write. Both copies must canonicalize to the
  //    pinned fingerprints (a truncated or hand-edited copy refuses — the
  //    tests falsify this gate) and must declare the manifest program.
  const wireFingerprint = canonicalFingerprintOf(sourcePath);
  if (wireFingerprint !== PIN.wireTable.canonicalFingerprint) {
    process.stderr.write(`NO VERDICT: manifest-pin-hash-mismatch (wire table): pinned ${PIN.wireTable.canonicalFingerprint}, `
      + `hashed now ${wireFingerprint} — refusing to measure bytes nobody reviewed\n`);
    process.exit(3);
  }
  const clientFingerprint = canonicalFingerprintOf(clientPath);
  if (clientFingerprint !== PIN.clientCopy.canonicalFingerprint) {
    process.stderr.write(`NO VERDICT: manifest-pin-hash-mismatch (client copy): pinned ${PIN.clientCopy.canonicalFingerprint}, `
      + `hashed now ${clientFingerprint} — refusing to measure bytes nobody reviewed\n`);
    process.exit(3);
  }
  const wireIdl = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const clientIdl = JSON.parse(readFileSync(clientPath, 'utf8'));
  for (const [label, idl] of [['wire table', wireIdl], ['client copy', clientIdl]]) {
    const declared = idl.address ?? idl?.metadata?.address;
    if (declared !== MANIFEST) {
      process.stderr.write(`NO VERDICT: the ${label} declares another program: ${declared}\n`);
      process.exit(3);
    }
  }
  // The defect face is part of the pin: the client copy MUST carry exactly
  // the claimed duplicate, and the wire table MUST NOT. A pin bump that
  // changes either refuses here instead of quietly measuring a different
  // premise.
  const clientDuplicates = duplicateDiscriminants(clientIdl);
  const expectedDuplicate = clientDuplicates.find(
    (d) => d.discriminator === PIN.clientCopy.duplicatedDiscriminator
      && JSON.stringify(d.names) === JSON.stringify(PIN.clientCopy.duplicatedNames),
  );
  if (!expectedDuplicate) {
    process.stderr.write(`NO VERDICT: the pinned client copy no longer carries the claimed duplicate ${PIN.clientCopy.duplicatedDiscriminator} (${PIN.clientCopy.duplicatedNames.join(' / ')}) — the defect face moved, re-measure before claiming it\n`);
    process.exit(3);
  }
  if (duplicateDiscriminants(wireIdl).length !== 0) {
    process.stderr.write('NO VERDICT: the pinned wire table itself carries duplicate instruction discriminators\n');
    process.exit(3);
  }

  const sample = JSON.parse(await readFile(samplePath, 'utf8'));
  const rows = [];
  const firstByte = new Map();
  for (const tx of sample.transactions ?? []) {
    for (const p of tx.payloads ?? []) {
      if (p.program === MANIFEST) {
        rows.push({ hex: p.dataHex, failed: tx.failed === true });
        const b = p.dataHex.slice(0, 2);
        firstByte.set(b, (firstByte.get(b) ?? 0) + 1);
      }
    }
  }
  if (rows.length === 0) {
    process.stderr.write('NO VERDICT: the sample carries no manifest payloads\n');
    process.exit(3);
  }

  // The measured wire face must equal the pinned face.
  const expectedFace = new Map(FACE_COUNTS.map((f) => [f.discriminator, f.count]));
  const faceMatches = expectedFace.size === firstByte.size
    && [...expectedFace.entries()].every(([k, v]) => firstByte.get(k) === v);
  if (!faceMatches) {
    process.stderr.write(`NO VERDICT: the sample's manifest face moved: measured ${JSON.stringify([...firstByte.entries()].sort())} `
      + `vs pinned ${JSON.stringify([...expectedFace.entries()].sort())}\n`);
    process.exit(3);
  }

  // 1. Baseline: the committed store must reproduce the artifact's own
  //    manifest face — 0 decoded, and every payload a no-interface refusal.
  const coverage = JSON.parse(await readFile(path.resolve(ROOT, 'research/ecosystem-coverage-2026-11-11.json'), 'utf8'));
  const entry = (coverage.programs ?? []).find((p) => p.program === MANIFEST);
  const baseline = await measureStore(storeDir, rows);
  if (!entry
    || baseline.decoded !== entry.decoded
    || baseline.noInterface !== entry.noInterface
    || Number(entry.refused) !== 0) {
    process.stderr.write(`NO VERDICT: baseline does not reproduce the committed artifact `
      + `(measured ${baseline.decoded} decoded / ${baseline.noInterface} no-interface / ${baseline.refused} refused vs artifact `
      + `${entry?.decoded} decoded / ${entry?.noInterface} no-interface / ${entry?.refused} refused)\n`);
    process.exit(3);
  }

  const storeState = () => readdirSync(path.join(storeDir, 'receipts')).sort().join('\n')
    + '::' + readdirSync(path.join(storeDir, 'objects')).sort().join('\n');
  const committedBefore = storeState();

  // 2. Union: throwaway copy + ONE adopt of the wire table.
  let receipt; let union;
  union = await withThrowawayStore(storeDir, 'union', async (workStore) => {
    receipt = await adopt(MANIFEST, sourcePath, workStore, { source: 'published', origin: PIN.wireTable.origin });
    return measureStore(workStore, rows);
  }).catch(async (error) => {
    process.stderr.write(`NO VERDICT: adopt refused: ${String(error?.message ?? error).slice(0, 160)}\n`);
    process.exit(3);
  });

  // 3. Defect face: throwaway copy + adopt of the CLIENT copy — the product
  //    must refuse EVERY payload naming the duplicate discriminant.
  const defect = await withThrowawayStore(storeDir, 'defect', async (workStore) => {
    await adopt(MANIFEST, clientPath, workStore, { source: 'published', origin: PIN.clientCopy.origin });
    return measureStore(workStore, rows);
  });
  const duplicateRefusalKey = defect.duplicateRefusalClause;
  const defectRefusesByName = defect.duplicateRefusals === rows.length
    && defect.decoded === 0
    && defect.refused === rows.length;
  // (the client copy IS stored there — a duplicate-dispatch refusal is a
  // DECODE refusal, not a no-interface face, so it lands in `refused`)

  const committedAfter = storeState();
  const committedStoreModified = committedBefore !== committedAfter;
  if (committedStoreModified) {
    process.stderr.write('NO VERDICT: the committed store changed — foreign bytes must never land in the repo\n');
    process.exit(3);
  }

  const namesMatch = FACE_COUNTS.every((f) => (union.names[f.name] ?? 0) === f.count)
    && Object.keys(union.names).length === FACE_COUNTS.length;
  const unionFullyCloses = union.decoded === rows.length && union.refused === 0 && union.noInterface === 0 && union.byteExact === rows.length;

  const gates = {
    baselineReproducesArtifact: baseline.decoded === entry.decoded && baseline.noInterface === entry.noInterface,
    faceMatchesPinnedWire: faceMatches,
    unionFullyCloses,
    namesMatchFace: namesMatch,
    defectRefusesByName: defectRefusesByName,
    receiptSlotNull: receipt?.slot === null,
    committedStoreUntouched: !committedStoreModified,
  };
  const allGates = Object.values(gates).every(Boolean);

  const output = {
    generatedAt: new Date().toISOString(),
    program: MANIFEST,
    name: 'manifest',
    finding: 'the acquisition queue\'s largest no-interface face is not a decode gap: the program\'s own generated wire table (Bonasa-Tech/manifest fuzz/crucible idl, GPL-3.0, same commit as the client copy) decodes all 307 committed payloads byte-exactly via one adopt through the product write path; the same repo\'s client/idl/manifest.json at the SAME commit lists Swap and SwapV2 on discriminator 04 and the product refuses every payload by name — adopt-and-measure includes the defect face, not just the sunny path',
    pin: {
      repo: PIN.repo,
      commit: PIN.commit,
      license: PIN.license,
      licenseNote: 'GPL-3.0 at the pin — the bytes stay OUT of this repository and the npm package; both copies were adopted into throwaway store copies and deleted after the measurement',
      wireTable: { ...PIN.wireTable, canonicalFingerprint: `sha256:${PIN.wireTable.canonicalFingerprint}`, sourceReadFrom: 'read outside the repository at the pinned commit (GitHub contents API; path not recorded)' },
      clientCopy: { ...PIN.clientCopy, canonicalFingerprint: `sha256:${PIN.clientCopy.canonicalFingerprint}`, sourceReadFrom: 'read outside the repository at the pinned commit (GitHub contents API; path not recorded)' },
    },
    sample: path.relative(ROOT, samplePath),
    store: path.relative(ROOT, storeDir),
    committedStoreModified,
    measured: {
      payloads: rows.length,
      failedTransactions: rows.filter((r) => r.failed).length,
      baseline: {
        decoded: baseline.decoded,
        refused: baseline.refused,
        noInterface: baseline.noInterface,
        coveredPct: Number((100 * baseline.decoded / rows.length).toFixed(1)),
        refusalShape: Object.fromEntries(
          Object.entries(baseline.refusals)
            .map(([k, v]) => [k.replaceAll(path.resolve(storeDir), path.relative(ROOT, storeDir)), v])),
      },
      union: {
        decoded: union.decoded,
        refused: union.refused,
        noInterface: union.noInterface,
        byteExact: union.byteExact,
        describedExact: union.describedExact,
        coveredPct: Number((100 * union.decoded / rows.length).toFixed(1)),
        adoptedAnswered: union.adoptedAnswered,
        pulledAnswered: union.pulledAnswered,
        names: union.names,
      },
      defect: {
        decoded: defect.decoded,
        refused: defect.refused,
        refusalNamed: duplicateRefusalKey ?? null,
      },
      defect: {
        decoded: defect.decoded,
        refused: defect.refused,
        noInterface: defect.noInterface,
        duplicateRefusals: defect.duplicateRefusals,
        refusalNamed: duplicateRefusalKey ?? null,
      },
      delta: {
        decoded: union.decoded - baseline.decoded,
        refusalsClosed: baseline.noInterface - union.noInterface,
      },
    },
    face: FACE_COUNTS,
    receipt: {
      slot: receipt?.slot,
      instructionCount: receipt?.instructionCount,
      fingerprint: receipt?.fingerprint,
      origin: receipt?.origin,
      originStatus: receipt?.originStatus,
    },
    gates,
  };

  if (outPath) {
    await writeFile(outPath, JSON.stringify(output, null, 1) + '\n');
    process.stdout.write(`measured: union ${union.decoded}/${union.byteExact} byte-exact, defect refuses ${defect.refused}/${rows.length} — ${outPath}\n`);
  } else {
    process.stdout.write(JSON.stringify(output, null, 1) + '\n');
  }
  process.exit(allGates ? 0 : 3);
}

main().catch((error) => {
  process.stderr.write(`NO VERDICT: ${String(error?.stack ?? error).slice(0, 400)}\n`);
  process.exit(3);
});
