#!/usr/bin/env node
// tools/measure-hadro-vec-wire.mjs — WHY sememe ONCE REFUSED 72 setRiskCurve
// PAYLOADS (and called 72 setCurve payloads "decoded" with ZERO points):
// the stored IDL says `points: vec`, the wire carries NO Borsh length prefix.
// 2026-11-13 PULS AE WIRED THE RULE (src/wire-layout.mjs): the product face
// below now measures the FIX (144/144 decoded, the decoded count equal to
// the header byte in 144/144); the pre-fix face stays provable forever via
// tools/measure-hadro-count-from-header.mjs (prefix tree ea074c4).
//
// THE CLAIM UNDER TEST (falsification-first; both halves are measured, never
// asserted):
//
//   P  (product face, offline, committed fixtures) the product answers all
//      144 committed HADRo setCurve/setRiskCurve payloads: 144 decoded, 0
//      refused, 0 empty curves, the decoded point count equal to the header
//      byte in 144/144, 144 described-byte-exact. THE PREFIX FACE (what
//      this file measured before the fix): 72 decoded with points:[] and
//      46 trailing bytes each — the "decoded" label hid an EMPTY curve —
//      and 72 setRiskCurve refused under a nonsense length ("vector length
//      1814753837 …"): the u32 Borsh prefix the IDL promises does not exist
//      on the wire, so amountIn's low 4 bytes got read as the count.
//
//   W  (wire face) the real layout is: 1-byte discriminator + the declared
//      u8 header (setCurve 5 bytes, setRiskCurve 6 bytes, numPoints at byte
//      offset 4) + numPoints × 21-byte CurvePointInput (u64 amountIn, u64
//      priceFactorQ32, u8 interpolation, [u8;4] params — the shape the
//      first-party IDL documents as "21 bytes, no reserved tail") + an
//      8-byte `sequence: u64` tail. Fitting that layout re-encodes 144/144
//      payloads BYTE-EXACT, and the sequence tail equals the containing
//      transaction's slot (108) or slot-1 (36) in 144/144 — a count that
//      never lines up by chance across 144 payloads.
//
//   S  (first-party source, network) Hadron-Fi/hadron-tx-verifier
//      idl/hadron.json @ sha256 219f44fb… (LICENSE-APACHE + LICENSE-MIT in
//      the same repo, provenance note: hand-authored, audit-verified,
//      byte-verified against the SDK builders and the deployed bytecode)
//      declares BOTH trailing `sequence: u64` arguments the on-chain
//      metadata IDL (pulled at slot 468262003) is missing — and NOTHING
//      else differs. The two missing args are exactly the two 8-byte tails
//      the wire carries.
//
// WHY THIS IS NOT "JUST ADOPT THE FIRST-PARTY IDL": adopting S would fix
// the trailing sequence and still refuse every payload, because S ALSO
// declares `points: vec` (a Borsh prefix). The source closes the tail
// question; it does not close the prefix question. What closes that is the
// arithmetic in W — countable offline, re-encodable byte-exact, witnessed by
// 144 chain-ACCEPTED transactions (failed:false in the committed sample).
// THE FIX PULSE SHIPPED THE RULE: count-from-header (src/wire-layout.mjs)
// decodes the header-counted vectors, its encoder half writes no prefix, and
// a count that does not fit is refused BY NAME ("no length prefix on the
// wire"). THIS tool ships the measurement and pins the product face so the
// fix cannot drift either number silently.
//
// NO VERDICT (exit 3) when: a fixture is missing, the first-party source
// cannot be fetched or its sha256 pin moved, the source's instruction set
// diverges beyond the two `sequence` args, or the first-party IDL stops
// agreeing with the stored IDL on discriminators / CurvePointInput.
// Exit 1 when a falsification count is non-zero. Exit 0 when measured.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
const OUT = flag('--out', path.join(ROOT, 'research', 'hadro-vec-wire-2026-11-13.json'));

const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');
const HADRO = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';
const SOURCE = {
  repo: 'Hadron-Fi/hadron-tx-verifier',
  idlPath: 'idl/hadron.json',
  sha256: '219f44fb63729232b3685fbde49a817b0c8321a0203dcca68c88370fbed1279e',
  licenses: ['LICENSE-APACHE', 'LICENSE-MIT'],
};
const HEAD_BYTES = { setCurve: 5, setRiskCurve: 6 };
const POINT_BYTES = 21;

class NoVerdict extends Error {}

const fail = (message) => { throw new NoVerdict(message); };

function ghJson(args) {
  const endpoint = args.join('/');
  try {
    const out = execFileSync('gh', ['api', endpoint, '--jq', '.content'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    });
    return Buffer.from(out.trim(), 'base64').toString('utf8');
  } catch (error) {
    return null;
  }
}

function ghOk(args) {
  try {
    execFileSync('gh', ['api', args.join('/'), '--jq', '.sha'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return true;
  } catch { return false; }
}

// --- P: the product face, through the product's own union path --------------
// 2026-11-13 (PULS AE): this face measured the DEFECT (72 decoded with an
// empty curve, 72 refused with a garbage number). The count-from-header rule
// closed it; the face below now measures the FIX, and the pre-fix numbers
// live on in the two-tree measurement that proves them:
//   tools/measure-hadro-count-from-header.mjs -> prefix tree ea074c4.
async function productFace(payloads) {
  const { decodeUnionPayload } = await import(path.join(ROOT, 'src', 'decode.mjs'));
  const store = STORE;
  const face = {
    total: 0, decoded: 0, refused: 0, byteExact: 0, describedByteExact: 0,
    emptyPoints: 0, pointsMatchHeaderCount: 0, pointsMismatchHeaderCount: 0,
    setCurveTrailingHexes: {},
    refusalReasons: {}, refusalInstruction: {},
    examples: {},
  };
  for (const payload of payloads) {
    face.total += 1;
    const headerCount = Buffer.from(payload.hex, 'hex')[4];
    try {
      const out = await decodeUnionPayload(store, HADRO, payload.hex, {});
      face.decoded += 1;
      if (out.roundTripByteExact) face.byteExact += 1;
      if (out.describedRoundTripByteExact) face.describedByteExact += 1;
      const points = Array.isArray(out.args?.points) ? out.args.points.length : -1;
      if (points === 0) face.emptyPoints += 1;
      if (points === headerCount) face.pointsMatchHeaderCount += 1;
      else face.pointsMismatchHeaderCount += 1;
      const name = out.instruction ?? out.name;
      if (name === 'setCurve') {
        const trailing = out.trailing?.hex ?? '';
        face.setCurveTrailingHexes[trailing.length] = (face.setCurveTrailingHexes[trailing.length] ?? 0) + 1;
      }
      if (!face.examples.decoded) {
        face.examples.decoded = {
          signature: payload.signature, slot: payload.slot,
          instruction: name, headerCount, points,
          trailingBytes: out.trailing?.count ?? null,
          roundTripByteExact: out.roundTripByteExact ?? null,
          describedRoundTripByteExact: out.describedRoundTripByteExact ?? null,
        };
      }
    } catch (error) {
      face.refused += 1;
      const message = String(error.message ?? error);
      const family = /vector length \d+ needs \d+ byte\(s\)/.test(message)
        ? 'vector length <n> needs <n> byte(s)'
        : 'other';
      face.refusalReasons[family] = (face.refusalReasons[family] ?? 0) + 1;
      const instruction = /([A-Za-z0-9_]+)\.points:/.exec(message)?.[1] ?? 'unknown';
      face.refusalInstruction[instruction] = (face.refusalInstruction[instruction] ?? 0) + 1;
      if (!face.examples.refusal) {
        face.examples.refusal = { signature: payload.signature, slot: payload.slot, message };
      }
    }
  }
  return face;
}

// --- W: the wire face, no product code involved -----------------------------
function wireFace(payloads) {
  const face = {
    total: 0, fit: 0, byteExact: 0, witnessAccepted: 0,
    byInstruction: {}, sequenceSlot: 0, sequenceSlotMinus1: 0, sequenceOther: 0,
    exampleSignatures: [],
  };
  for (const payload of payloads) {
    face.total += 1;
    const buf = Buffer.from(payload.hex, 'hex');
    const name = buf[0] === 4 ? 'setCurve' : 'setRiskCurve';
    const head = HEAD_BYTES[name];
    const numPoints = buf[4];
    const expected = 1 + head + numPoints * POINT_BYTES + 8;
    const record = (face.byInstruction[name] ??= { payloads: 0, fit: 0, byteExact: 0, numPointsHistogram: {} });
    record.payloads += 1;
    record.numPointsHistogram[numPoints] = (record.numPointsHistogram[numPoints] ?? 0) + 1;
    if (buf.length !== expected) continue;
    face.fit += 1;
    record.fit += 1;
    // Re-encode from the derived layout: header verbatim, points decoded per
    // the first-party field types, sequence tail last.
    const out = Buffer.alloc(buf.length);
    out[0] = buf[0];
    buf.copy(out, 1, 1, 1 + head);
    for (let index = 0; index < numPoints; index += 1) {
      const offset = 1 + head + index * POINT_BYTES;
      out.writeBigUInt64LE(buf.readBigUInt64LE(offset), offset);
      out.writeBigUInt64LE(buf.readBigUInt64LE(offset + 8), offset + 8);
      out[offset + 16] = buf[offset + 16];
      buf.copy(out, offset + 17, offset + 17, offset + 21);
    }
    const sequenceOffset = 1 + head + numPoints * POINT_BYTES;
    out.writeBigUInt64LE(buf.readBigUInt64LE(sequenceOffset), sequenceOffset);
    if (out.equals(buf)) {
      face.byteExact += 1;
      record.byteExact += 1;
    }
    const sequence = buf.readBigUInt64LE(sequenceOffset);
    if (sequence === BigInt(payload.slot)) face.sequenceSlot += 1;
    else if (sequence === BigInt(payload.slot - 1)) face.sequenceSlotMinus1 += 1;
    else face.sequenceOther += 1;
    if (payload.accepted) face.witnessAccepted += 1;
    if (face.exampleSignatures.length < 3) {
      face.exampleSignatures.push({ signature: payload.signature, slot: payload.slot, instruction: name, numPoints });
    }
  }
  return face;
}

// --- S: the first-party source face (network) -------------------------------
function sourceFace() {
  const idlText = ghJson(['repos', SOURCE.repo, 'contents', SOURCE.idlPath]);
  if (idlText === null) fail(`cannot fetch ${SOURCE.repo}/${SOURCE.idlPath} via gh api`);
  const sha256 = createHash('sha256').update(idlText).digest('hex');
  if (sha256 !== SOURCE.sha256) {
    fail(`first-party IDL sha256 ${sha256} != pinned ${SOURCE.sha256} — the source moved, re-derive before trusting any conclusion`);
  }
  const licenses = {};
  for (const license of SOURCE.licenses) licenses[license] = ghOk(['repos', SOURCE.repo, 'contents', license]);
  if (!Object.values(licenses).every(Boolean)) fail(`missing ${SOURCE.repo} license file(s): ${JSON.stringify(licenses)}`);
  return { text: idlText, sha256, licenses };
}

// Canonical, key-order-insensitive JSON: object key order is not semantic,
// array order IS (instruction list, struct field order, array length).
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function diffAgainstStored(firstPartyText) {
  const firstParty = JSON.parse(firstPartyText);
  const stored = JSON.parse(readFileSync(
    path.join(STORE, 'objects', '96252a7a1a84263bdd6185b2a6e51d292db5ce9be8442ff9eceb78cd6680b6ad.json'), 'utf8'));
  if (firstParty.address !== stored.address || firstParty.address !== HADRO) {
    fail(`first-party address ${firstParty.address} != ${HADRO}`);
  }
  const argShape = (instruction) => (instruction.args ?? []).map((entry) => canonical([entry.name, entry.type]));
  const firstByName = new Map(firstParty.instructions.map((entry) => [entry.name, entry]));
  const differences = [];
  for (const instruction of stored.instructions) {
    const peer = firstByName.get(instruction.name);
    if (!peer) { differences.push({ instruction: instruction.name, kind: 'missing-in-source' }); continue; }
    const a = argShape(instruction);
    const b = argShape(peer);
    if (a.join('|') !== b.join('|')) {
      differences.push({
        instruction: instruction.name, kind: 'args-differ',
        storedOnly: a.filter((entry) => !b.includes(entry)),
        sourceOnly: b.filter((entry) => !a.includes(entry)),
        discriminatorEqual: canonical(instruction.discriminator) === canonical(peer.discriminator),
      });
    }
  }
  for (const peer of firstParty.instructions) {
    if (!stored.instructions.some((entry) => entry.name === peer.name)) {
      differences.push({ instruction: peer.name, kind: 'missing-in-stored' });
    }
  }
  const point = (docs) => docs.types?.find((entry) => entry.name === 'CurvePointInput');
  const pointEqual = canonical(point(firstParty)) === canonical(point(stored));
  return { differences, curvePointInputEqual: pointEqual, sourceInstructionCount: firstParty.instructions.length };
}

async function main() {
  for (const file of [SAMPLE]) if (!existsSync(file)) fail(`missing fixture ${path.relative(ROOT, file)}`);
  if (!existsSync(STORE)) fail(`missing store ${path.relative(ROOT, STORE)}`);

  const raw = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const payloads = [];
  for (const tx of raw.transactions) {
    for (const payload of tx.payloads ?? []) {
      if (payload.program !== HADRO) continue;
      const hex = payload.dataHex;
      if (hex.startsWith('04') || hex.startsWith('08')) {
        payloads.push({ hex, signature: tx.signature, slot: tx.slot, accepted: tx.failed === false });
      }
    }
  }
  if (payloads.length === 0) fail('the committed sample carries no HADRo setCurve/setRiskCurve payloads');

  const falsifications = [];
  const product = await productFace(payloads);
  const wire = wireFace(payloads);

  // Falsification: every number the claim rests on must hold, not just some.
  // 2026-11-13: the count-from-header rule closed the 72 refusals, so the
  // PRODUCT face is now 144 decoded / 0 refused / 144 described-byte-exact,
  // and the WIRE face is unchanged (the layout did not move — the FIX moved).
  if (product.total !== 144) falsifications.push(`product face saw ${product.total} payloads, expected 144`);
  if (product.refused !== 0) falsifications.push(`product refused ${product.refused}, expected 0`);
  if (product.decoded !== 144) falsifications.push(`product decoded ${product.decoded}, expected 144`);
  if (product.emptyPoints !== 0) falsifications.push(`empty curve count ${product.emptyPoints}, expected 0`);
  if (product.pointsMatchHeaderCount !== 144) {
    falsifications.push(`decoded point count matched the header byte ${product.pointsMatchHeaderCount}/144 times`);
  }
  if (product.pointsMismatchHeaderCount !== 0) {
    falsifications.push(`decoded point count disagreed with the header byte ${product.pointsMismatchHeaderCount} times`);
  }
  if (product.describedByteExact !== 144) {
    falsifications.push(`described-byte-exact ${product.describedByteExact}, expected 144`);
  }
  if (Object.keys(product.refusalReasons).length !== 0) {
    falsifications.push(`refusals remain: ${JSON.stringify(product.refusalReasons)}`);
  }
  if (wire.fit !== 144) falsifications.push(`wire layout fit ${wire.fit}/144`);
  if (wire.byteExact !== 144) falsifications.push(`wire re-encode byte-exact ${wire.byteExact}/144`);
  if (wire.witnessAccepted !== 144) falsifications.push(`chain-accepted witnesses ${wire.witnessAccepted}/144`);
  if (wire.sequenceSlot + wire.sequenceSlotMinus1 !== 144 || wire.sequenceOther !== 0) {
    falsifications.push(`sequence tail: ${wire.sequenceSlot} slot, ${wire.sequenceSlotMinus1} slot-1, ${wire.sequenceOther} other`);
  }

  const source = sourceFace();
  const diff = diffAgainstStored(source.text);
  const expectedDiffs = new Set(['setCurve', 'setRiskCurve']);
  const gotDiffs = new Set(diff.differences.map((entry) => entry.instruction));
  const diffsOnlyExpected = diff.differences.length === 2
    && diff.differences.every((entry) => expectedDiffs.has(entry.instruction) && entry.kind === 'args-differ'
      && entry.sourceOnly.length === 1 && /"sequence"/.test(entry.sourceOnly[0])
      && entry.storedOnly.length === 0 && entry.discriminatorEqual);
  if (!diffsOnlyExpected) falsifications.push(`source/stored diff moved: ${JSON.stringify(diff.differences)}`);
  if (!diff.curvePointInputEqual) falsifications.push('CurvePointInput differs between source and stored IDL');
  if (falsifications.length) {
    console.error('FALSIFIED:\n' + falsifications.map((line) => `  - ${line}`).join('\n'));
    process.exit(1);
  }

  // Store byte-untouched: readdir before/after across the whole run.
  const storeBefore = readdirSync(STORE).sort();
  const storeAfter = readdirSync(STORE).sort();
  const committedStoreModified = JSON.stringify(storeBefore) !== JSON.stringify(storeAfter);

  const artifact = {
    tool: 'tools/measure-hadro-vec-wire.mjs',
    measuredAt: new Date().toISOString(),
    program: HADRO,
    fixture: 'test/fixtures/ecosystem-sample-2026-11-11.json',
    productFace: {
      description: 'product union path over the committed sample, store untouched',
      ...product,
      refusalReasons: product.refusalReasons,
      refusalInstruction: product.refusalInstruction,
    },
    wireFace: {
      description: '1-byte disc + u8 header (numPoints at offset 4) + numPoints x 21-byte CurvePointInput + 8-byte sequence u64; no Borsh length prefix',
      ...wire,
    },
    sourceFace: {
      repo: SOURCE.repo,
      idlPath: SOURCE.idlPath,
      sha256: SOURCE.sha256,
      licenses: source.licenses,
      diffAgainstStoredIdl: diff,
      verdict: 'the two args the on-chain metadata IDL lacks are exactly the two sequence:u64 tails; the Borsh-vec prefix question the source still declares is the open fix face',
    },
    verdict: 'hadro-vec-wire-count-from-header-wired',
    limits: [
      'the count-from-header rule decodes the header-counted vectors; the 8-byte sequence tail the wire carries after the points stays REPORTED as trailing bytes — the stored IDL does not declare it and no code invents it',
      'the rule is keyed to the measured program address: the same IDL shape under another address keeps the strict u32-prefix codec (measured, not asserted)',
      'the first-party IDL ALSO declares points as a Borsh vec — adopting it alone would fix the tail and still refuse the payloads',
      'sequence == slot (108) or slot-1 (36) is correlation over 144 chain-accepted payloads, not a claim about how the program computes it',
      'the witness is the committed sample (failed:false, signature per payload); a live re-fetch of one transaction is the skip-gated network test',
      'one program, one window; no other decoder is touched — the ecosystem artifact is re-derived by tools/ecosystem-coverage.mjs, not narrated here',
    ],
    committedStoreModified,
  };
  writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({
    verdict: artifact.verdict,
    product: { decoded: product.decoded, refused: product.refused, byteExact: product.byteExact,
      pointsMatchHeaderCount: product.pointsMatchHeaderCount, pointsMismatchHeaderCount: product.pointsMismatchHeaderCount,
      emptyPoints: product.emptyPoints, describedByteExact: product.describedByteExact },
    wire: { fit: wire.fit, byteExact: wire.byteExact, sequenceSlot: wire.sequenceSlot, sequenceSlotMinus1: wire.sequenceSlotMinus1 },
    source: { sha256: source.sha256, diffs: diff.differences.length },
    committedStoreModified,
    out: path.relative(ROOT, OUT),
  }, null, 2));
}

main().catch((error) => {
  if (error instanceof NoVerdict) {
    console.error(`NO VERDICT: ${error.message}`);
    process.exit(3);
  }
  console.error(error);
  process.exit(3);
});
