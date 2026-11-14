#!/usr/bin/env node
// measure-hadron-adoption.mjs — WHY sememe REPORTS 144 chain-accepted HADRo
// payloads byte-EXACTLY only after the first-party published copy is adopted,
// and why neither half of the two fixes that got here is sufficient alone.
//
// THE GAP THIS MEASURES (product face, offline, committed fixtures)
//
//   The on-chain metadata IDL (receipt at slot 468262003) declares every
//   instruction and every type — and lacks EXACTLY TWO argument declarations:
//   `sequence: u64` as the last argument of setCurve and setRiskCurve. The
//   wire carries those 8 bytes after the points, so with the stored copy:
//
//     144/144 committed chain-accepted payloads decode, 0 refused
//     144/144 end with 8 unexplained trailing bytes
//       0/144 round-trip byte-exact (the tail is dropped on re-encode)
//     144/144 REFUSED under --trailing error
//
// THE FOUR-FACE LADDER (every face the same 144 payloads, identified by
// discriminator byte ONLY so no face's decoder chooses another face's rows)
//
//   F1  prefix tree ea074c4 + stored IDL    72 decoded / 72 refused /  0 exact
//       setRiskCurve answers with a garbage Borsh length — the pre-fix defect.
//   F2  prefix tree ea074c4 + first-party   72 decoded / 72 refused /  0 exact
//       THE FIRST-PARTY COPY ALONE FIXES NOTHING: it declares `points` as a
//       Borsh vec too, so it refuses the same 72 payloads. This is the face
//       that falsifies "just adopt the source IDL".
//   F3  current tree + stored IDL          144 decoded /  0 refused /  0 exact
//       count-from-header closed the refusals; the tail is still unnamed, so
//       every payload keeps 8 trailing bytes and 0 round-trips byte-exact.
//   F4  current tree + first-party IDL     144 decoded /  0 refused / 144 exact
//       THE TWO FIXES COMPOSE. count-from-header supplies the no-prefix
//       vector read; the first-party copy supplies the `sequence: u64` tail.
//
//   F1+F2 falsify "the source copy alone is the fix"; F3 alone falsifies
//   "the header rule alone is the fix". Only F4 reproduces every byte.
//
// THE USER FACE (product's own write path, src/adopt.mjs)
//
//   before adoption: union decodes 144/144 but 0 byte-exact, 144 with 8
//   trailing bytes; --trailing error refuses 144/144.
//   after  adoption: union reproduces 144/144 byte-exact, 0 trailing,
//   0 refusals under --trailing error, verdict `layout_drift` with
//   drift.paths ["sequence"] — the disagreement with the on-chain copy is
//   NAMED, not silently resolved, and the on-chain copy stays the default
//   single-source answer (plain decode unchanged: the slot-0 ordering rule).
//
// Exit codes: 0 measured and verified; 1 falsified; 2 usage/IO;
//   3 NO VERDICT (prefix commit unreachable, fixtures missing).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};

const OUT = flag('--out', path.join(ROOT, 'research', 'hadron-adoption-2026-11-14.json'));
const PREFIX = flag('--prefix', 'ea074c4');
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');

class NoVerdict extends Error {}

const HADRON = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';
// Discriminator byte only: neither tree's decoder decides which rows exist.
const DISC = new Set(['04', '08']);

function rows() {
  if (!existsSync(SAMPLE)) throw new NoVerdict(`fixture missing: ${SAMPLE}`);
  const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const out = [];
  for (const tx of Object.values(sample.transactions ?? {})) {
    for (const payload of tx.payloads ?? []) {
      if (payload.program === HADRON && DISC.has(String(payload.dataHex).slice(0, 2))) {
        out.push(payload.dataHex);
      }
    }
  }
  if (out.length !== 144) {
    throw new NoVerdict(`expected the measured 144 payloads, found ${out.length} — the fixture moved`);
  }
  return out;
}

function storedIdlPath() {
  const dir = path.join(STORE, 'receipts');
  if (!existsSync(dir)) throw new NoVerdict(`store missing: ${dir}`);
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${HADRON}-`)) continue;
    const receipt = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    const object = path.join(STORE, 'objects', `${receipt.fingerprint.replace('sha256:', '')}.json`);
    if (existsSync(object)) return object;
  }
  throw new NoVerdict('the on-chain HADRo receipt is not in the committed store');
}

function extractPrefix(commit, dir) {
  const probe = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
  if (probe.status !== 0) {
    spawnSync('git', ['fetch', '--depth=50', 'origin', commit], { cwd: ROOT, stdio: 'ignore' });
    const recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    if (recheck.status !== 0) throw new NoVerdict(`prefix commit ${commit} is neither local nor fetchable`);
  }
  const archive = spawnSync('git', ['archive', commit], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new NoVerdict(`git archive ${commit} failed`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new NoVerdict(`unpacking the prefix tree failed: ${untar.stderr}`);
}

/**
 * One face of the ladder: decode + re-encode every row with ONE tree and ONE
 * idl. Returns counts only — a face that reported payload bytes could not be
 * compared byte-for-byte across trees, which is the whole point of the ladder.
 */
async function face(treeRoot, idlPath, dataHex) {
  const { decodeInstructionData, encodeInstructionData } = await import(path.join(treeRoot, 'src', 'codec.mjs'));
  const idl = JSON.parse(readFileSync(idlPath, 'utf8'));
  const result = { decoded: 0, refused: 0, byteExact: 0, trailing: {}, refusalReasons: {} };
  for (const hex of dataHex) {
    const bytes = Buffer.from(hex, 'hex');
    try {
      const decoded = decodeInstructionData(idl, bytes, { trailing: 'report' });
      result.decoded += 1;
      const reencoded = encodeInstructionData(idl, decoded.instruction, decoded.args, {});
      if (reencoded.equals(bytes)) result.byteExact += 1;
      const trailing = decoded.trailing?.count ?? 0;
      result.trailing[trailing] = (result.trailing[trailing] ?? 0) + 1;
    } catch (error) {
      result.refused += 1;
      // Reason families only (name + the first token after it), so the artifact
      // carries no payload bytes and no per-payload prose.
      const message = String(error?.message ?? error);
      const key = `${decodedOrInstruction(message)} ${message.includes('vector length') ? 'vector length' : 'refused'}`;
      result.refusalReasons[key] = (result.refusalReasons[key] ?? 0) + 1;
    }
  }
  return result;
}

function decodedOrInstruction(message) {
  const match = /^(setCurve|setRiskCurve)/.exec(message);
  return match ? match[1] : 'other';
}

async function main() {
  const dataHex = rows();
  const stored = storedIdlPath();
  // The vendored copy is located by the pin itself, never by a hard-coded
  // path: a commit that moves in one place and not the other would measure a
  // different file than the product adopts.
  const { loadVendoredHadron } = await import(path.join(ROOT, 'src', 'hadron.mjs'));
  const vendor = loadVendoredHadron().path;

  const falsifications = [];

  // --- the four-face ladder ------------------------------------------------
  const prefixDir = mkdtempSync(path.join(tmpdir(), 'sememe-prefix-'));
  let F1;
  let F2;
  try {
    extractPrefix(PREFIX, prefixDir);
    F1 = await face(prefixDir, stored, dataHex);
    F2 = await face(prefixDir, vendor, dataHex);
  } finally {
    rmSync(prefixDir, { recursive: true, force: true });
  }
  const F3 = await face(ROOT, stored, dataHex);
  const F4 = await face(ROOT, vendor, dataHex);

  if (F1.decoded !== 72 || F1.refused !== 72) falsifications.push(`F1 expected 72/72, got ${F1.decoded}/${F1.refused}`);
  if (F1.byteExact !== 0) falsifications.push(`F1 expected 0 byte-exact, got ${F1.byteExact}`);
  if (F2.decoded !== 72 || F2.refused !== 72) falsifications.push(`F2 (first-party alone) expected 72/72, got ${F2.decoded}/${F2.refused}`);
  if (F2.byteExact !== 0) falsifications.push(`F2 (first-party alone) expected 0 byte-exact, got ${F2.byteExact}`);
  if (F3.decoded !== 144 || F3.refused !== 0) falsifications.push(`F3 expected 144/0, got ${F3.decoded}/${F3.refused}`);
  if (F3.byteExact !== 0) falsifications.push(`F3 (header rule alone) expected 0 byte-exact, got ${F3.byteExact}`);
  if (F3.trailing[8] !== 144) falsifications.push(`F3 expected 144 payloads with 8 trailing bytes, got ${F3.trailing[8] ?? 0}`);
  if (F4.decoded !== 144 || F4.refused !== 0) falsifications.push(`F4 expected 144/0, got ${F4.decoded}/${F4.refused}`);
  if (F4.byteExact !== 144) falsifications.push(`F4 expected 144 byte-exact, got ${F4.byteExact}`);
  if ((F4.trailing[0] ?? 0) !== 144) falsifications.push(`F4 expected 144 payloads with 0 trailing, got ${F4.trailing[0] ?? 0}`);

  // --- the user face: the product's own write path ------------------------
  const { adopt } = await import(path.join(ROOT, 'src', 'adopt.mjs'));
  const { decodeUnionPayload, decodePayload } = await import(path.join(ROOT, 'src', 'decode.mjs'));
  const { HADRON_MISSING_ARGS } = await import(path.join(ROOT, 'src', 'hadron.mjs'));
  const scratch = mkdtempSync(path.join(tmpdir(), 'sememe-hadron-store-'));
  let before;
  let after;
  let strictBefore = 0;
  let strictAfter = 0;
  let plainBefore;
  let plainAfter;
  let driftPaths = null;
  let winner = null;
  try {
    // Copy the committed store so the measured "before" face is the real
    // product default, not an empty directory. `cp -r STORE/. scratch/` (the
    // store CONTENTS, not the directory) — scratch already exists as mkdtemp
    // made it, so a plain `cp -r STORE scratch` would nest it one level deep
    // and every read would fail with "no sememe store".
    const copied = spawnSync('cp', ['-r', `${STORE}/.`, scratch]);
    if (copied.status !== 0) throw new NoVerdict(`copying the committed store failed: ${copied.stderr}`);
    const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    const beforeByteExact = [];
    const afterByteExact = [];
    for (const hex of dataHex) {
      const view = await decodeUnionPayload(scratch, HADRON, hex, { trailing: 'report' });
      beforeByteExact.push(view.roundTripByteExact);
      if (view.trailing?.count > 0) { /* counted below */ }
      try {
        await decodeUnionPayload(scratch, HADRON, hex, { trailing: 'error' });
      } catch { strictBefore += 1; }
      const plain = await decodePayload(scratch, HADRON, hex, {});
      plainBefore ??= { byteExact: 0, trailing: {} };
      if (plain.roundTripByteExact) plainBefore.byteExact += 1;
      plainBefore.trailing[plain.trailing?.count ?? 0] = (plainBefore.trailing[plain.trailing?.count ?? 0] ?? 0) + 1;
    }
    before = { byteExact: beforeByteExact.filter(Boolean).length, refusalsUnderStrict: strictBefore };

    // Adopt through the PRODUCT's one write path — the same call `sememe
    // adopt-hadron` makes, so this face is what a user gets.
    const loaded = loadVendoredHadron();
    await adopt(HADRON, loaded.path, scratch, { source: 'published', origin: loaded.origin ?? undefined });

    for (const hex of dataHex) {
      const view = await decodeUnionPayload(scratch, HADRON, hex, { trailing: 'report' });
      afterByteExact.push(view.roundTripByteExact);
      if (view.view?.drift?.paths?.paths) driftPaths = view.view.drift.paths.paths;
      if (view.view?.arbitration?.winner) winner = view.view.arbitration.basis ?? view.view.arbitration.winner;
      try {
        await decodeUnionPayload(scratch, HADRON, hex, { trailing: 'error' });
      } catch { strictAfter += 1; }
      const plain = await decodePayload(scratch, HADRON, hex, {});
      plainAfter ??= { byteExact: 0, trailing: {} };
      if (plain.roundTripByteExact) plainAfter.byteExact += 1;
      plainAfter.trailing[plain.trailing?.count ?? 0] = (plainAfter.trailing[plain.trailing?.count ?? 0] ?? 0) + 1;
    }
    after = { byteExact: afterByteExact.filter(Boolean).length, refusalsUnderStrict: strictAfter };

    if (before.byteExact !== 0) falsifications.push(`union BEFORE adoption expected 0 byte-exact, got ${before.byteExact}`);
    if (before.refusalsUnderStrict !== 144) falsifications.push(`union BEFORE: --trailing error expected 144 refusals, got ${strictBefore}`);
    if (after.byteExact !== 144) falsifications.push(`union AFTER adoption expected 144 byte-exact, got ${after.byteExact}`);
    if (after.refusalsUnderStrict !== 0) falsifications.push(`union AFTER: --trailing error expected 0 refusals, got ${strictAfter}`);
    if (!driftPaths || !driftPaths.includes('sequence')) {
      falsifications.push(`union AFTER must NAME the drift path "sequence", got ${JSON.stringify(driftPaths)}`);
    }
    // GUARD (must hold on BOTH sides of the adoption): plain decode keeps the
    // on-chain receipt as its answer — adoption widens what --union can
    // arbitrate, it never silently rewrites the default single-source read.
    if (!plainBefore || !plainAfter) falsifications.push('plain decode face missing');
    else if (JSON.stringify(plainBefore) !== JSON.stringify(plainAfter)) {
      falsifications.push(`plain decode must be unchanged by adoption: ${JSON.stringify(plainBefore)} -> ${JSON.stringify(plainAfter)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const { HADRON_PIN } = await import(path.join(ROOT, 'src', 'hadron.mjs'));
  const artifact = {
    tool: 'tools/measure-hadron-adoption.mjs',
    measuredAt: new Date().toISOString(),
    program: HADRON,
    prefixCommit: PREFIX,
    pin: { repo: HADRON_PIN.repo, commit: HADRON_PIN.commit, license: HADRON_PIN.license },
    payloadBasis: '144 committed chain-accepted setCurve/setRiskCurve payloads, identified by discriminator byte 0x04/0x08 only',
    faces: {
      F1_prefix_tree_stored_idl: F1,
      F2_prefix_tree_first_party_idl: F2,
      F3_current_tree_stored_idl: F3,
      F4_current_tree_first_party_idl: F4,
    },
    userFace: {
      before,
      after,
      plainDecodeBefore: plainBefore,
      plainDecodeAfter: plainAfter,
      driftPaths,
      arbitrationBasis: winner,
    },
    missingArgsOnChain: HADRON_MISSING_ARGS,
    falsifications,
    ok: falsifications.length === 0,
    limits: [
      'the two fixes compose only for THIS program: the header rule is keyed to the measured address and instruction names, and the tail args are pinned by sha256 to one commit',
      'F2 falsifies "adopt the source IDL alone" — the first-party copy declares points as a Borsh vec too and refuses the same 72 payloads without count-from-header',
      'the 8-byte tail is named `sequence: u64` because the first-party copy declares it and the bytes sit where it says; the value itself is not interpreted here',
      'adoption is provenance of bytes, not proof the copy describes the deployed program: the receipt origin stays `declared` and the commit is content-addressed, not signed',
      'plain `sememe decode` keeps the on-chain receipt as its default answer — measured unchanged on both sides of the adoption (slot 0 sorts before every real slot)',
      'one program, one sample window (slots in the committed fixture); no other program\'s payloads are touched',
    ],
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`${path.relative(ROOT, OUT)}: F1 ${F1.decoded}/${F1.refused}/${F1.byteExact}  F2 ${F2.decoded}/${F2.refused}/${F2.byteExact}  `
    + `F3 ${F3.decoded}/${F3.refused}/${F3.byteExact}  F4 ${F4.decoded}/${F4.refused}/${F4.byteExact}  `
    + `user ${before.byteExact}->${after.byteExact}  falsifications=${falsifications.length}`);
  if (falsifications.length) {
    for (const item of falsifications) console.error(`FALSIFIED: ${item}`);
    process.exit(1);
  }
}

function pinCommit() {
  const source = readFileSync(path.join(ROOT, 'src', 'hadron.mjs'), 'utf8');
  const match = /commit:\s*'([0-9a-f]{40})'/.exec(source);
  if (!match) throw new NoVerdict('the HADRON_PIN.commit could not be read out of src/hadron.mjs');
  return match[1];
}

try {
  await main();
} catch (error) {
  if (error instanceof NoVerdict) {
    console.error(`NO VERDICT: ${error.message}`);
    process.exit(3);
  }
  console.error(String(error?.stack ?? error));
  process.exit(2);
}
