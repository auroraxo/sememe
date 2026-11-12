#!/usr/bin/env node
// measure-archer-second-source.mjs — the acquisition queue's THIRD no-interface
// face, measured end to end.
//
// Archer (Archer8kgiavM61GyusMzaaS2ft5sALtNsD1HxkUPMhy) is listed in
// research/ecosystem-coverage-2026-11-11.json with 83 payloads, 0 decoded,
// 83 no-interface, acquirable:false ("no on-chain IDL at either address").
// Its own SDK — ballista-tech/archer-sdk, Apache-2.0, the crate that declares
// `ARCHER_V1_PROGRAM_ID = pubkey!("Archer8kgiavM61GyusMzaaS2ft5sALtNsD1HxkUPMhy")`
// in src/lib.rs — ships idl/archer_v1.json, a SHANK-dialect interface
// (metadata.origin = "shank", one-byte `discriminant` per instruction).
//
//   node tools/measure-archer-second-source.mjs \
//     --source <idl/archer_v1.json as read at the pinned commit> \
//     --out research/archer-second-source-2026-11-12.json
//
// FINDINGS THIS MEASUREMENT PINS (2026-11-12, committed fixtures + one
// caller-supplied file read at the pin; the tool itself never fetches):
//
//   1. BASELINE: the committed store holds NO archer interface at all — all
//      83 payloads refuse with `no stored interface`. The tool pins the wire
//      face independently of the coverage artifact: one-byte shank tag + exact
//      payload length. Tag 8 (UpdateMidPrice) x78 at 17 bytes, tag 7
//      (UpdateBook) x3 at 536 bytes, tag 9 (ClearBook) x1 at 9 bytes, tag 15
//      (Swap) x1 at 19 bytes. Baseline must reproduce the artifact's own
//      archer face (0 decoded / 83 no-interface), else NO VERDICT.
//   2. UNION: adopting the program's OWN SDK interface through the product's
//      ONE write path (src/adopt.mjs) closes 82 of 83 payloads BYTE-EXACTLY,
//      offline, with no rename: UpdateMidPrice 78, UpdateBook 3, ClearBook 1.
//      The one refusal is the interface's OWN documented legacy wire form:
//      the IDL's SwapParams docstring says "Borsh args for Swap and
//      SwapFromArcherAccount, 22 bytes. The program also accepts an 18-byte
//      payload that stops after `mode` … it is read as a 0 fee", and the
//      chain-accepted witness payload is exactly 19 bytes on the wire
//      (1 shank tag + 18 bytes of args). sememe refuses it with `truncated
//      input` because the missing field is INSIDE a defined struct, and the
//      absent-field policy is plumbed only through top-level instruction
//      arguments — a gap this measurement names rather than hides.
//   3. THE DEFECT FACE IS MEASURED, NOT ASSUMED: the product must NOT accept
//      the 19-byte Swap form just because the upstream DOCS mention it. The
//      absent-field path refuses it, and the refusal names the field and the
//      offset. An adopt-and-measure area that only ever shows the sunny path
//      would have papered over a decoder that cannot represent a short form
//      inside a struct.
//
// METHOD (the two-store shape tools/measure-manifest-second-source.mjs
// proved):
//
//   union:  throwaway copy of the committed store + `sememe adopt` of the
//           pinned SDK interface through the product's write path
//           (src/adopt.mjs: content-addressed, receipt `slot: null`, origin
//           declared — no on-chain pull exists to displace, but the receipt
//           still says exactly where the bytes did NOT come from).
//
// LICENSING: ballista-tech/archer-sdk is Apache-2.0 at the pin (Cargo.toml
// `license = "Apache-2.0"`). The bytes are still NOT vendored into this
// repository or the npm package: they are read at the pin OUTSIDE this repo
// by the test or the operator, verified against the pinned canonical
// fingerprint BEFORE any write, and adopted only into throwaway copies that
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

const ARCHER = 'Archer8kgiavM61GyusMzaaS2ft5sALtNsD1HxkUPMhy';
const PIN = {
  repo: 'ballista-tech/archer-sdk',
  commit: '5d07c895207ebd02f1ce70078b2d0c1ec3f186b5',
  license: 'Apache-2.0',
  dialect: 'shank',
  interface: {
    file: 'idl/archer_v1.json',
    canonicalFingerprint: '4354dc49ea9a9294960aca0f595e3ed4523046506572a028550c2318ded1a805',
    origin: 'ballista-tech/archer-sdk@5d07c895207ebd02f1ce70078b2d0c1ec3f186b5:idl/archer_v1.json',
    instructionCount: 27,
    typeCount: 19,
  },
};
// The wire face: one-byte shank tag + exact payload length + the name the
// union must return. Measured independently of the coverage artifact.
const FACE_COUNTS = [
  { tag: '07', name: 'UpdateBook', length: 536, count: 3 },
  { tag: '08', name: 'UpdateMidPrice', length: 17, count: 78 },
  { tag: '09', name: 'ClearBook', length: 9, count: 1 },
  { tag: '0f', name: 'Swap', length: 19, count: 1 },
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
  let decoded = 0; let refused = 0; let noInterface = 0;
  let byteExact = 0; let describedExact = 0;
  let adoptedAnswered = 0; let pulledAnswered = 0;
  let truncatedRefusals = 0; let truncatedRefusalClause = null;
  const refusals = {}; const names = {};
  for (const row of rows) {
    try {
      const out = await decodeUnionPayload(storeDir, ARCHER, row.hex, { absent: 'verified' });
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
      // The legacy Swap form is counted on the FULL message, before the
      // key window: the origin label alone can push `truncated input`
      // past 140 characters and the defect face would vanish by slicing.
      if (message.includes('truncated input')) {
        truncatedRefusals += 1;
        truncatedRefusalClause = (message.match(/truncated input[^)]*/) ?? [null])[0];
      }
      const key = message.slice(0, 140);
      refusals[key] = (refusals[key] ?? 0) + 1;
    }
  }
  return { decoded, refused, noInterface, byteExact, describedExact, adoptedAnswered, pulledAnswered, truncatedRefusals, truncatedRefusalClause, refusals, names };
}

function withThrowawayStore(baseStore, name, fn) {
  const workStore = path.join(ROOT, 'research', `.archer-${name}-store`);
  rmSync(workStore, { recursive: true, force: true });
  cpSync(baseStore, workStore, { recursive: true });
  return Promise.resolve()
    .then(() => fn(workStore))
    .finally(() => rmSync(workStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 }));
}

async function main() {
  const samplePath = path.resolve(ROOT, opt('--sample', 'test/fixtures/ecosystem-sample-2026-11-11.json'));
  const storeDir = path.resolve(ROOT, opt('--store', 'test/fixtures/ecosystem-store-2026-11-11'));
  const sourceArg = opt('--source', null);
  const outPath = opt('--out', null);
  if (!sourceArg) {
    process.stderr.write('usage: measure-archer-second-source.mjs --source <idl/archer_v1.json at the pin> [--out artifact.json]\n(Apache-2.0 bytes are not vendored — read the file at the pin, e.g. the GitHub contents API)\n');
    process.exit(2);
  }
  const sourcePath = path.resolve(sourceArg);
  if (!existsSync(sourcePath)) {
    process.stderr.write(`NO VERDICT: source file missing: ${sourcePath}\n`);
    process.exit(3);
  }

  // 0. Pin checks BEFORE any write. The copy must canonicalize to the pinned
  //    fingerprint (a truncated or hand-edited copy refuses — the tests
  //    falsify this gate), must declare the archer program, and must be in
  //    the shank dialect the measurement claims to exercise.
  const fingerprint = canonicalFingerprintOf(sourcePath);
  if (fingerprint !== PIN.interface.canonicalFingerprint) {
    process.stderr.write(`NO VERDICT: archer-pin-hash-mismatch: pinned ${PIN.interface.canonicalFingerprint}, `
      + `hashed now ${fingerprint} — refusing to measure bytes nobody reviewed\n`);
    process.exit(3);
  }
  const idl = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const declared = idl.address ?? idl?.metadata?.address;
  if (declared !== ARCHER) {
    process.stderr.write(`NO VERDICT: the pinned interface declares another program: ${declared}\n`);
    process.exit(3);
  }
  if ((idl?.metadata?.origin ?? null) !== PIN.dialect) {
    process.stderr.write(`NO VERDICT: the pinned interface is not in the ${PIN.dialect} dialect: ${JSON.stringify(idl?.metadata?.origin)}\n`);
    process.exit(3);
  }
  if (idl.instructions.length !== PIN.interface.instructionCount) {
    process.stderr.write(`NO VERDICT: the pinned interface carries ${idl.instructions.length} instruction(s), pinned ${PIN.interface.instructionCount}\n`);
    process.exit(3);
  }

  const sample = JSON.parse(await readFile(samplePath, 'utf8'));
  const rows = [];
  const face = new Map();
  for (const tx of sample.transactions ?? []) {
    for (const p of tx.payloads ?? []) {
      if (p.program === ARCHER) {
        rows.push({ hex: p.dataHex, failed: tx.failed === true });
        const raw = Buffer.from(p.dataHex, 'hex');
        const key = `${raw[0].toString(16).padStart(2, '0')}:${raw.length}`;
        face.set(key, (face.get(key) ?? 0) + 1);
      }
    }
  }
  if (rows.length === 0) {
    process.stderr.write('NO VERDICT: the sample carries no archer payloads\n');
    process.exit(3);
  }

  // The measured wire face must equal the pinned face.
  const expectedFace = new Map(FACE_COUNTS.map((f) => [`${f.tag}:${f.length}`, f.count]));
  const faceMatches = expectedFace.size === face.size
    && [...expectedFace.entries()].every(([k, v]) => face.get(k) === v);
  if (!faceMatches) {
    process.stderr.write(`NO VERDICT: the sample's archer face moved: measured ${JSON.stringify([...face.entries()].sort())} `
      + `vs pinned ${JSON.stringify([...expectedFace.entries()].sort())}\n`);
    process.exit(3);
  }

  // 1. Baseline: the committed store must reproduce the artifact's own
  //    archer face — 0 decoded, and every payload a no-interface refusal.
  const coverage = JSON.parse(await readFile(path.resolve(ROOT, 'research/ecosystem-coverage-2026-11-11.json'), 'utf8'));
  const entry = (coverage.programs ?? []).find((p) => p.program === ARCHER);
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

  // 2. Union: throwaway copy + ONE adopt of the program's own SDK interface.
  let receipt; let union;
  union = await withThrowawayStore(storeDir, 'union', async (workStore) => {
    receipt = await adopt(ARCHER, sourcePath, workStore, { source: 'published', origin: PIN.interface.origin });
    return measureStore(workStore, rows);
  }).catch(async (error) => {
    process.stderr.write(`NO VERDICT: adopt refused: ${String(error?.message ?? error).slice(0, 160)}\n`);
    process.exit(3);
  });

  const committedAfter = storeState();
  const committedStoreModified = committedBefore !== committedAfter;
  if (committedStoreModified) {
    process.stderr.write('NO VERDICT: the committed store changed — foreign bytes must never land in the repo\n');
    process.exit(3);
  }

  // The short Swap form must stay a NAMED refusal: the tool refuses to let
  // a docstring in an upstream IDL decide that a wire form is decodable.
  const swapRefusal = Object.entries(union.refusals).find(([key]) => key.includes('truncated input'));
  const legacySwapRefused = union.truncatedRefusals === 1
    && /builderFeePpm|need 4 byte/.test(String(union.truncatedRefusalClause ?? ''))
    && union.decoded === rows.length - 1
    && union.byteExact === rows.length - 1;

  const namesMatch = FACE_COUNTS.every((f) => (union.names[f.name] ?? 0) === f.count - (f.tag === '0f' ? 1 : 0))
    && Object.keys(union.names).length === FACE_COUNTS.length - 1;

  const gates = {
    baselineReproducesArtifact: baseline.decoded === entry.decoded && baseline.noInterface === entry.noInterface,
    faceMatchesPinnedWire: faceMatches,
    unionClosesAllButLegacySwap: union.decoded === rows.length - 1,
    unionByteExactOnWhatItDecodes: union.byteExact === union.decoded,
    namesMatchFace: namesMatch,
    legacySwapStaysRefused: legacySwapRefused,
    receiptSlotNull: receipt?.slot === null,
    receiptOriginDeclared: receipt?.originStatus === 'declared',
    committedStoreUntouched: !committedStoreModified,
  };
  const allGates = Object.values(gates).every(Boolean);

  const output = {
    generatedAt: new Date().toISOString(),
    program: ARCHER,
    name: 'archer',
    finding: "the acquisition queue's third no-interface face closes through the program's OWN SDK interface: ballista-tech/archer-sdk (Apache-2.0, the crate that declares this exact program id) ships idl/archer_v1.json in the shank dialect; ONE adopt through the product write path decodes 82 of 83 committed payloads byte-exactly (UpdateMidPrice 78, UpdateBook 3, ClearBook 1), and the remaining one — the 19-byte legacy Swap form the upstream interface documents as '22 bytes, but an 18-byte payload that stops after mode is also accepted' — stays a NAMED refusal, because the missing field sits inside a defined struct where sememe's absent-field policy does not reach",
    pin: {
      repo: PIN.repo,
      commit: PIN.commit,
      license: PIN.license,
      dialect: PIN.dialect,
      file: PIN.interface.file,
      canonicalFingerprint: PIN.interface.canonicalFingerprint,
      origin: PIN.interface.origin,
      instructionCount: PIN.interface.instructionCount,
      typeCount: PIN.interface.typeCount,
    },
    face: FACE_COUNTS,
    measured: {
      payloads: rows.length,
      baseline,
      union,
      receipt: receipt ? {
        slot: receipt.slot,
        source: receipt.source,
        origin: receipt.origin,
        originStatus: receipt.originStatus,
        fingerprint: receipt.fingerprint,
        instructionCount: receipt.instructionCount,
      } : null,
      committedStoreModified,
      legacySwapRefusal: union.truncatedRefusalClause,
      legacySwapRefusalCount: union.truncatedRefusals,
    },
    delta: {
      decoded: union.decoded - baseline.decoded,
      refusalsClosed: baseline.noInterface - union.noInterface - union.refused,
      coveredPct: baseline.noInterface === 0 ? 0 : Math.round(((union.decoded) / rows.length) * 10000) / 100,
    },
    gates,
    verdict: allGates ? 'measured' : 'NO VERDICT',
  };

  if (outPath) {
    await writeFile(path.resolve(ROOT, outPath), `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
  if (!allGates) process.exit(3);
}

main().catch((error) => {
  process.stderr.write(`NO VERDICT: ${String(error?.message ?? error).slice(0, 200)}\n`);
  process.exit(3);
});
