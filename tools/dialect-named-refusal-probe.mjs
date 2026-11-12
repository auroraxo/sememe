// tools/dialect-named-refusal-probe.mjs — pure probe for the non-Anchor
// dialect defect. Run by tools/measure-dialect-named-refusal.mjs in both the
// pre-fix and post-fix trees (byte-identical copy in each tree — only the
// src/ under test differs). Outputs JSON to stdout; no host paths.
//
// The probe asks SIX questions of the tree it runs in:
//   1. CRASH FACE: feeding the real diabloarb interface (fetched at the pin
//      by the caller — its bytes are never committed, the upstream repo has
//      no license) to the codec on a payload — what does the refusal look
//      like? Pre-fix: a TypeError ("object is not iterable"), NOT a
//      CodecError, NOT named.
//   2. UNIT FACE: withDerivedDiscriminators on the same interface — does it
//      fill Anchor sighashes over tag-dispatch instructions? Pre-fix: yes
//      (filled 4/0, conflicts 0) — a table that matches no wire.
//   3. VOICE FACE: adopt() the interface under its OWN program id (the
//      measured crash path), then run all 102 sampled DiabLokxis payloads
//      through the product's union decode. Pre-fix: adopt succeeds and all
//      102 refuse with the CRASH voice. Post-fix: adopt refuses by name at
//      the write boundary, so the honest product answer for the store is
//      no-interface for all 102 — a COUNTABLE state, not a TypeError.
//   4. READ-BOUNDARY FACE: the same object + receipt written by hand
//      (bypassing adopt), decoded once through the product. Pre-fix: crash.
//      Post-fix: the named dialect refusal from store-read — proving the
//      guard also holds for stores that already contain such an object.
//   5. MISLABELLING FACE: adopt() of the diabloarb file under WSOL's program
//      id (it declares `program_id`, not `address`) — does the write path
//      re-label a foreign interface? Pre-fix: yes.
//   6. GUARD FACES: supported-dialect controls (Whirlpool anchor, Kamino
//      legacy name-only, a shank shape) must pass the gate unchanged, and
//      every committed store object must stay readable — surgical, not a
//      widening.
// Every write goes to a throwaway directory that is deleted afterwards. The
// committed store is never opened for writing.

import { readFile, readdir, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// The diabloarb interface is NOT vendored: the upstream repository carries
// no license file at the pin, so this repo never commits its bytes. The
// probe reads a caller-supplied copy (--source, fetched at the pin outside
// the repo); the measurement tool verifies the pinned canonical fingerprint
// before any probe runs.
const SOURCE = (() => {
  const at = process.argv.indexOf('--source');
  if (at === -1 || process.argv[at + 1] === undefined) {
    process.stderr.write('usage: dialect-named-refusal-probe.mjs --source <sdk/diabloarb-executor.idl.json at pin f5005ac4>\n');
    process.exit(2);
  }
  return path.resolve(process.argv[at + 1]);
})();

const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SAMPLE_PATH = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const STORE_PATH = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');
const WHIRLPOOL_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'whirlpool-idl.json');
const KAMINO_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'kamino-lend-idl.json');

const messageFace = (error) => String(error?.message ?? error)
  .replace(/unknown instruction discriminator ([0-9a-f]+).*/, 'unknown-discriminator-$1')
  .slice(0, 140);

const voiceOf = (error) => {
  const message = String(error?.message ?? error);
  if (error instanceof TypeError
    || /object is not iterable/.test(message)
    || /Symbol\(Symbol\.iterator\)/.test(message)) return 'crash';
  if (/unsupported IDL dialect/.test(message)) return 'named';
  if (/no stored IDL|no-sememe-store|no stored interface/.test(message)) return 'no-interface';
  return 'other';
};

/** Faces 1+2: direct codec + derivation on the real interface bytes. */
async function directFaces() {
  const diablo = JSON.parse(await readFile(SOURCE, 'utf8'));
  const { decodeInstructionData, CodecError } = await import('../src/codec.mjs');
  const payload = Buffer.from('01' + '02'.repeat(30), 'hex');
  let crashVoice = null; let namedVoice = null; let otherVoice = null; let isCodecError = false;
  try {
    decodeInstructionData(diablo, payload, { trailing: 'report' });
    otherVoice = 'decoded';
  } catch (error) {
    const voice = voiceOf(error);
    if (voice === 'crash') crashVoice = messageFace(error);
    else if (voice === 'named') { namedVoice = messageFace(error); isCodecError = error instanceof CodecError; }
    else otherVoice = messageFace(error);
  }
  const { withDerivedDiscriminators } = await import('../src/discriminators.mjs');
  let filled = null; let derivationRefused = null; let derivationCrashed = null;
  try {
    const out = withDerivedDiscriminators(diablo);
    filled = out.filled;
  } catch (error) {
    if (voiceOf(error) === 'crash') derivationCrashed = messageFace(error);
    else derivationRefused = messageFace(error);
  }
  return {
    codecCrashVoice: crashVoice,
    codecNamedVoice: namedVoice,
    codecOtherVoice: otherVoice,
    codecNamedIsCodecError: isCodecError,
    derivationFilled: filled,
    derivationRefused,
    derivationCrashed,
  };
}

const ORIGIN = 'cryptodiablo/diabloarb@f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc:sdk/diabloarb-executor.idl.json';

/** Face 3+5: adopt through the product path, then the sampled payloads. */
async function adoptFaces() {
  const sample = JSON.parse(await readFile(SAMPLE_PATH, 'utf8'));
  const rows = [];
  const wire = new Map();
  for (const tx of sample.transactions ?? []) {
    for (const p of tx.payloads ?? []) {
      if (p.program !== DIABLO) continue;
      rows.push(p.dataHex);
      const raw = Buffer.from(p.dataHex, 'hex');
      const key = `${raw[0].toString(16).padStart(2, '0')}:${raw.length}`;
      wire.set(key, (wire.get(key) ?? 0) + 1);
    }
  }
  const { adopt } = await import('../src/adopt.mjs');
  const { decodeUnionPayload } = await import('../src/decode.mjs');
  const voices = { decoded: 0, crash: 0, named: 0, 'no-interface': 0, other: 0 };
  const refusalFaces = {};
  let voiceAdopted = false; let voiceAdoptRefusal = null;
  let mislabelAdopted = false; let mislabelAdoptRefusal = null;

  // Voice face: adopt under the interface's OWN program id — the exact path
  // that crashed all 102 payloads pre-fix.
  const workStore = await mkdtemp(path.join(tmpdir(), 'dialect-probe-'));
  try {
    await mkdir(path.join(workStore, 'objects'), { recursive: true });
    await mkdir(path.join(workStore, 'receipts'), { recursive: true });
    try {
      await adopt(DIABLO, SOURCE, workStore, { source: 'published', origin: ORIGIN });
      voiceAdopted = true;
    } catch (error) {
      voiceAdoptRefusal = messageFace(error);
    }
    for (const hex of rows) {
      try {
        const out = await decodeUnionPayload(workStore, DIABLO, hex, { absent: 'verified' });
        voices.decoded += 1;
        refusalFaces[`decoded:${out.name}`] = (refusalFaces[`decoded:${out.name}`] ?? 0) + 1;
      } catch (error) {
        const voice = voiceOf(error);
        voices[voice] += 1;
        const face = messageFace(error);
        refusalFaces[face] = (refusalFaces[face] ?? 0) + 1;
      }
    }
  } finally {
    await rm(workStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }

  // Mislabelling face: the SAME file under a foreign program id.
  const misStore = await mkdtemp(path.join(tmpdir(), 'dialect-probe-mis-'));
  try {
    await mkdir(path.join(misStore, 'objects'), { recursive: true });
    await mkdir(path.join(misStore, 'receipts'), { recursive: true });
    try {
      await adopt(WSOL_MINT, SOURCE, misStore, { source: 'published', origin: ORIGIN });
      mislabelAdopted = true;
    } catch (error) {
      mislabelAdoptRefusal = messageFace(error);
    }
  } finally {
    await rm(misStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }

  return {
    payloads: rows.length,
    wireFace: [...wire.entries()].sort().map(([key, count]) => ({ key, count })),
    voices,
    refusalFaces,
    voiceAdopted,
    voiceAdoptRefusal,
    mislabelAdopted,
    mislabelAdoptRefusal,
  };
}

/** Face 4: the read boundary with a hand-written store (bypasses adopt). */
async function readBoundaryFace() {
  const { canonicalJson } = await import('../src/canonical.mjs');
  const { findStoredIdl } = await import('../src/store-read.mjs');
  const idl = JSON.parse(await readFile(SOURCE, 'utf8'));
  const json = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = createHash('sha256').update(json).digest('hex');
  const store = await mkdtemp(path.join(tmpdir(), 'dialect-probe-read-'));
  try {
    await mkdir(path.join(store, 'objects'), { recursive: true });
    await mkdir(path.join(store, 'receipts'), { recursive: true });
    await writeFile(path.join(store, 'objects', `${fingerprint}.json`), json);
    await writeFile(path.join(store, 'receipts', `${DIABLO}-0-published-${fingerprint}.json`),
      JSON.stringify({
        program: DIABLO, source: 'published', origin: ORIGIN, slot: 0,
        fingerprint: `sha256:${fingerprint}`, instructionCount: idl.instructions?.length ?? 0,
      }));
    try {
      await findStoredIdl(store, DIABLO);
      return { voice: 'readable' };
    } catch (error) {
      return { voice: voiceOf(error), face: messageFace(error) };
    }
  } finally {
    await rm(store, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }
}

/** Face 6: supported-dialect controls and every committed store object. */
async function guardFaces() {
  // The pre-fix tree has no src/dialect.mjs — the gate face then measures
  // only what the tree can answer: does the supported control still decode.
  let unsupportedIdlReason = null;
  try {
    ({ unsupportedIdlReason } = await import('../src/dialect.mjs'));
  } catch { /* pre-fix tree: no dialect module */ }
  const controls = {};
  for (const [name, file] of [
    ['whirlpoolAnchor', WHIRLPOOL_FIXTURE],
    ['kaminoLegacyAnchor', KAMINO_FIXTURE],
  ]) {
    controls[name] = {
      refused: unsupportedIdlReason
        ? unsupportedIdlReason(JSON.parse(await readFile(file, 'utf8'))) !== null
        : null,
      decodesThroughProduct: await controlDecodes(file),
    };
  }
  const objects = await readdir(path.join(STORE_PATH, 'objects'));
  let readable = 0; let refusedStoreObjects = 0;
  for (const objectName of objects) {
    const idl = JSON.parse(await readFile(path.join(STORE_PATH, 'objects', objectName), 'utf8'));
    if (unsupportedIdlReason && unsupportedIdlReason(idl)) refusedStoreObjects += 1;
    else readable += 1;
  }
  return { controls, committedStoreObjects: objects.length, readable, refusedStoreObjects };
}

/** A supported-dialect control must still decode through the product path. */
async function controlDecodes(file) {
  const { decodeInstructionData } = await import('../src/codec.mjs');
  const idl = JSON.parse(await readFile(file, 'utf8'));
  const instruction = (idl.instructions ?? [])[0];
  if (!instruction) return 'no-instruction';
  const bytes = Buffer.from(instruction.discriminator ?? []);
  try {
    decodeInstructionData(idl, bytes, { trailing: 'report', absent: 'report' });
    return 'decoded';
  } catch (error) {
    return voiceOf(error);
  }
}

async function main() {
  const result = {
    direct: await directFaces(),
    adopt: await adoptFaces(),
    readBoundary: await readBoundaryFace(),
    guards: await guardFaces(),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${String(error?.stack ?? error)}\n`);
  process.exit(2);
});
