// tools/rawle-product-probe.mjs — pure probe for the RAW-LE PRODUCT WIRING.
// Run by tools/measure-rawle-product.mjs in BOTH trees (byte-identical copy
// in each tree — only src/ under test differs). Outputs JSON to stdout; no
// host paths.
//
// The PULS Y measurement pinned the engine against the product's refusal;
// this probe asks the question that measurement declared future work:
//   WHAT DOES THE PRODUCT BOUNDARY ITSELF ANSWER NOW?
//
// It asks FIVE questions of the tree it runs in:
//   1. DECODE FACE: does the PRODUCT entry (src/codec.mjs
//      decodeInstructionData / decodeData) answer the real diabloarb
//      interface (caller-supplied, pinned by hash) with decoded
//      instructions — and re-encode each payload BYTE-IDENTICALLY through
//      the same entry? Pre-wiring tree: the named refusal of PULS X —
//      0/102 decoded, the honest baseline.
//   2. FAMILY FACE: one refusal family. Whatever the product refuses
//      (unknown tag, truncated payload, payload with an extra byte) must
//      come back as the product's CodecError — never a RawLeError and
//      never an unnamed TypeError crash.
//   3. WIRE FACE: the boundary it charges. Every boundary that the PULS X
//      gate used to refuse the whole file must now let the engine answer:
//      decodeInstructionData + decodeData (codec), the union probe
//      (src/union.mjs), withDerivedDiscriminators (src/discriminators.mjs),
//      store adopt (src/adopt.mjs), store read (src/store-read.mjs), and
//      idlDialect classifying the file as 'raw-le' instead of
//      'unsupported'.
//   4. GUARD FACE: no silent widening. (a) A real Anchor interface
//      (Whirlpool fixture) must still decode through the product
//      unchanged. (b) A file that defeats BOTH engines (raw-LE grammar
//      broken: no encoding declaration) must keep the exact named refusal
//      of PULS X — code 'unsupported-idl-dialect'.
//   5. STORE FACE: end-to-end, offline: `sememe adopt` the pinned
//      interface into a TEMP store and `sememe decode` two real payload
//      bytes through the store — the full CLI loop the union covers.
//      Pre-wiring tree: adopt refuses the file by name; decode then has
//      no object to read — 0/2. This face is what "the product speaks
//      the dialect" means for a user.
//
// Every payload source is committed (test/fixtures) except the interface
// itself, which the caller supplies and pins by hash.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SOURCE = (() => {
  const at = process.argv.indexOf('--source');
  if (at === -1 || process.argv[at + 1] === undefined) {
    process.stderr.write('usage: rawle-product-probe.mjs --source <sdk/diabloarb-executor.idl.json at pin f5005ac4>\n');
    process.exit(2);
  }
  return path.resolve(process.argv[at + 1]);
})();

const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Faces must be comparable across trees AND machines: any host or scratch
// path a refusal embeds is stripped before it becomes a face (the
// committed artifact must name no host path).
const sanitize = (text) => String(text ?? '')
  .replace(/\/(tmp|home)\/[^ :\n]*/g, '<path>')
  .slice(0, 160);

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

const classifyError = (error) => {
  const message = String(error?.message ?? error);
  if (error instanceof TypeError) return 'crash';
  if (error?.name === 'RawLeError') return 'raw-le-leak';
  if (/^unsupported IDL dialect:/.test(message)) return 'named';
  return 'other';
};

// --- 1. DECODE FACE ---------------------------------------------------------
const decodeFace = { decoded: 0, byteExact: 0, voice: null, message: null, absentSeen: 0 };
try {
  const { decodeInstructionData, encodeInstructionData } = await import(path.join(ROOT, 'src', 'codec.mjs'));
  for (const data of rows) {
    try {
      const decoded = decodeInstructionData(idl, data, { trailing: 'error' });
      decodeFace.decoded += 1;
      if (decoded.absent && decoded.absent.length > 0) decodeFace.absentSeen += 1;
      const reencoded = encodeInstructionData(idl, decoded.instruction, decoded.args);
      if (Buffer.from(reencoded).equals(data)) decodeFace.byteExact += 1;
    } catch (error) {
      decodeFace.voice ??= classifyError(error);
      decodeFace.message ??= sanitize(error?.message ?? error);
    }
  }
  if (decodeFace.decoded === rows.length) {
    decodeFace.voice = 'decoded';
    decodeFace.message = null;
  } else if (!decodeFace.voice) {
    decodeFace.voice = 'refused';
  }
} catch (error) {
  decodeFace.voice = 'probe-error';
  decodeFace.message = String(error?.message ?? error).slice(0, 160);
}

// The union's payload router — same answer at that boundary.
let unionVoice = null;
try {
  const { decodeData } = await import(path.join(ROOT, 'src', 'codec.mjs'));
  const decoded = decodeData(idl, rows[0], { trailing: 'report' });
  unionVoice = decoded && decoded.kind === 'instruction' ? 'decoded' : 'other';
} catch (error) {
  unionVoice = classifyError(error);
}

// --- 2. FAMILY FACE ---------------------------------------------------------
const family = {};
const oneFamily = (label, fn) => {
  try {
    fn();
    family[label] = 'accepted';
  } catch (error) {
    family[label] = classifyError(error) === 'crash' ? 'crash' : (error?.name === 'RawLeError' ? 'raw-le-leak' : 'named-codec-error');
  }
};
{
  const { decodeInstructionData, encodeInstructionData } = await import(path.join(ROOT, 'src', 'codec.mjs'));
  const unknown = Buffer.from(rows[0]);
  unknown[0] = 7;
  oneFamily('unknownTag', () => decodeInstructionData(idl, unknown));
  oneFamily('truncatedPayload', () => decodeInstructionData(idl, rows[0].subarray(0, rows[0].length - 3)));
  oneFamily('trailingByte', () => decodeInstructionData(idl, Buffer.concat([rows[0], Buffer.from([0])])));
  oneFamily('encodeUnknownInstruction', () => encodeInstructionData(idl, 'nope', {}));
  oneFamily('encodeMissingArgument', () => encodeInstructionData(idl, 'search', {}));
}

// --- 3. WIRE FACE -----------------------------------------------------------
const wire = {};
{
  const { withDerivedDiscriminators } = await import(path.join(ROOT, 'src', 'discriminators.mjs'));
  try {
    const out = withDerivedDiscriminators(idl);
    wire.derivation = 'passes';
    wire.derivationFilled = out.filled ?? null;
  } catch (error) {
    wire.derivation = classifyError(error);
    wire.derivationFilled = null;
    wire.derivationRefusal = sanitize(String(error?.message ?? error).slice(0, 120));
  }
  const { idlDialect } = await import(path.join(ROOT, 'src', 'dialect.mjs'));
  wire.idlDialect = idlDialect(idl);
  let adopted = false;
  let adoptRefusal = null;
  try {
    const { adopt } = await import(path.join(ROOT, 'src', 'adopt.mjs'));
    const tmp = mkdtempSync(path.join(HERE, 'rawle-product-adopt-'));
    try {
      await adopt(DIABLO, SOURCE, tmp, { source: 'published' });
      adopted = true;
    } finally {
      rmSync(tmp, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
    }
  } catch (error) {
    adoptRefusal = sanitize(error?.message ?? error);
  }
  wire.storeAdopt = adopted ? 'adopts' : 'refused';
  wire.storeAdoptRefusal = adoptRefusal === null ? null : sanitize(adoptRefusal);
  let readVoice = 'refused';
  try {
    const { findStoredIdl } = await import(path.join(ROOT, 'src', 'store-read.mjs'));
    const { adopt } = await import(path.join(ROOT, 'src', 'adopt.mjs'));
    const tmp = mkdtempSync(path.join(HERE, 'rawle-product-read-'));
    try {
      await adopt(DIABLO, SOURCE, tmp, { source: 'published' });
      const stored = await findStoredIdl(tmp, DIABLO);
      readVoice = stored && stored.idl?.program_id === DIABLO ? 'reads' : 'other';
    } finally {
      rmSync(tmp, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
    }
  } catch {
    readVoice = 'refused';
  }
  wire.storeRead = readVoice;
  let unionAdmit = 'refused';
  try {
    const { unionDecode } = await import(path.join(ROOT, 'src', 'union.mjs'));
    const result = unionDecode({
      program: DIABLO,
      primary: { label: 'published', idl },
      bytes: rows[0],
      absent: 'report',
    });
    const view = result?.view;
    unionAdmit = view?.verdict && view?.primary?.decoded === true ? 'decoded' : 'other';
  } catch {
    unionAdmit = 'refused';
  }
  wire.union = unionAdmit;
}

// --- 4. GUARD FACE ----------------------------------------------------------
const guard = {};
{
  // (a) a real Anchor interface still decodes through the product.
  try {
    const { decodeInstructionData } = await import(path.join(ROOT, 'src', 'codec.mjs'));
    const whirlpool = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/whirlpool-idl.json'), 'utf8'));
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
    }
  } catch (error) {
    guard.whirlpool = 'probe-error';
  }
  // (b) a file that defeats BOTH engines keeps the PULS X named refusal.
  try {
    const { decodeInstructionData } = await import(path.join(ROOT, 'src', 'codec.mjs'));
    const mutant = structuredClone(idl);
    delete mutant.encoding;
    try {
      decodeInstructionData(mutant, rows[0]);
      guard.brokenDialect = 'accepted';
    } catch (error) {
      guard.brokenDialect = classifyError(error);
      guard.brokenDialectCode = error?.code ?? null;
    }
  } catch (error) {
    guard.brokenDialect = 'probe-error';
  }
  // (c) a file that defeats BOTH engines: the SAME named refusal must come
  // out of the union's source preparation (src/union.mjs), not only from
  // the codec.
  try {
    const { unionDecode } = await import(path.join(ROOT, 'src', 'union.mjs'));
    const mutant = structuredClone(idl);
    delete mutant.encoding;
    try {
      unionDecode({ program: DIABLO, primary: { label: 'published', idl: mutant }, bytes: rows[0], absent: 'report' });
      guard.brokenDialectUnion = 'accepted';
    } catch (error) {
      guard.brokenDialectUnion = classifyError(error);
    }
  } catch {
    guard.brokenDialectUnion = 'probe-error';
  }
  // (d) Mislabelling stays refused: the SAME file under WSOL's program id —
  // the PULS X re-labelling gate must not reopen with the dialect gate.
  let mislabelAdopted = false;
  let mislabelRefusal = null;
  try {
    const { adopt } = await import(path.join(ROOT, 'src', 'adopt.mjs'));
    const tmp = mkdtempSync(path.join(HERE, 'rawle-product-mis-'));
    try {
      await adopt(WSOL_MINT, SOURCE, tmp, { source: 'published' });
      mislabelAdopted = true;
    } finally {
      rmSync(tmp, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
    }
  } catch (error) {
    mislabelRefusal = sanitize(error?.message ?? error);
  }
  guard.mislabelAdopted = mislabelAdopted;
  guard.mislabelRefusal = mislabelRefusal;
}

// --- 5. STORE FACE (the CLI loop) -------------------------------------------
const store = { adopt: null, decode: null, decoded: 0, total: 2 };
{
  const tmp = mkdtempSync(path.join(HERE, 'rawle-product-store-'));
  try {
    const bin = path.join(ROOT, 'bin', 'sememe.mjs');
    try {
      await run(process.execPath, [bin, 'adopt', DIABLO, SOURCE, '--store', tmp], { cwd: ROOT, timeout: 60_000 });
      store.adopt = 'adopts';
    } catch (error) {
      store.adopt = 'refused';
      store.adoptMessage = sanitize(String(error?.stderr ?? error?.message ?? error).split('\n').filter(Boolean).slice(-1)[0] ?? '');
    }
    if (store.adopt === 'adopts') {
      for (const data of [rows[0], rows[42]]) {
        try {
          const out = await run(process.execPath, [bin, 'decode', DIABLO, data.toString('hex'), '--store', tmp], { cwd: ROOT, timeout: 60_000 });
          const parsed = JSON.parse(out.stdout);
          if (parsed && (parsed.instruction || parsed.name)) store.decoded += 1;
        } catch (error) {
          store.decode ??= 'error';
          store.decodeMessage ??= sanitize(String(error?.stderr ?? error?.message ?? error).split('\n').filter(Boolean).slice(-1)[0] ?? '');
        }
      }
      store.decode = store.decoded === store.total ? 'decoded' : (store.decode ?? 'refused');
    } else {
      store.decode = 'no-object';
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }
}

process.stdout.write(JSON.stringify({
  decode: decodeFace,
  union: { decodeData: unionVoice },
  family,
  wire,
  guards: guard,
  store,
  wireFace: rows.reduce((acc, data) => {
    const key = `${data[0].toString(16).padStart(2, '0')}:${data.length}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
}, null, 1));
