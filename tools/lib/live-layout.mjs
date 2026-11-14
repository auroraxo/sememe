// tools/lib/live-layout.mjs — the PURE layout analysis of a live payload
// scan, kept apart from the network code so the analysis can be tested
// against committed payload bytes without touching an RPC.
//
// Why this file exists: the measurement's credibility rests on the claim
// "the wire carries the element count in the header, not as a Borsh length
// prefix". A pin that only reads a summary artifact cannot catch an analyzer
// that was quietly broken; a pin that re-runs the analyzer over COMMITTED
// PAYLOAD BYTES can. So the analyzer lives here, the CLI imports it, and the
// pin imports the SAME code.
//
// The three decisions this module makes, each of which was a real defect
// while it was wrong (measured 2026-11-14):
//
//   1  DISCRIMINATOR LENGTH IS THE PROGRAM'S OWN. HADRo stores 1-byte
//      discriminators, Raydium CLMM stores 8-byte anchor sighashes. Reading
//      one byte for both mislabels every CAMM payload.
//   2  THE ELEMENT SIZE MUST INCLUDE pubkey (32 bytes) and the Anchor fixed
//      array shape {array: [type, len]}. Without either, every element size
//      is "unknown" and no layout can be decided.
//   3  THE COUNT CANDIDATE IS EVERY INTEGER BEFORE THE VECTOR, not the one
//      immediately before it: setCurve declares xMode between numPoints and
//      points.

/** Fixed byte sizes of the primitive types this analyzer needs. */
export const INT_SIZES = {
  u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, pubkey: 32,
};

/** The declared types of an IDL, keyed by type name. */
export function loadTypes(idl) {
  const out = new Map();
  for (const t of idl?.types ?? []) {
    if (!t || typeof t !== 'object') continue;
    const name = t.name ?? t?.type?.name;
    const body = t.type && typeof t.type === 'object' ? t.type : (t.variants ? t : null);
    if (name) out.set(name, body ?? t);
  }
  return out;
}

function structFields(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.struct && typeof body.struct === 'object') return body.struct.fields;
  return body.fields ?? null;
}

/**
 * The fixed byte size of a type, or null when it is variable or unknown.
 *
 * For a vec, the size of ONE element is what a counted (header-count)
 * vector multiplies — that is the size this returns.
 */
export function typeSize(type, types, seen = new Set()) {
  if (typeof type === 'string') return INT_SIZES[type] ?? null;
  if (!type || typeof type !== 'object') return null;
  if (type.array) {
    const spec = type.array;
    const [elementType, len] = Array.isArray(spec) ? spec : [spec.type, spec.len];
    const size = typeSize(elementType, types, seen);
    return size === null ? null : size * Number(len);
  }
  if (type.vec) return typeSize(type.vec, types, seen);
  if (type.defined?.name) {
    const name = type.defined.name;
    if (seen.has(name)) return null;
    seen.add(name);
    const body = types.get(name);
    if (!body) return null;
    const fields = structFields(body);
    if (!fields) return null;
    let total = 0;
    for (const f of fields) {
      const size = typeSize(f.type, types, seen);
      if (size === null) return null;
      total += size;
    }
    return total;
  }
  return null;
}

/** The hex form of an instruction's stored discriminator. */
export function discriminatorHex(ix) {
  if (!ix?.discriminator) return null;
  return Buffer.from(ix.discriminator).toString('hex');
}

/**
 * The discriminator map of a program: hex -> instruction, plus the set of
 * stored discriminator LENGTHS (in bytes) the program uses.
 */
export function buildDiscriminatorMap(idl) {
  const byHex = new Map();
  const lengths = new Set();
  for (const ix of idl?.instructions ?? []) {
    const hex = discriminatorHex(ix);
    if (!hex) continue;
    byHex.set(hex, ix);
    lengths.add(hex.length / 2);
  }
  return { byHex, lengths };
}

/** Resolve one payload's instruction by the program's own discriminator. */
export function resolveInstruction(dataHex, map) {
  for (const length of map.lengths) {
    const candidate = dataHex.slice(0, length * 2);
    const ix = map.byHex.get(candidate);
    if (ix) return { discriminator: candidate, ix };
  }
  return { discriminator: dataHex.slice(0, 2), ix: null };
}

/**
 * Decide which layout one payload carries.
 *
 *   'count-from-header'  the count field's value x elementBytes consumes the
 *                        body (plus a trailing tail the IDL does not name);
 *   'borsh-prefix'       a u32 LE prefix at the body start carries the count;
 *   'neither'            neither hypothesis consumes the body.
 */
export function checkLayout(payloadHex, ix, countIdx, vecIdx, types) {
  const args = ix?.args ?? [];
  const countType = args[countIdx]?.type;
  if (typeof countType !== 'string' || !INT_SIZES[countType]) {
    return { hypothesis: 'neither', reason: `count arg ${args[countIdx]?.name} is not a fixed-size integer` };
  }
  const bytes = Buffer.from(payloadHex, 'hex');
  const discLen = (ix.discriminator ?? []).length;
  let offset = discLen;
  for (let i = 0; i < countIdx; i++) {
    const size = typeSize(args[i].type, types);
    if (size === null) return { hypothesis: 'neither', reason: `arg ${args[i].name} size unknown` };
    offset += size;
  }
  const countSize = INT_SIZES[countType];
  if (offset + countSize > bytes.length) {
    return { hypothesis: 'neither', reason: 'count field past end' };
  }
  const count = countSize === 1 ? bytes[offset] : Number(bytes.readBigUInt64BE(offset));

  // The vector body starts after the last integer argument before the vec.
  let bodyStart = discLen;
  for (let i = 0; i < vecIdx; i++) {
    const size = typeSize(args[i].type, types);
    if (size === null) return { hypothesis: 'neither', reason: `arg ${args[i].name} size unknown` };
    bodyStart += size;
  }
  const body = bytes.subarray(bodyStart);
  const elementBytes = typeSize(args[vecIdx].type, types);
  if (elementBytes === null || elementBytes <= 0) {
    return { hypothesis: 'neither', count, elementBytes: null, reason: 'variable-size elements' };
  }

  const trailingBytes = body.length - count * elementBytes;
  if (trailingBytes >= 0) {
    return { hypothesis: 'count-from-header', count, elementBytes, trailingBytes };
  }
  if (body.length >= 4) {
    const prefix = body.readUInt32LE(0);
    if (prefix > 0 && prefix * elementBytes === body.length - 4) {
      return { hypothesis: 'borsh-prefix', count: prefix, elementBytes, trailingBytes: 0 };
    }
  }
  return { hypothesis: 'neither', count, elementBytes, reason: 'body fits neither layout' };
}

/**
 * Analyze a list of payload records against one program's IDL.
 *
 * Returns the discriminator histogram and, per (instruction, count arg,
 * vector arg), the hypothesis histogram over the payloads.
 */
export function analyze(payloads, idl, types = loadTypes(idl)) {
  const map = buildDiscriminatorMap(idl);
  const byDiscriminator = new Map();
  const perInstruction = new Map();
  const accepted = (record) => !record.err && !record.txErr;
  for (const record of payloads) {
    const { discriminator: disc, ix } = resolveInstruction(record.dataHex, map);
    const entry = byDiscriminator.get(disc)
      ?? { discriminator: disc, count: 0, accepted: 0, failed: 0, byteLengths: new Set(), signatures: [] };
    entry.count += 1;
    if (accepted(record)) entry.accepted += 1; else entry.failed += 1;
    entry.byteLengths.add(record.dataHex.length / 2);
    if (entry.signatures.length < 3) entry.signatures.push(record.signature);
    byDiscriminator.set(disc, entry);

    if (!ix) continue;
    const args = ix.args ?? [];
    for (let vecIdx = 0; vecIdx < args.length; vecIdx++) {
      if (typeof args[vecIdx].type !== 'object' || !args[vecIdx].type?.vec) continue;
      for (let countIdx = 0; countIdx < vecIdx; countIdx++) {
        const countArg = args[countIdx];
        if (typeof countArg.type !== 'string' || !INT_SIZES[countArg.type]) continue;
        const vectorArg = args[vecIdx];
        const check = checkLayout(record.dataHex, ix, countIdx, vecIdx, types);
        const key = `${ix.name}|${countArg.name}|${vectorArg.name}`;
        const entry2 = perInstruction.get(key) ?? {
          instruction: ix.name,
          discriminator: disc,
          countArg: countArg.name,
          vectorArg: vectorArg.name,
          payloads: 0,
          accepted: 0,
          hypotheses: {},
          examples: [],
        };
        entry2.payloads += 1;
        if (accepted(record)) entry2.accepted += 1;
        // The layout claim belongs to CHAIN-ACCEPTED payloads only: a
        // rejected transaction's bytes were never the wire the program
        // interpreted, and a rule that leaned on them would be measuring a
        // proposal, not a delivery.
        if (!accepted(record)) { perInstruction.set(key, entry2); continue; }
        entry2.hypotheses[check.hypothesis] = (entry2.hypotheses[check.hypothesis] ?? 0) + 1;
        if (entry2.examples.length < 3) {
          entry2.examples.push({ signature: record.signature, slot: record.slot, txErr: record.txErr ?? null, ...check });
        }
        perInstruction.set(key, entry2);
      }
    }
  }
  return { byDiscriminator, perInstruction };
}
