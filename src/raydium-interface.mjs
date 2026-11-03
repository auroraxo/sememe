// Derive the Raydium AMM v4 wire table from the VENDORED UPSTREAM RUST.
//
// Same contract as src/native-interface.mjs and src/token-interface.mjs, one
// level up in complexity: this program is a LEGACY (pre-Anchor) Rust program
// whose interface is neither an Anchor IDL nor a borsh enum. It publishes no
// IDL account at either address sememe can pull from (measured 2026-11-02 on
// mainnet), and its wire form is a hand-written `pack()`/`unpack()` pair with
// a SPARSE u8 tag set.
//
// Why derive instead of transcribe: the tag set is sparse AND the declaration
// order does NOT equal the wire order. Upstream declares 19 variants; only 12
// are reachable on the wire, and their tags are 1,3,4,6,7,9,11,14,15,16,17,18
// — a hand-written table would shift every tag and mislabel money movement,
// exactly the defect the SPL Token table was built to remove.
//
// The rules, each one upstream's own text:
//   - the wire tag is the literal integer upstream's `pack()` arm pushes, and
//     the `unpack()` arm that BINDS that same integer must name the same
//     variant — the two are cross-checked, so a tag only one side knows
//     throws;
//   - the arg sequence is the sequence of byte writes in the `pack()` arm,
//     cross-checked against the sequence of reads in the `unpack()` arm —
//     by COUNT and WIDTH, because upstream names the same value differently on
//     the two sides (pack writes `owner`, unpack reads `pubkey`);
//   - a trailing OPTIONAL group (upstream's `if X.is_some()` write guarded by
//     an `if rest.len() >= N` read) is present only when N bytes remain — it
//     is NOT a 1-byte C-style option tag, and the threshold is upstream's;
//   - a BRANCHED variant (upstream's `match param { 0 | 1 => .., 2 => .. }`)
//     is selected by a discriminator byte upstream itself names, and the
//     branch's value set is upstream's own enum text (AmmParams) or its own
//     numeric literal;
//   - `Fees` is a packed struct (8 x u64, LEN 64) declared in the upstream
//     state module, so its bytes come from upstream's field order;
//   - the variants upstream itself marks "not supported" are named with
//     `wire: 'rejected'` — upstream PANICS on them (`unimplemented!()`), so a
//     decoder that named them would disagree with the chain;
//   - every byte write in a `pack()` arm must be covered by exactly one
//     pinned rule, and every read in the matching `unpack()` arm must be
//     covered by exactly one pinned write — an upstream change that nobody
//     re-reviewed throws here instead of decoding as "unknown".
//
// Dependency-free on purpose: it is imported by the decode path.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const RAYDIUM_PINS = {
  ammV4: {
    repo: 'raydium-io/raydium-amm',
    dir: 'raydium-amm',
    pin: '91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6',
    instructionFile: 'program/src/instruction.rs',
    stateFile: 'program/src/state.rs',
  },
};

export const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const stripAttributes = (src) => src.replace(/#\[[\s\S]*?\]\s*/g, '');

/** The body of `fn ...` from comment-stripped source. */
function fnBody(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) throw Error(`function not found: ${signature}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw Error(`${signature}: body never closes`);
}

/** The `{ ... }` block starting at `open`, plus where it ends. */
export function blockAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
  }
  throw Error('block never closes');
}

/** Brace depth of `text` at `index`. */
function braceDepth(text, index) {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  return depth;
}

/** Read a call expression `name(...)` starting at `at`, returning its text. */
function readCall(text, at) {
  const open = text.indexOf('(', at);
  if (open < 0) throw Error(`call without arguments at ${at}`);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return { text: text.slice(at, i + 1), end: i + 1 };
    }
  }
  throw Error('call never closes');
}

/** Split a block body on its TOP-LEVEL commas. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * The arms of a `match` block, at the TOP level of that block only.
 *
 * Upstream writes `1 => { ... }`, `0 | 2 | 5 => { ... }`, a brace-less
 * `7 => Self::WithdrawPnl,` and a final `_ => { ... }`. A nested match (up
 * writes `match param { ... }` inside a tag arm, and `match fees { ... }`
 * inside a pack arm) must NOT be read as an arm of the outer match — the
 * first version of this parser did exactly that and bound tag 0 and tag 1 to
 * SetParams' inner arms.
 */
export function parseArmsAtTopLevel(inner) {
  const arms = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i++;
    if (i >= inner.length) break;
    const headerStart = i;
    let depth = 0;
    let arrow = -1;
    for (let j = i; j < inner.length; j++) {
      const ch = inner[j];
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
      else if (ch === '=' && inner[j + 1] === '>' && depth === 0) { arrow = j; break; }
    }
    if (arrow < 0) throw Error('match arm without =>');
    const header = inner.slice(headerStart, arrow).trim();
    let k = arrow + 2;
    while (k < inner.length && /\s/.test(inner[k])) k++;
    if (inner[k] !== '{') {
      // A brace-less arm (`7 => Self::WithdrawPnl,`) carries no args.
      const end = inner.indexOf(',', k);
      arms.push({ header, body: end < 0 ? inner.slice(k) : inner.slice(k, end), braceless: true });
      i = end < 0 ? inner.length : end + 1;
      continue;
    }
    const block = blockAt(inner, k);
    arms.push({ header, body: block.inner });
    i = block.end;
  }
  return arms;
}

/** `pub struct NAME { ... }` declarations with their field types. */
export function parseStructs(src) {
  const structs = new Map();
  const re = /pub struct\s+([A-Za-z0-9_]+)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const body = blockAt(src, src.indexOf('{', m.index)).inner;
    const fields = [];
    for (const raw of splitTopLevel(body)) {
      const line = raw.trim();
      if (!line) continue;
      const field = line.match(/^pub\s+([a-z_][a-z0-9_]*)\s*:\s*(\[[A-Za-z0-9_]+;\s*[A-Za-z0-9_]+\]|[A-Za-z0-9_<>:]+)$/);
      if (!field) throw Error(`struct ${m[1]}: unreadable field declaration "${line}"`);
      fields.push({ name: field[1], type: field[2] });
    }
    structs.set(m[1], fields);
  }
  return structs;
}

/** The variant list of `pub enum AmmInstruction`, in declaration order. */
export function parseAmmVariants(src) {
  const at = src.indexOf('pub enum AmmInstruction');
  if (at < 0) throw Error('AmmInstruction enum not found');
  const body = blockAt(src, src.indexOf('{', at)).inner;
  const variants = [];
  for (const part of splitTopLevel(stripAttributes(body))) {
    const match = part.match(/^([A-Z][A-Za-z0-9_]*)\s*(?:\(\s*([A-Za-z0-9_]+)\s*(?:\{[^}]*\})?\s*\))?$/);
    if (!match) throw Error(`AmmInstruction: unreadable variant "${part}"`);
    variants.push({ name: match[1], struct: match[2] ?? null });
  }
  if (!variants.length) throw Error('AmmInstruction yielded no variants');
  return variants;
}

/** The `match tag { ... }` arms of `unpack()`. */
export function parseUnpackArms(unpackBody) {
  const at = unpackBody.indexOf('match tag {');
  if (at < 0) throw Error('unpack(): no match on the tag');
  const block = blockAt(unpackBody, unpackBody.indexOf('{', at));
  const arms = parseArmsAtTopLevel(block.inner);
  if (!arms.length) throw Error('unpack(): no arms');
  return arms;
}

/** The `pack()` arm for one variant: its destructure and its body. */
export function parsePackArm(packBody, variant) {
  // Tuple variants destructure as `Self::Name(Type { .. })`; unit variants
  // write `Self::Name => { ... }` with no parens at all.
  let at = packBody.indexOf(`Self::${variant}(`);
  let close = -1;
  if (at >= 0) {
    close = packBody.indexOf(')', at);
    if (close < 0) throw Error(`pack(): arm for ${variant} never closes its destructure`);
  } else {
    at = packBody.search(new RegExp(`Self::${variant}\\s*=>`));
    if (at < 0) throw Error(`pack(): no arm for variant ${variant}`);
    close = at + `Self::${variant}`.length - 1;
  }
  const arrow = packBody.indexOf('=>', close);
  if (arrow < 0) throw Error(`pack(): arm for ${variant} has no =>`);
  const braceAt = packBody.indexOf('{', arrow);
  const block = blockAt(packBody, braceAt);
  return { destructure: packBody.slice(at, close + 1), body: block.inner };
}

/**
 * The byte writes of one `pack()` arm, as a structured recipe.
 *
 * Three node kinds, matching the three shapes upstream actually uses:
 *   write      one byte write (`buf.push` / `buf.extend_from_slice`)
 *   optional   a write group guarded by `if X.is_some()`
 *   branch     a `match` over a discriminator byte
 */
export function parsePackRecipe(body) {
  const nodes = [];
  const keywordRe = /buf\.push\(|buf\.extend_from_slice\(|\bif\b|\bmatch\b/g;
  let m;
  while ((m = keywordRe.exec(body))) {
    if (braceDepth(body, m.index) !== 0) continue;
    const keyword = m[0];
    if (keyword === 'if') {
      const braceAt = body.indexOf('{', m.index);
      const condition = body.slice(m.index + 2, braceAt).trim();
      const block = blockAt(body, braceAt);
      nodes.push({ kind: 'optional', condition, body: block.inner });
      keywordRe.lastIndex = block.end;
      continue;
    }
    if (keyword === 'match') {
      const braceAt = body.indexOf('{', m.index);
      const subject = body.slice(m.index + 5, braceAt).trim();
      const block = blockAt(body, braceAt);
      nodes.push({ kind: 'branch', subject, body: block.inner });
      keywordRe.lastIndex = block.end;
      continue;
    }
    const call = readCall(body, m.index);
    nodes.push({ kind: 'write', expr: call.text });
    keywordRe.lastIndex = call.end;
  }
  return nodes;
}

/** One byte write of a `pack()` arm, as a pinned op. */
export function parseWrite(expr) {
  // The tag itself is a literal push (`buf.push(14)`), not a field write.
  const literal = expr.match(/^buf\.push\(\s*(\d+)\s*\)$/);
  if (literal) return { name: literal[1], kind: 'literal', value: Number(literal[1]) };
  const push = expr.match(/^buf\.push\(\s*\*?([a-z_][a-z0-9_]*)\s*\)$/);
  if (push) return { name: push[1], kind: 'u8' };
  const int = expr.match(/^buf\.extend_from_slice\(\s*&([a-z_][a-z0-9_]*)(?:\.unwrap\(\))?\.to_le_bytes\(\)\s*\)$/);
  if (int) return { name: int[1], kind: 'le_int' };
  const key = expr.match(/^buf\.extend_from_slice\(\s*&([a-z_][a-z0-9_]*)\.to_bytes\(\)\s*\)$/);
  if (key) return { name: key[1], kind: 'pubkey' };
  const raw = expr.match(/^buf\.extend_from_slice\(\s*&([a-z_][a-z0-9_]*)\s*\)$/);
  if (raw) return { name: raw[1], kind: 'raw' };
  throw Error(`pack(): byte write not covered by a pinned rule: ${expr}`);
}

/** The reads of an `unpack()` arm body, as pinned ops. */
export function parseReads(body) {
  const reads = [];
  const intRe = /let\s+\(\s*([a-z_][a-z0-9_]*)\s*,\s*[a-z_][a-z0-9_]*\s*\)\s*=\s*Self::unpack_u(\d+)\(/g;
  for (const m of body.matchAll(intRe)) {
    reads.push({ name: m[1], kind: 'le_int', width: Number(m[2]) });
  }
  const keyRe = /let\s+([a-z_][a-z0-9_]*)\s*=\s*array_ref!\[\s*[a-z_][a-z0-9_]*\s*,\s*\d+\s*,\s*(\d+)\s*\]/g;
  for (const m of body.matchAll(keyRe)) {
    reads.push({ name: m[1], kind: 'pubkey', width: Number(m[2]) });
  }
  const feesRe = /let\s+([a-z_][a-z0-9_]*)\s*=\s*Fees::unpack_from_slice\(/g;
  for (const m of body.matchAll(feesRe)) {
    reads.push({ name: m[1], kind: 'fees' });
  }
  return reads;
}

/** The `if rest.len() >= N { ... }` guards of an `unpack()` arm. */
export function parseLengthGuards(body) {
  const guards = [];
  const re = /if\s+rest\.len\(\)\s*>=\s*([A-Za-z0-9_:]+)\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const braceAt = body.indexOf('{', m.index);
    const block = blockAt(body, braceAt);
    guards.push({ threshold: m[1], body: block.inner, start: m.index, end: block.end });
  }
  return guards;
}

/** The same body with every length-guard block removed (for the flat reads). */
function withoutGuards(body, guards) {
  let out = body;
  for (const guard of [...guards].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, guard.start) + out.slice(guard.end);
  }
  return out;
}

/** The `match <subject> { ... }` of a body, with its arms. */
export function parseMatchArms(body) {
  const at = body.search(/\bmatch\s/);
  if (at < 0) return null;
  const braceAt = body.indexOf('{', at);
  const subject = body.slice(at + 5, braceAt).trim();
  const block = blockAt(body, braceAt);
  return { subject, arms: parseArmsAtTopLevel(block.inner) };
}

/** The numeric value of every `AmmParams` variant, from the upstream state module. */
export function parseAmmParams(stateSrc) {
  const at = stateSrc.indexOf('pub enum AmmParams');
  if (at < 0) throw Error('AmmParams enum not found');
  const body = blockAt(stateSrc, stateSrc.indexOf('{', at)).inner;
  const pairs = [...body.matchAll(/([A-Za-z0-9_]+)\s*=\s*(\d+)u64/g)].map((m) => [m[1], Number(m[2])]);
  if (!pairs.length) throw Error('AmmParams yielded no variants');
  return new Map(pairs);
}

/** The `Fees` packed struct: field names, types and byte length. */
export function parseFees(stateSrc) {
  const structs = parseStructs(stateSrc);
  const fields = structs.get('Fees');
  if (!fields) throw Error('Fees struct not found in the upstream state module');
  const lenRe = /const LEN:\s*usize\s*=\s*(\d+)/.exec(stateSrc);
  if (!lenRe) throw Error('Fees::LEN not found');
  const len = Number(lenRe[1]);
  const total = fields.reduce((acc, field) => acc + (field.type === 'u64' ? 8 : 0), 0);
  if (total !== len) throw Error(`Fees::LEN is ${len} but its fields sum to ${total}`);
  return { fields, len };
}

const INT_WIDTH = { u8: 1, u16: 2, u32: 4, u64: 8 };

/** Derive one program's interface document from its vendored upstream source. */
export function deriveRaydiumInterface(spec, { root = REPO_ROOT } = {}) {
  const base = path.join(root, 'vendor', spec.vendor.dir, spec.vendor.pin);
  const instructionPath = path.join(base, spec.vendor.instructionFile);
  const statePath = path.join(base, spec.vendor.stateFile);
  const instructionRaw = readFileSync(instructionPath);
  const stateRaw = readFileSync(statePath);
  const instructionSha256 = `sha256:${createHash('sha256').update(instructionRaw).digest('hex')}`;
  const stateSha256 = `sha256:${createHash('sha256').update(stateRaw).digest('hex')}`;
  const src = stripAttributes(stripComments(instructionRaw.toString('utf8')));
  const stateSrc = stripAttributes(stripComments(stateRaw.toString('utf8')));

  const structs = parseStructs(src);
  const variants = parseAmmVariants(src);
  const unpackBody = fnBody(src, 'pub fn unpack(input');
  const packBody = fnBody(src, 'pub fn pack(&self)');
  const ammParams = parseAmmParams(stateSrc);
  const fees = parseFees(stateSrc);

  // 1. What the wire BUILDER writes: variant -> tag, from the pack() arms.
  const packTags = new Map();
  for (const variant of variants) {
    let arm;
    try {
      arm = parsePackArm(packBody, variant.name);
    } catch {
      continue; // upstream has no pack() arm for this variant
    }
    const recipe = parsePackRecipe(arm.body);
    if (!recipe.length || recipe[0].kind !== 'write') throw Error(`${variant.name}: pack() arm does not start with a write`);
    const tagWrite = parseWrite(recipe[0].expr);
    if (tagWrite.kind !== 'literal') throw Error(`${variant.name}: pack() arm does not open with the literal tag push`);
    packTags.set(variant.name, tagWrite.value);
  }

  // 2. What the wire READER accepts: tag -> variant, from the unpack() arms.
  const unpackArms = parseUnpackArms(unpackBody);
  const unsupported = new Set();
  const unpackTags = new Map();
  for (const arm of unpackArms) {
    if (arm.header === '_') continue;
    const tags = arm.header.split('|').map((part) => Number(part.trim()));
    for (const tag of tags) {
      if (!Number.isInteger(tag)) throw Error(`unpack(): arm ${arm.header} is not a numeric tag`);
    }
    if (arm.body.includes('unimplemented!')) {
      for (const tag of tags) unsupported.add(tag);
      continue;
    }
    const variantMatch = arm.body.match(/Self::([A-Z][A-Za-z0-9_]*)/);
    if (!variantMatch) throw Error(`unpack(): tag ${arm.header} names no variant`);
    for (const tag of tags) {
      if (unpackTags.has(tag)) throw Error(`unpack(): tag ${tag} is bound twice`);
      unpackTags.set(tag, { variant: variantMatch[1], body: arm.body });
    }
  }

  // 3. Cross-check: pack() and unpack() must agree on every reachable tag.
  for (const [variant, tag] of packTags) {
    const bound = unpackTags.get(tag);
    if (!bound) throw Error(`${variant}: pack() writes tag ${tag} but unpack() binds no such tag`);
    if (bound.variant !== variant) throw Error(`tag ${tag}: pack() writes ${variant}, unpack() binds ${bound.variant}`);
  }
  for (const [tag, bound] of unpackTags) {
    if (!packTags.has(bound.variant)) throw Error(`${bound.variant}: unpack() binds tag ${tag} but pack() never writes it`);
  }

  // 4. The variants upstream marks unsupported: their tag is upstream's own
  //    declaration index, which upstream spells out in the same arm
  //    (`0 | 2 | 5 | 8 | 10 | 12 | 13 => unimplemented!()`).
  //
  //    Why this is derived rather than assumed: those seven tags have no
  //    pack() arm to read a number from, so position is the only source. The
  //    rule is therefore CHECKED on every variant that DOES have one — pack()
  //    writes the literal integer, unpack() binds that same integer, and both
  //    equal the variant's declaration index (measured on all twelve reachable
  //    variants 2026-11-03). If upstream ever reorders the enum so that a
  //    reachable tag stops matching its position, this throws instead of
  //    handing a wrong name to a refused tag.
  //
  //    The refusal itself does not depend on the naming: upstream panics on
  //    ALL of tags 0, 2, 5, 8, 10, 12, 13 alike (unimplemented!()), so a
  //    decoder that refuses those tags agrees with the chain whichever
  //    variant name sits behind them.
  const declared = variants.map((variant) => variant.name);
  for (const variant of variants) {
    const index = declared.indexOf(variant.name);
    if (packTags.has(variant.name) && packTags.get(variant.name) !== index) {
      throw Error(
        `${variant.name}: pack() writes tag ${packTags.get(variant.name)} but it is declared at `
        + `index ${index} — upstream no longer declares this enum in wire order, so a refused `
        + `variant's tag could not be derived from its declaration index`,
      );
    }
  }
  const instructions = [];
  for (const variant of variants) {
    const index = declared.indexOf(variant.name);
    if (packTags.has(variant.name)) {
      const tag = packTags.get(variant.name);
      const bound = unpackTags.get(tag);
      instructions.push(buildInstruction({
        variant, tag, unpackBody: bound.body, packBody, structs, ammParams, fees,
      }));
      continue;
    }
    if (!unsupported.has(index)) {
      throw Error(`${variant.name}: upstream neither writes nor marks this variant unsupported`);
    }
    instructions.push({
      tag: index,
      name: variant.name,
      wire: 'rejected',
      reason: 'upstream marks this variant unsupported (unimplemented!() in unpack(); InvalidInstructionData in pack())',
      args: [],
    });
  }
  // Every tag upstream lists as unsupported must be a declared variant.
  for (const tag of unsupported) {
    if (!instructions.some((entry) => entry.tag === tag && entry.wire === 'rejected')) {
      throw Error(`upstream lists tag ${tag} as unsupported, but no declared variant carries it`);
    }
  }
  instructions.sort((a, b) => a.tag - b.tag);

  return {
    program: spec.program,
    label: spec.label,
    scheme: 'legacy-rust',
    source: {
      repo: spec.vendor.repo,
      pin: spec.vendor.pin,
      files: [
        { path: spec.vendor.instructionFile, sha256: instructionSha256 },
        { path: spec.vendor.stateFile, sha256: stateSha256 },
      ],
      vendoredAt: `vendor/${spec.vendor.dir}/${spec.vendor.pin}`,
      derivation: "src/raydium-interface.mjs: tag = the literal integer upstream's pack() arm pushes, cross-checked against the unpack() arm that binds it; args = the pack() arm's byte-write sequence, cross-checked against unpack()'s reads by count and width; optional groups carry upstream's own rest.len() >= N threshold; branches carry upstream's own discriminator values (AmmParams enum text or numeric literal)",
    },
    runtime: spec.runtime,
    selector: { width: 1, encoding: 'u8 enum tag (explicit, sparse — upstream declares 19 variants, 12 are reachable)' },
    argEncoding: "u8/u16/u32/u64 LE; pubkey 32 raw bytes; optional groups are PRESENT only when upstream's rest.len() >= N threshold holds (no C-style option tag); amm_fees = upstream's packed Fees struct (8 x u64 LE)",
    ammFees: { len: fees.len, fields: fees.fields.map((field) => ({ ...field })) },
    instructions,
  };
}

/** The byte width of one pinned arg type. */
function widthOf(type, fees) {
  if (type === 'pubkey') return 32;
  if (type === 'amm_fees') return fees.len;
  if (type in INT_WIDTH) return INT_WIDTH[type];
  throw Error(`unpinned type ${type}`);
}

/** Build one instruction entry from the upstream pack()/unpack() pair. */
function buildInstruction({ variant, tag, unpackBody, packBody, structs, ammParams, fees }) {
  const { body: packArmBody, destructure } = parsePackArm(packBody, variant.name);
  const structMatch = destructure.match(/Self::[A-Za-z0-9_]+\(\s*([A-Za-z0-9_]+)/);
  const structName = structMatch ? structMatch[1] : null;

  const recipe = parsePackRecipe(packArmBody);
  const first = recipe[0];
  const tagWrite = parseWrite(first.expr);
  if (tagWrite.kind !== 'literal' || tagWrite.value !== tag) {
    throw Error(`${variant.name}: pack() arm does not open with tag ${tag}`);
  }

  const fields = (name) => {
    if (!structName) throw Error(`${variant.name}: no struct to read the field type from`);
    const type = fieldType(structs, structName, name);
    if (type === 'Pubkey') return 'pubkey';
    if (type in INT_WIDTH) return type;
    if (type === 'Fees') return 'amm_fees';
    throw Error(`${structName}.${name} has unpinned type ${type}`);
  };

  const guards = parseLengthGuards(unpackBody);
  const guardFor = (count) => {
    for (const guard of guards) {
      const reads = parseReads(guard.body);
      if (reads.length !== count) continue;
      if (!/^\d+$/.test(guard.threshold)) throw Error(`${variant.name}: unpinned length threshold ${guard.threshold}`);
      return { threshold: Number(guard.threshold), reads };
    }
    throw Error(`${variant.name}: an optional group of ${count} field(s) has no matching rest.len() >= N guard upstream`);
  };

  const base = [];
  let optional = null;
  const branches = [];
  for (const node of recipe.slice(1)) {
    if (node.kind === 'write') {
      const write = parseWrite(node.expr);
      base.push({ name: write.name, type: pinnedType(write, fields, variant) });
      continue;
    }
    if (node.kind === 'optional') {
      const writes = parsePackRecipe(node.body).filter((child) => child.kind === 'write').map((child) => parseWrite(child.expr));
      const guard = guardFor(writes.length);
      const args = writes.map((write) => ({ name: write.name, type: pinnedType(write, fields, variant) }));
      // The guard's reads and the optional group's writes must agree in width.
      for (let index = 0; index < args.length; index++) {
        const readWidth = readWidthOf(guard.reads[index]);
        const writeWidth = widthOf(args[index].type, fees);
        if (readWidth !== writeWidth) {
          throw Error(`${variant.name}: optional field ${args[index].name} is ${writeWidth} byte(s) wide, upstream reads ${readWidth}`);
        }
      }
      optional = { presentWhenRemainingAtLeast: guard.threshold, args };
      continue;
    }
    // A branch over a discriminator byte: the unpack() side names the values.
    const match = parseMatchArms(unpackBody);
    if (!match) throw Error(`${variant.name}: pack() branches but unpack() does not`);
    const packArms = parseArmsAtTopLevel(node.body);
    if (!packArms.length) throw Error(`${variant.name}: pack() branch has no match arms`);
    const values = branchValues(match, ammParams);
    if (packArms.length !== values.length) {
      throw Error(`${variant.name}: pack() has ${packArms.length} branch arms, unpack() names ${values.length}`);
    }
    for (let index = 0; index < values.length; index++) {
      const writes = parsePackRecipe(packArms[index].body)
        .filter((child) => child.kind === 'write')
        .map((child) => parseWrite(child.expr));
      const reads = parseReads(match.arms[index].body);
      if (writes.length !== reads.length) {
        throw Error(`${variant.name}: branch ${match.arms[index].header} writes ${writes.length} field(s), unpack() reads ${reads.length}`);
      }
      for (let slot = 0; slot < writes.length; slot++) {
        const writeWidth = widthOf(pinnedType(writes[slot], fields, variant), fees);
        const readWidth = readWidthOf(reads[slot]);
        if (writeWidth !== readWidth) {
          throw Error(`${variant.name}: branch field ${writes[slot].name} is ${writeWidth} byte(s) wide, upstream reads ${readWidth}`);
        }
      }
      if (values[index] === null) {
        // A wildcard branch: upstream refuses these values (it returns an
        // error instead of writing bytes). Named, never decoded.
        branches.push({
          on: 'param',
          values: null,
          wire: 'rejected',
          reason: 'upstream refuses this discriminator value',
          args: [],
        });
        continue;
      }
      branches.push({
        on: 'param',
        values: values[index],
        args: writes.map((write) => ({ name: write.name, type: pinnedType(write, fields, variant) })),
      });
    }
  }

  // The unpack() reads OUTSIDE the length guards and OUTSIDE the branches
  // must be covered by the pack() base writes: no read may be unexplained.
  const unpackMatch = parseMatchArms(unpackBody);
  const sequential = parseReads(withoutGuards(unpackBody, guards));
  const branchNames = new Set();
  if (unpackMatch) {
    for (const arm of unpackMatch.arms) for (const read of parseReads(arm.body)) branchNames.add(read.name);
  }
  const baseReads = sequential.filter((read) => !branchNames.has(read.name));
  const known = base.length;
  if (baseReads.length !== known) {
    throw Error(`${variant.name}: unpack() reads ${baseReads.length} field(s) outside the optional/branched groups, pack() writes ${known}`);
  }
  for (let index = 0; index < baseReads.length; index++) {
    const readWidth = readWidthOf(baseReads[index]);
    const writeWidth = widthOf(base[index].type, fees);
    if (readWidth !== writeWidth) {
      throw Error(`${variant.name}: field ${base[index].name} is ${writeWidth} byte(s) wide, upstream reads ${readWidth}`);
    }
  }

  return {
    tag,
    name: variant.name,
    wire: 'accepted',
    args: base,
    ...(optional ? { optional } : {}),
    ...(branches.length ? { branches } : {}),
  };
}

/** The byte width of one unpack() read. */
function readWidthOf(read) {
  if (read.kind === 'le_int') return read.width / 8;
  if (read.kind === 'pubkey') return read.width;
  if (read.kind === 'fees') return 64;
  throw Error(`unpinned read kind ${read.kind}`);
}

/** The pinned type of one write, from the upstream struct declaration. */
function pinnedType(write, fields, variant) {
  if (write.kind === 'u8') return fields(write.name);
  if (write.kind === 'le_int') {
    const type = fields(write.name);
    if (!(type in INT_WIDTH)) throw Error(`${variant.name}.${write.name}: unpinned integer type ${type}`);
    return type;
  }
  if (write.kind === 'pubkey') return 'pubkey';
  if (write.kind === 'raw') {
    // The only raw write upstream performs is the packed Fees struct, whose
    // bytes come from the upstream state module's own field order.
    if (write.name !== 'fees_slice') throw Error(`${variant.name}: raw write ${write.name} is not covered by a pinned rule`);
    return 'amm_fees';
  }
  throw Error(`${variant.name}: write kind ${write.kind} is not covered by a pinned rule`);
}

/** The declared width of a field, from the upstream struct declaration. */
function fieldType(structs, structName, fieldName) {
  const fields = structs.get(structName);
  if (!fields) throw Error(`struct ${structName} not found upstream`);
  const field = fields.find((entry) => entry.name === fieldName);
  if (!field) throw Error(`${structName}: field ${fieldName} is not declared upstream`);
  return field.type.replace(/^Option<(.*)>$/, '$1');
}

/** The discriminator values of each `unpack()` branch, in arm order. */
function branchValues(match, ammParams) {
  const claimed = [];
  const out = [];
  const usesAmmParams = match.arms.some((arm) => /AmmParams::/.test(arm.header));
  for (const arm of match.arms) {
    if (arm.header === '_') {
      out.push(null);
      continue;
    }
    const parts = arm.header.split('|').map((part) => part.trim());
    const values = [];
    for (const part of parts) {
      const name = part.replace(/^AmmParams::/, '');
      if (/^\d+$/.test(name)) values.push(Number(name));
      else if (ammParams.has(name)) values.push(ammParams.get(name));
      else throw Error(`branch pattern ${part} is not a number and not an upstream AmmParams variant`);
    }
    claimed.push(...values);
    out.push(values.sort((a, b) => a - b));
  }
  if (!usesAmmParams) return out;
  // With AmmParams as the subject, a wildcard arm takes every value no other
  // arm claims — upstream's own enum text is the value set.
  const all = [...ammParams.values()].sort((a, b) => a - b);
  const wildcard = all.filter((value) => !claimed.includes(value));
  return out.map((values) => (values === null ? wildcard : values));
}

/** The pinned Raydium AMM v4 spec. */
export const RAYDIUM_SPECS = [
  {
    program: RAYDIUM_AMM_V4,
    label: 'Raydium AMM v4',
    vendor: RAYDIUM_PINS.ammV4,
    runtime: 'raydium-io/raydium-amm at this pin: unpack() binds an explicit sparse u8 tag and reads with unpack_u8/unpack_u64; an unknown tag is InvalidInstructionData; the variants upstream marks unsupported panic (unimplemented!())',
  },
];

/** Derive every pinned Raydium interface. */
export function deriveAllRaydiumInterfaces(options) {
  return RAYDIUM_SPECS.map((spec) => deriveRaydiumInterface(spec, options));
}

/** sha256 of the vendored upstream instruction file, as `sha256:<hex>`. */
export function vendoredRaydiumHash(spec, { root = REPO_ROOT } = {}) {
  const raw = readFileSync(path.join(root, 'vendor', spec.vendor.dir, spec.vendor.pin, spec.vendor.instructionFile));
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}
