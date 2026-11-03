// Derive the SPL Token-Metadata wire table from the VENDORED UPSTREAM RUST.
//
// Same contract as src/token-interface.mjs, but for the OTHER crate that
// Token-2022's processor falls back to: `spl-token-metadata-interface`. That
// crate is NOT a token instruction enum — it is a set of Borsh-serialized
// structs behind EIGHT-BYTE discriminators, so the whole derivation rests on
// rules the token table does not have.
//
// Why this file exists (measured, not assumed):
//   Token-2022's processor (program/src/processor.rs at the pinned revision)
//   tries the 1-byte PodTokenInstruction selector first and, when that
//   fails, falls through to `TokenMetadataInstruction::unpack(input)`. A
//   metadata instruction therefore carries an 8-byte discriminator and
//   NEVER matches the token table's 1-byte tags. sememe's token decoder
//   refused those payloads as `unknown-selector` — a true statement about
//   the token table, and a FALSE statement about the program.
//
// The rules, each one upstream's own text:
//   - the discriminator is the first 8 bytes of sha256("<namespace>:<suffix>"),
//     where the namespace and the suffix are the strings upstream itself
//     writes in `#[discriminator_hash_input("...")]` (the derive macro hashes
//     the literal; spl-discriminator 0.5.2's `new_with_hash_input` is
//     sha256 -> first 8 bytes),
//   - the ARG SEQUENCE is the field order of the Borsh-serialized struct, so
//     it must be READ from the struct declaration — not from a hand-typed
//     list, and not from the declaration index,
//   - `borsh_string` is u32 LE length + the bytes (borsh 1.8.1's `String`
//     serializes as its bytes, and `str`/`[T]` as a u32 LE length first),
//   - `borsh_enum` is a 1-byte variant tag followed by that variant's
//     payload (`Field` is a 4-variant Borsh enum; only `Key` carries a
//     nested string),
//   - `borsh_option` is 1 tag byte (0 none / 1 some) + the payload —
//     borsh's OWN Option encoding, NOT the C-style option the token
//     instructions use,
//   - `maybe_null_address` is the TRANSPARENT inner value with NO option
//     tag: 32 raw bytes, where the all-zero address means `None`
//     (solana-nullable's `MaybeNull<Address>` is `#[repr(transparent)]`
//     and `Nullable::NONE` for `Address` is the zero address),
//   - `borsh_bool` is one byte, 0 or 1 (borsh writes `u8::from(bool)`).
//
// Strictness mirrors the token table: every struct field must be covered by
// exactly one pinned rule, every variant upstream declares must be named,
// and a variant whose wire shape this module cannot pin refuses to enter
// the table instead of being guessed.
//
// The upstream behaviour this table must MIRROR is exactness: upstream's
// `unpack` calls `try_from_slice`, which REFUSES trailing bytes. A table
// that decoded a trailing byte would name bytes the program itself rejects,
// so trailing bytes are a refusal here too (see `strict` in the artifact).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/**
 * The vendored `spl-token-metadata-interface` crate.
 *
 * The directory name is the crate's UPSTREAM GIT SHA (the sha1 in the
 * crates.io tarball's `.cargo_vcs_info.json`), and the four source files are
 * byte-identical to crates.io `spl-token-metadata-interface` 1.0.1 — the
 * version Token-2022's own Cargo.lock pins.
 */
export const TOKEN_METADATA_PIN = {
  repo: 'solana-program/token-2022',
  crate: 'spl-token-metadata-interface',
  version: '1.0.1',
  dir: 'spl-token-metadata-interface',
  pin: '7038969ec74a89f1afdb9bc97c112d4d26fead9a',
  instructionFile: 'interface/src/instruction.rs',
  stateFile: 'interface/src/state.rs',
};

/** The namespace upstream declares in its own lib.rs. */
export const TOKEN_METADATA_NAMESPACE = 'spl_token_metadata_interface';

/** sha256 of `text`, hex, first `bytes` bytes — spl-discriminator's rule. */
export function discriminatorOf(text, bytes = 8) {
  return createHash('sha256').update(text).digest('hex').slice(0, bytes * 2);
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

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

/**
 * The field declarations of ONE `pub struct` in upstream, in declaration
 * order — the Borsh field order, which is the wire order.
 *
 * Both field forms appear upstream and BOTH must be read: `pub name: String`
 * and (for the enums) a tuple variant with a nested payload.
 */
export function parseStructFields(src, structName) {
  const at = src.indexOf(`pub struct ${structName} {`);
  if (at < 0) throw Error(`struct ${structName} not found upstream`);
  const open = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = src.slice(open + 1, end);
  // Upstream annotates fields with multi-line `#[cfg_attr(...)]` blocks
  // (serde-traits) — they are not field declarations and must go before the
  // split, exactly as src/token-interface.mjs does for TokenInstruction.
  const cleaned = body.replace(/#\[[\s\S]*?\]\s*/g, '');
  const fields = [];
  for (const part of cleaned.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^pub\s+([a-z_][a-z0-9_]*)\s*:\s*(.+)$/);
    if (!m) throw Error(`${structName}: unreadable field declaration "${trimmed}"`);
    fields.push({ name: m[1], type: m[2].trim() });
  }
  if (!fields.length) throw Error(`${structName}: no fields parsed`);
  return fields;
}

/**
 * The `#[discriminator_hash_input("...")]` literal of one struct, and the
 * struct's own declaration.
 */
function parseHashInput(src, structName) {
  const at = src.indexOf(`pub struct ${structName} {`);
  if (at < 0) throw Error(`struct ${structName} not found upstream`);
  // The attribute sits above the struct; look backwards for it.
  const before = src.slice(Math.max(0, at - 600), at);
  const m = [...before.matchAll(/#\[discriminator_hash_input\("([^"]+)"\)\]/g)].pop();
  if (!m) throw Error(`${structName}: no discriminator_hash_input attribute upstream`);
  return m[1];
}

/**
 * The `Field` enum upstream declares, as variant name -> payload type.
 *
 * `Field` is a Borsh enum: the wire tag is the DECLARATION INDEX (a Borsh
 * enum's variant index is its discriminant), and only `Key` carries a
 * payload — a nested Borsh string.
 */
export function parseFieldEnum(src) {
  const at = src.indexOf('pub enum Field {');
  if (at < 0) throw Error('Field enum not found upstream');
  const open = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = src.slice(open + 1, end);
  const variants = [];
  let i = 0;
  const IDENT = /[A-Za-z0-9_]/;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    const start = i;
    while (i < body.length && IDENT.test(body[i])) i++;
    const name = body.slice(start, i);
    if (!/^[A-Z]/.test(name)) throw Error(`Field: unexpected token "${name || body[i]}"`);
    while (i < body.length && /\s/.test(body[i])) i++;
    let payload = null;
    if (body[i] === '(') {
      const open2 = i;
      let d = 0;
      for (; i < body.length; i++) {
        if (body[i] === '(') d++;
        else if (body[i] === ')') { d--; if (d === 0) { i++; break; } }
      }
      payload = body.slice(open2 + 1, i - 1).trim();
    }
    variants.push({ name, payload });
  }
  if (!variants.length) throw Error('Field yielded no variants');
  return variants;
}

/**
 * The wire type of one upstream field, by a pinned rule.
 *
 * Every upstream field must map to exactly one wire type, and every wire
 * type must be justified by upstream's own declaration — a field this
 * function cannot classify throws, so an upstream change fails loudly
 * instead of decoding as garbage.
 */
function wireTypeOf(field, variant) {
  const { name, type } = field;
  if (type === 'String') return { type: 'borsh_string' };
  if (type === 'bool') return { type: 'borsh_bool' };
  if (type === 'Field') return { type: 'borsh_enum', enum: 'Field' };
  if (type === 'MaybeNull<Address>') return { type: 'maybe_null_address' };
  if (type === 'Option<u64>') return { type: 'borsh_option_u64' };
  throw Error(`${variant}.${name}: upstream field type ${type} has no pinned wire rule`);
}

/** The wire type of the `Field` enum's own payload, by a pinned rule. */
function fieldPayloadType(payload) {
  if (payload === null) return null;
  if (payload === 'String') return 'borsh_string';
  throw Error(`Field: payload type ${payload} has no pinned wire rule`);
}

/**
 * Derive the token-metadata interface document from the vendored source.
 *
 * Every variant is checked in BOTH directions against upstream:
 *   - every variant this table names must exist upstream, with the fields
 *     the table claims, in the order the table claims;
 *   - every struct upstream declares with a `discriminator_hash_input`
 *     attribute must be named by this table.
 * An upstream addition nobody re-reviewed therefore fails here rather than
 * decoding as "unknown".
 */
export function deriveTokenMetadataInterface(spec = TOKEN_METADATA_PIN, { root = REPO_ROOT } = {}) {
  const base = path.join(root, 'vendor', spec.dir, spec.pin);
  const instructionPath = path.join(base, spec.instructionFile);
  const statePath = path.join(base, spec.stateFile);
  const rawInstruction = readFileSync(instructionPath);
  const rawState = readFileSync(statePath);
  const fileSha256 = `sha256:${createHash('sha256').update(rawInstruction).digest('hex')}`;
  const stateSha256 = `sha256:${createHash('sha256').update(rawState).digest('hex')}`;

  const instructionSrc = stripComments(rawInstruction.toString('utf8'));
  const stateSrc = stripComments(rawState.toString('utf8'));

  // The namespace upstream declares in its own lib.rs — not a literal here.
  const libPath = path.join(base, 'interface', 'src', 'lib.rs');
  const libSrc = stripComments(readFileSync(libPath, 'utf8'));
  const nsMatch = libSrc.match(/pub\s+const\s+NAMESPACE\s*:\s*&str\s*=\s*"([^"]+)"/);
  if (!nsMatch) throw Error('NAMESPACE not found in the vendored lib.rs');
  if (nsMatch[1] !== TOKEN_METADATA_NAMESPACE) {
    throw Error(`vendored NAMESPACE is ${nsMatch[1]}, expected ${TOKEN_METADATA_NAMESPACE}`);
  }

  // The discriminator rule is anchored by upstream's OWN literal: the
  // TokenMetadata account's discriminator is hardcoded in state.rs and
  // upstream's own test derives it from sha256("<NAMESPACE>:token_metadata").
  // If our sha256 does not reproduce that literal, the rule is wrong and
  // every discriminator would be wrong — so this check must fail loudly.
  const anchorMatch = stateSrc.match(/ArrayDiscriminator::new\(\[([0-9,\s]+)\]\)/);
  if (!anchorMatch) throw Error('the hardcoded TokenMetadata discriminator literal not found in state.rs');
  const anchorBytes = anchorMatch[1].split(',').map((n) => Number(n.trim()));
  const anchorHex = anchorBytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  const computedAnchor = discriminatorOf(`${TOKEN_METADATA_NAMESPACE}:token_metadata`);
  if (computedAnchor !== anchorHex) {
    throw Error(
      `the sha256 discriminator rule does not reproduce upstream's own literal: ` +
      `computed ${computedAnchor}, upstream ${anchorHex}`,
    );
  }

  // The `Field` enum, from the vendored state.rs.
  const fieldVariants = parseFieldEnum(stateSrc);
  const fieldTable = fieldVariants.map((variant, index) => ({
    tag: index,
    name: variant.name,
    payload: fieldPayloadType(variant.payload),
  }));

  // The struct variants upstream declares with a discriminator attribute.
  const declaredStructs = [...instructionSrc.matchAll(/pub\s+struct\s+([A-Z][A-Za-z0-9_]*)\s*\{/g)]
    .map((m) => m[1]);
  const withDiscriminator = declaredStructs.filter((name) => {
    const at = instructionSrc.indexOf(`pub struct ${name} {`);
    const before = instructionSrc.slice(Math.max(0, at - 600), at);
    return /#\[discriminator_hash_input\("([^"]+)"\)\]/.test(before);
  });
  if (!withDiscriminator.length) throw Error('no struct with a discriminator attribute found upstream');

  // The enum variant names upstream names, so the table's names are
  // upstream's names and not this module's invention.
  const enumBody = fnBody(instructionSrc, 'pub enum TokenMetadataInstruction');
  const enumVariants = [...enumBody.matchAll(/([A-Z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);

  const instructions = withDiscriminator.map((structName) => {
    // The variant name in the enum is the struct name without the action
    // suffix upstream uses (`Initialize` / `UpdateField` / ...). Upstream's
    // enum arm binds the same struct, so read the mapping from upstream.
    const armMatch = enumBody.match(new RegExp(`([A-Z][A-Za-z0-9_]*)\\(\\s*${structName}\\b`));
    if (!armMatch) throw Error(`TokenMetadataInstruction has no arm for ${structName}`);
    const variantName = armMatch[1];

    const hashInput = parseHashInput(instructionSrc, structName);
    if (!hashInput.startsWith(`${TOKEN_METADATA_NAMESPACE}:`)) {
      throw Error(`${structName}: hash input "${hashInput}" is not in the ${TOKEN_METADATA_NAMESPACE} namespace`);
    }
    const discriminator = discriminatorOf(hashInput);

    const fields = parseStructFields(instructionSrc, structName);
    const args = fields.map((field) => ({ name: field.name, ...wireTypeOf(field, variantName) }));

    return {
      name: variantName,
      struct: structName,
      discriminator,
      hashInput,
      args,
    };
  });

  // Every variant upstream's enum declares must be named by this table.
  const named = new Set(instructions.map((ix) => ix.name));
  for (const variant of enumVariants) {
    if (!named.has(variant)) throw Error(`upstream declares ${variant}, this table does not name it`);
  }
  for (const ix of instructions) {
    if (!enumVariants.includes(ix.name)) throw Error(`table names ${ix.name}, upstream does not declare it`);
  }
  // No two variants may share a discriminator.
  const seen = new Map();
  for (const ix of instructions) {
    if (seen.has(ix.discriminator)) {
      throw Error(`discriminator ${ix.discriminator} is claimed by both ${seen.get(ix.discriminator)} and ${ix.name}`);
    }
    seen.set(ix.discriminator, ix.name);
  }

  return {
    program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    label: 'SPL Token Metadata (Token-2022 fallback)',
    scheme: 'native-token-metadata',
    source: {
      repo: spec.repo,
      crate: spec.crate,
      version: spec.version,
      pin: spec.pin,
      file: spec.instructionFile,
      stateFile: spec.stateFile,
      fileSha256,
      stateFileSha256: stateSha256,
      vendoredAt: `vendor/${spec.dir}/${spec.pin}`,
      derivation: 'src/token-metadata-interface.mjs: discriminator = sha256(upstream\'s own #[discriminator_hash_input])[..8], anchored by upstream\'s hardcoded TokenMetadata literal; args = the Borsh field order of the struct declaration; string = u32 LE length + bytes; enum = 1-byte variant index; option = 1 tag byte + payload; MaybeNull<Address> = transparent 32 raw bytes, all-zero = None',
    },
    runtime: 'Token-2022 processor at this pin: the 1-byte PodTokenInstruction selector is tried first, then TokenMetadataInstruction::unpack(input) is tried; upstream\'s unpack uses try_from_slice, so TRAILING BYTES ARE REFUSED; an unknown 8-byte discriminator is InvalidInstruction',
    selector: { width: 8, encoding: 'sha256(namespace:action)[..8]' },
    argEncoding: 'borsh string = u32 LE length + bytes; borsh enum = 1-byte variant index; borsh option = 1 tag byte (0 none / 1 some) + payload; bool = 1 byte; MaybeNull<Address> = 32 raw bytes, all-zero = None',
    strict: {
      trailingBytes: 'refuse',
      reason: 'upstream unpack() calls try_from_slice, which refuses a payload with unexplained trailing bytes (verified against the upstream crate: a trailing byte is a BorshIoError)',
    },
    fieldEnum: fieldTable,
    instructions,
  };
}

/** Derive the token-metadata interface (the single pinned crate). */
export function deriveTokenMetadataInterfaces(options) {
  return [deriveTokenMetadataInterface(TOKEN_METADATA_PIN, options)];
}
