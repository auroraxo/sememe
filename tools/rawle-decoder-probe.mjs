// tools/rawle-decoder-probe.mjs — pure probe for the raw-LE dialect engine.
// Run by tools/measure-rawle-decoder.mjs in BOTH trees (byte-identical copy
// in each tree — only src/ under test differs). Outputs JSON to stdout; no
// host paths.
//
// The probe asks FOUR questions of the tree it runs in:
//   1. ENGINE FACE: does src/rawle.mjs exist, and can it decode the REAL
//      diabloarb interface (fetched at the pin by the caller — its bytes are
//      never committed, the upstream repo has no license) against all 102
//      sampled payloads, re-encoding each byte-identically? Pre-fix tree:
//      the module does not exist — 0 decodable, the honest baseline.
//   2. PRODUCT FACE: what does the PRODUCT path (codec context() with the
//      PULS X dialect gate) say about the same payload? This must be the
//      same named refusal in BOTH trees: the engine is capability, the
//      boundaries are NOT wired this run.
//   3. GRAMMAR FACE: six falsifications against the engine's own gate —
//      a mutated fixed size, a duplicate tag, a counter that is not a
//      preceding field, an unknown dispatch tag, a truncated payload and a
//      payload with one extra byte. Every one must be a NAMED refusal, and
//      every one must be counted.
//   4. GUARD FACE: a supported anchor interface (Whirlpool fixture) must
//      still decode through the product unchanged — the engine did not
//      widen or narrow the product's own gates.
//
// Every payload source is committed (test/fixtures) except the interface
// itself, which the caller supplies and pins by hash.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SOURCE = (() => {
  const at = process.argv.indexOf('--source');
  if (at === -1 || process.argv[at + 1] === undefined) {
    process.stderr.write('usage: rawle-decoder-probe.mjs --source <sdk/diabloarb-executor.idl.json at pin f5005ac4>\n');
    process.exit(2);
  }
  return path.resolve(process.argv[at + 1]);
})();

const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';

// The committed sample's diabloarb payload rows, in file order.
const sample = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/ecosystem-sample-2026-11-11.json'), 'utf8'));
const rows = [];
for (const tx of sample.transactions ?? []) {
  for (const payload of tx.payloads ?? []) {
    if (payload.program !== DIABLO) continue;
    rows.push(Buffer.from(payload.dataHex, 'hex'));
  }
}
if (rows.length !== 102) {
  process.stderr.write(`expected 102 diabloarb payloads in the committed sample, found ${rows.length}\n`);
  process.exit(3);
}

const idl = JSON.parse(readFileSync(SOURCE, 'utf8'));

// --- 1. ENGINE FACE ---------------------------------------------------------
const engineFace = { present: false, dialectReason: null, decoded: 0, byteExact: 0, refusalFaces: [] };
if (existsSync(path.join(ROOT, 'src', 'rawle.mjs'))) {
  engineFace.present = true;
  try {
    const { rawLeDialectReason, decodeRawLe, encodeRawLe } = await import(path.join(ROOT, 'src', 'rawle.mjs'));
    engineFace.dialectReason = rawLeDialectReason(idl);
    if (engineFace.dialectReason !== null) {
      engineFace.refusalFaces.push(`gate:${engineFace.dialectReason.slice(0, 90)}`);
    } else {
      for (const data of rows) {
        try {
          const decoded = decodeRawLe(idl, data);
          engineFace.decoded += 1;
          const reencoded = encodeRawLe(idl, decoded.instruction, decoded.args, { absent: decoded.absent });
          if (reencoded.equals(data)) engineFace.byteExact += 1;
        } catch (error) {
          const face = String(error?.message ?? error).slice(0, 100);
          engineFace.refusalFaces.push(face);
        }
      }
    }
    // --- 3. GRAMMAR FACE (falsifications; each must refuse by name) --------
    engineFace.grammar = {};
    const attempt = (label, fn) => {
      try { fn(); engineFace.grammar[label] = 'ESCAPED'; }
      catch (error) { engineFace.grammar[label] = String(error?.message ?? error).slice(0, 120); }
    };
    // A gate falsification: the mutant must produce a NON-null reason. A
    // null reason is an escape and recorded as ESCAPED, never as a pass.
    const gateAttempt = (label, mutant) => {
      const reason = rawLeDialectReason(mutant);
      if (reason === null) { engineFace.grammar[label] = 'ESCAPED'; return; }
      engineFace.grammar[label] = `named: ${reason.slice(0, 110)}`;
    };
    const clone = structuredClone(idl);
    clone.types.Base.size = 32;
    attempt('mutatedFixedSize', () => decodeRawLe(clone, rows[0]));
    const dup = structuredClone(idl);
    dup.instructions[1].tag = dup.instructions[0].tag;
    gateAttempt('duplicateTag', dup);
    const badCounter = structuredClone(idl);
    badCounter.instructions[0].data.find((f) => f.name === 'bases').type = 'Base[n_morphs]';
    gateAttempt('counterNotAPrecedingField', badCounter);
    const unknown = Buffer.from(rows[0]);
    unknown[0] = 7;
    attempt('unknownDispatchTag', () => decodeRawLe(idl, unknown));
    attempt('truncatedPayload', () => decodeRawLe(idl, rows[0].subarray(0, rows[0].length - 3)));
    const extra = Buffer.concat([rows[0], Buffer.from([0])]);
    attempt('trailingByte', () => decodeRawLe(idl, extra));
    const noEncoding = structuredClone(idl);
    delete noEncoding.encoding;
    gateAttempt('noEncodingDeclaration', noEncoding);
    const stubTag = Buffer.from([0]);
    attempt('layoutlessStubTag', () => decodeRawLe(idl, stubTag));
  } catch (error) {
    engineFace.present = false;
    engineFace.dialectReason = `probe-import-failed: ${String(error?.message ?? error).slice(0, 140)}`;
  }
}

// --- 2. PRODUCT FACE --------------------------------------------------------
// The product's own path, unchanged by this run: the dialect gate answers.
const productFace = { voice: null, message: null };
try {
  const { decodeInstructionData } = await import(path.join(ROOT, 'src', 'codec.mjs'));
  const decoded = decodeInstructionData(idl, rows[0], { trailing: 'report' });
  productFace.voice = 'decoded';
  productFace.message = String(decoded.instruction);
} catch (error) {
  const message = String(error?.message ?? error);
  if (message.includes('is not iterable') || message.includes('Symbol(Symbol.iterator)')) productFace.voice = 'crash';
  else if (/^unsupported IDL dialect:/.test(message)) productFace.voice = 'named';
  else productFace.voice = 'other';
  productFace.message = message.slice(0, 160);
}

// --- 4. GUARD FACE ----------------------------------------------------------
const guard = { whirlpool: null, whirlpoolMessage: null };
try {
  const { decodeInstructionData } = await import(path.join(ROOT, 'src', 'codec.mjs'));
  const whirlpool = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/whirlpool-idl.json'), 'utf8'));
  // swap_v2 sample from the committed fixture: discriminator + minimal args
  // is not available offline — the guard is the DIALECT gate, not bytes:
  // a supported anchor interface must pass context() untouched.
  const samplePayload = Buffer.concat([
    Buffer.from(whirlpool.instructions[0].discriminator ?? [0], 'hex'),
    Buffer.alloc(256),
  ]);
  try {
    decodeInstructionData(whirlpool, samplePayload, { trailing: 'report' });
    guard.whirlpool = 'decoded-or-reported';
  } catch (error) {
    const message = String(error?.message ?? error);
    guard.whirlpool = /^unsupported IDL dialect:/.test(message) ? 'refused-by-dialect' : 'refused-other';
    guard.whirlpoolMessage = message.slice(0, 120);
  }
} catch (error) {
  guard.whirlpool = 'probe-error';
  guard.whirlpoolMessage = String(error?.message ?? error).slice(0, 120);
}

process.stdout.write(JSON.stringify({
  engine: engineFace,
  product: productFace,
  guards: guard,
  wireFace: rows.reduce((acc, data) => {
    const key = `${data[0].toString(16).padStart(2, '0')}:${data.length}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
}, null, 1));
