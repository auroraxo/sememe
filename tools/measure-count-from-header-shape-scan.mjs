#!/usr/bin/env node
// tools/measure-count-from-header-shape-scan.mjs — the card's standing next
// step 4: "a third program with the header-count shape ONLY after own
// measurement". This is that measurement: which instructions in the WHOLE
// committed store carry the integer-before-vec shape, which of them have any
// payload witness in the committed capture, and what a shape-keyed
// generalization of the rule would do to them.
//
//   node tools/measure-count-from-header-shape-scan.mjs \
//     --out research/count-from-header-shape-scan-2026-11-13.json
//
// WHY GENERALIZATION IS THE QUESTION (src/wire-layout.mjs header):
// the count-from-header rule fires ONLY for program+instruction pairs in a
// measured table, because "an integer argument declared before a vector" is
// NOT the same statement as "the wire counts its elements with that integer".
// A shape-keyed rule (fire on every integer-before-vec) would be cheaper to
// write and would carry the exact HADRo garbage-number failure into other
// programs. This tool enumerates the shape candidates offline and measures,
// per candidate, (a) whether the committed capture carries ANY payload of
// that instruction, and (b) whether the IDL's own documentation calls the
// integer a count or something else (a mode flag).
//
// FACES THIS MEASUREMENT PINS (all offline, committed fixtures only):
//
//   F1 CANDIDATE ENUMERATION: every stored receipt+object pair is scanned;
//      an instruction is a candidate when one declared integer argument
//      (u8..u64/i8..i64) precedes a vec of fixed-size elements. Elements
//      sized through `defined` structs recurse to a fixed size or the pair
//      is NOT a candidate (variable-size elements make the shape undefined).
//   F2 WITNESS FACE: for each candidate the committed sample is counted by
//      discriminator prefix (the program's OWN stored discriminator length:
//      HADRo stores 1-byte discriminators, CAMM 8-byte anchor sighashes —
//      the 13.11. PULS V rule "stored means any non-empty byte array").
//      Chain-accepted counts are reported apart from totals.
//   F3 TABLE FACE: candidates are cross-referenced against the live
//      COUNT_FROM_HEADER table (imported from src/wire-layout.mjs, not
//      restated): wired-and-witnessed (HADRo setCurve/setRiskCurve),
//      in-table-but-unwitnessed, or OUTSIDE the table.
//   F4 FALSE-POSITIVE FACE: a candidate whose integer is documented as a
//      mode, not a count. Raydium CLMM update_operation_account declares
//      `param` u8 followed by `keys` Vec<Pubkey>, and its own docs say the
//      value selects update/remove of owner/whitelist-mint ("can be 0 | 1 |
//      2 | 3") — it does NOT state how many keys follow. A shape-keyed rule
//      would decode that vec with a count read from a mode flag.
//   F5 VERDICT: "no third program carries a witnessed header-count shape in
//      this window" — the table's evidence stays a single program — OR the
//      opposite if a real third-program witness exists. The tool also states
//      the GENERALIZATION FACE: falsified-by-flag (F4 found) or
//      no-flag-case-found.
//
// WHAT THIS DOES NOT CLAIM: zero payloads in one 6-block window is not
// absence on chain. The HADRo instructions 0x0e/0x12/0x1d (updateSpread-
// Config, submitCurveUpdates, removeSpreadTriggers) carry the shape and have
// 0 payloads HERE; a live re-scan was attempted from this host on 13.11. and
// the public endpoint answered HTTP 429 to EVERY getTransaction — no witness
// was obtainable, and that is recorded as a limit, not worked around. The
// rule stays gated on measurement; nothing here extends it.
//
// Exit codes: 0 measured; 2 usage/IO (missing fixtures); 3 NO VERDICT
// (the scan cannot answer — e.g. no candidates at all, which would mean the
// fixtures changed under the tool).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNT_FROM_HEADER, countFromHeader } from '../src/wire-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};

const STORE = path.resolve(flag('--store', path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11')));
const SAMPLE = path.resolve(flag('--sample', path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json')));
const OUT = flag('--out', path.join(ROOT, 'research', 'count-from-header-shape-scan-2026-11-13.json'));

const INT_SIZES = {
  u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8,
};

class NoVerdict extends Error {}

function usageFail(message) {
  console.error(message);
  process.exit(2);
}

for (const p of [path.join(STORE, 'receipts'), path.join(STORE, 'objects')]) {
  if (!existsSync(p)) usageFail(`store piece missing: ${p}`);
}
if (!existsSync(SAMPLE)) usageFail(`sample missing: ${SAMPLE}`);

// --- IDL type sizing (recursion through defined structs) -------------------

function loadTypes(idl) {
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

// Byte size of a FIXED-size type, or null when the type is variable or
// unknown. For {"vec": T} the element size is size(T) (the vector body of a
// counted face is count x size(T)).
function typeSize(t, types, depth = 0) {
  if (depth > 12) return null;
  if (typeof t === 'string') {
    if (t in INT_SIZES) return INT_SIZES[t];
    if (t === 'bool') return 1;
    if (t === 'pubkey') return 32;
    if (types.has(t)) {
      const fields = structFields(types.get(t));
      if (!fields) return null;
      let total = 0;
      for (const f of fields) {
        const s = typeSize(f?.type, types, depth + 1);
        if (s === null) return null;
        total += s;
      }
      return total;
    }
    return null;
  }
  if (!t || typeof t !== 'object') return null;
  const key = Object.keys(t)[0];
  const value = t[key];
  if (key === 'vec') return typeSize(value, types, depth + 1);
  if (key === 'option') {
    const inner = typeSize(value, types, depth + 1);
    return inner === null ? null : 1 + inner;
  }
  if (key === 'array') {
    const [inner, n] = Array.isArray(value) ? value : [value?.type, value?.len];
    const s = typeSize(inner, types, depth + 1);
    return s === null || !Number.isInteger(n) ? null : s * n;
  }
  if (key === 'defined') {
    const name = typeof value === 'string' ? value : value?.name;
    return name ? typeSize(name, types, depth + 1) : null;
  }
  return null;
}

function unwrapType(a) {
  let t = a?.type;
  if (t && typeof t === 'object' && 'kind' in t) t = t.kind;
  return t;
}

function isVecOfFixedSize(t, types) {
  const inner = vecInner(t);
  if (inner === null) return null;
  return typeSize(inner, types);
}

// The element type of a vec argument, however the IDL spells it:
// {"vec": X}, {"kind": {"vec": X}}, {"kind": "vec", ...}.
function vecInner(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.kind && typeof t.kind === 'object') t = t.kind;
  if (t.kind === 'vec') return t.items ?? t.inner ?? t.type ?? null;
  if (Object.keys(t)[0] === 'vec') return t.vec;
  return null;
}

// --- candidate enumeration (F1) ---------------------------------------------

const receiptFile = path.join(STORE, 'receipts');
const pairs = [];
for (const name of readdirSync(receiptFile).sort()) {
  if (!name.endsWith('.json')) continue;
  const receipt = JSON.parse(readFileSync(path.join(receiptFile, name), 'utf8'));
  const fp = String(receipt.fingerprint ?? '').replace(/^sha256:/, '');
  const objectPath = path.join(STORE, 'objects', `${fp}.json`);
  if (!receipt.program || !existsSync(objectPath)) continue;
  pairs.push({ program: receipt.program, source: receipt.source, slot: receipt.slot, idl: JSON.parse(readFileSync(objectPath, 'utf8')) });
}

const candidates = [];
for (const { program, source, idl } of pairs) {
  if (!idl || typeof idl !== 'object') continue;
  const types = loadTypes(idl);
  for (const ins of idl.instructions ?? []) {
    const args = ins.args ?? [];
    for (let i = 0; i < args.length; i++) {
      const t = unwrapType(args[i]);
      if (typeof t !== 'string' || !(t in INT_SIZES)) continue;
      for (let j = i + 1; j < args.length; j++) {
        const vt = unwrapType(args[j]);
        const elemBytes = isVecOfFixedSize(vt, types);
        if (elemBytes === null) continue;
        const docText = [ins.docs, args[i].docs].flat(2).filter(Boolean).join(' ');
        candidates.push({
          program, source,
          instruction: ins.name,
          discriminator: ins.discriminator ?? null,
          countArg: args[i].name, countType: t,
          vecArg: args[j].name, elementBytes: elemBytes,
          element: JSON.stringify(vecInner(vt)).slice(0, 80),
          argIndex: i, vecIndex: j, argCount: args.length,
          docsExcerpt: docText.slice(0, 240),
          inTable: Boolean(countFromHeader({ address: program, ...(idl.address ? {} : {}) }, ins.name))
            || Boolean(COUNT_FROM_HEADER[program]?.instructions?.[ins.name]),
        });
        break;
      }
    }
  }
}
if (candidates.length === 0) { console.error('NO VERDICT: the store carries no integer-before-vec shape at all — the fixtures changed under the tool'); process.exit(3); }

// --- witness face (F2): count sample payloads per candidate -----------------

const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const txs = sample.transactions ?? [];
if (!Array.isArray(txs) || txs.length === 0) { console.error('NO VERDICT: the committed sample carries no transactions'); process.exit(3); }

// payload prefix key per candidate: the program's own discriminator length.
// Build per-program discriminator -> candidate index lists.
const byProgram = new Map();
for (const c of candidates) {
  if (!byProgram.has(c.program)) byProgram.set(c.program, []);
  byProgram.get(c.program).push(c);
}

const discToHex = (disc) => Buffer.from(disc).toString('hex');
const payloadCounts = new Map(); // candidate key -> {payloads, accepted, failed}
for (const [program, list] of byProgram) {
  // candidate discriminators at their stored length, deduped: several
  // integer-args of the SAME instruction share one discriminator, and
  // counting per candidate would multiply the witness count.
  const byHex = new Map();
  for (const c of list) {
    if (!Array.isArray(c.discriminator) || c.discriminator.length === 0) continue;
    const hex = discToHex(c.discriminator);
    if (!byHex.has(hex)) byHex.set(hex, c);
  }
  const discs = [...byHex.entries()].map(([hex, c]) => ({ hex, c }));
  for (const { hex, c } of discs) {
    payloadCounts.set(`${c.program}|${c.instruction}`, { payloads: 0, accepted: 0, failed: 0 });
  }
  for (const tx of txs) {
    for (const p of tx.payloads ?? []) {
      if (p.program !== program) continue;
      const h = String(p.dataHex ?? '').toLowerCase();
      const hit = discs.find(({ hex }) => h.startsWith(hex));
      if (!hit) continue;
      const rec = payloadCounts.get(`${hit.c.program}|${hit.c.instruction}`);
      rec.payloads += 1;
      if (tx.failed === false) rec.accepted += 1; else rec.failed += 1;
    }
  }
}

// --- faces (F3/F4) -----------------------------------------------------------

const FLAG_DOC_RE = /(?:can be|value is|indicates|select)\b[^.]*\|/i;

// One face per program+instruction: the shape is a property of the
// instruction, and every count-arg candidate of the same instruction shares
// one witness count. A per-candidate face would multiply payload counts by
// the number of integer args (setCurve has 5) and the same discriminator
// would be counted once per candidate — a lying number is worse than none.
const unique = new Map();
for (const c of candidates) {
  const key = `${c.program}|${c.instruction}`;
  if (!unique.has(key)) unique.set(key, []);
  unique.get(key).push(c);
}
const faces = [];
for (const [key, group] of unique) {
  const head = group[0];
  const w = payloadCounts.get(key) ?? { payloads: 0, accepted: 0, failed: 0 };
  const flagDocumented = group.some((c) => FLAG_DOC_RE.test(c.docsExcerpt));
  const tableEntry = COUNT_FROM_HEADER[head.program]?.instructions?.[head.instruction] ?? null;
  faces.push({
    program: head.program,
    instruction: head.instruction,
    candidates: group.map((c) => ({ countArg: c.countArg, countType: c.countType, vecArg: c.vecArg, elementBytes: c.elementBytes })),
    payloads: w.payloads,
    accepted: w.accepted,
    failed: w.failed,
    inTable: Boolean(tableEntry),
    tableCountArg: tableEntry?.countArg ?? null,
    tableVectorArg: tableEntry?.vectorArg ?? null,
    flagDocumented,
  });
}

const wiredWitnessed = faces.filter((f) => f.inTable && f.payloads > 0);
const unwitnessedShape = faces.filter((f) => f.payloads === 0);
const thirdProgramWitnessed = faces.filter((f) => !f.inTable && f.payloads > 0);
const flagFaces = faces.filter((f) => f.flagDocumented && f.payloads === 0);

const hadroPrograms = new Set(wiredWitnessed.map((f) => f.program));
const verdict = thirdProgramWitnessed.length === 0
  ? 'no-third-program-witnessed-in-window'
  : 'third-program-candidate-present';

const generalization = flagFaces.length > 0
  ? 'falsified-by-flag-arg'
  : (thirdProgramWitnessed.length > 0 ? 'candidate-present-open-question' : 'no-flag-case-in-store');

// --- artifact ----------------------------------------------------------------

const artifact = {
  tool: 'tools/measure-count-from-header-shape-scan.mjs',
  measuredAt: new Date().toISOString(),
  store: path.relative(ROOT, STORE),
  sample: path.relative(ROOT, SAMPLE),
  method: 'offline scan of every committed receipt+object pair; candidate = declared integer arg before a vec of fixed-size elements; witnesses counted in the committed sample by the program\'s own stored discriminator length',
  ruleQuestion: 'src/wire-layout.mjs gates the count-from-header rule on MEASURED program+instruction pairs. This tool measures whether that gating is load-bearing in the committed window: what a shape-keyed generalization would fire on.',
  candidateCount: candidates.length,
  programs: [...new Set(candidates.map((c) => c.program))].sort(),
  faces,
  summary: {
    wiredWitnessed: wiredWitnessed.map((f) => `${f.program}/${f.instruction} payloads=${f.payloads} accepted=${f.accepted}`),
    wiredPrograms: [...hadroPrograms].sort(),
    unwitnessedShape,
    thirdProgramWitnessed,
    flagFaces,
  },
  verdict,
  generalization,
  limits: [
    'zero payloads in this window is not absence on chain: the HADRo instructions 0x0e/0x12/0x1d and CAMM update_operation_account carry the shape with no payload witness HERE; a live re-scan was attempted 13.11. from this host — api.mainnet-beta answered HTTP 429 to EVERY getTransaction (0 transactions checked), and a rate-limited re-run through a public relay was cut off by a 240-second budget before reaching the wanted instructions; no fresher witness was obtainable and none is claimed',
    'the flag test (flagDocumented) is a text heuristic over the instruction/arg docs; CAMM update_operation_account is the pinned real case, not a general parser',
    'candidates with a variable-size vector element (element size unknown) are NOT enumerated — the shape would be undefined',
    'the tool imports the live COUNT_FROM_HEADER table; it measures the store against the rule, never restates the rule',
  ],
};

const json = JSON.stringify(artifact, null, 2) + '\n';
try {
  // cheap self-checks before writing anything
  if (!Number.isInteger(candidates.length) || candidates.length === 0) throw Error('no candidates');
  const camm = faces.find((f) => f.program === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' && f.instruction === 'update_operation_account');
  if (!camm) throw Error('the CAMM update_operation_account shape vanished from the store');
  if (camm.flagDocumented !== true) throw Error('the CAMM docs no longer state the flag semantics this face was measured on');
  if (camm.payloads !== 0) throw Error('CAMM update_operation_account now carries payloads in the window — the verdict must be re-derived, not pinned');
  const setCurve = faces.find((f) => f.instruction === 'setCurve');
  if (!setCurve || setCurve.payloads !== 72 || setCurve.accepted !== 72) {
    throw Error(`setCurve witness face changed (expected 72/72 chain-accepted, got ${setCurve ? `${setCurve.payloads}/${setCurve.accepted}` : 'absent'}) — re-derive, do not pin`);
  }
} catch (error) {
  console.error(`NO VERDICT: ${String(error?.message ?? error).slice(0, 300)}`);
  process.exit(3);
}
const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
await import('node:fs/promises').then(({ writeFile, mkdir }) =>
  mkdir(path.dirname(outPath), { recursive: true }).then(() => writeFile(outPath, json)));
console.log(`${outPath}: ${verdict}; generalization ${generalization}; candidates ${candidates.length}; wired+witnessed ${wiredWitnessed.length}; unwitnessed ${unwitnessedShape.length}; flag faces ${flagFaces.length}`);
