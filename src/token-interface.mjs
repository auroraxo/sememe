// Derive the SPL Token wire table from the VENDORED UPSTREAM RUST.
//
// Same contract as src/native-interface.mjs, one level up in complexity: the
// token family has NO IDL account to pull (measured 2026-11-02 at both
// pullable addresses), yet it carries 43% of real watched mainnet traffic.
// The upstream Rust interface crates ARE the interface, and their wire rule
// lives in hand-written pack()/unpack() pairs rather than in a Borsh enum — so
// this module derives each variant's wire shape from the upstream TEXT and
// throws on anything it cannot pin.
//
// Why derive instead of transcribe: the System/ComputeBudget table was once
// hand-typed, and the transcription carried a defect (a u32 string header
// where the chain carries u64) that survived review and named 0 of 63 live
// payloads. The fix that held was removing the transcription step. The same
// applies here at higher risk: nearly fifty variants, and one wrong field
// order silently mislabels money movement.
//
// The rules, each one upstream's own text:
//   - the wire tag is the integer upstream WRITES in pack() and MATCHES in
//     unpack() — NOT the declaration index: TokenInstruction uses explicit
//     tags, so WithdrawExcessLamports is 38, UnwrapLamports 45, Batch 255,
//   - the arg sequence is the sequence of byte writes in the pack arm,
//   - `u8`/`u16`/`u64` are fixed-width LE, `pubkey` is 32 raw bytes,
//     `coption_pubkey`/`coption_u64` are the C-style option upstream's own
//     pack_pubkey_option/pack_u64_option writes (1 tag byte + payload, NOT
//     a bincode option wrapper),
//   - `authority_type` is the upstream AuthorityType enum byte, whose variant
//     list is derived from the same vendored file,
//   - `utf8_rest` is the whole remaining payload as utf8 (upstream's
//     UiAmountToAmount writes the string with NO length prefix),
//   - `u16_vec` is a run of 2-byte extension-type ids,
//   - `bytes` is the raw remainder (Batch),
//   - a variant must appear in BOTH the pack and the unpack arm sets before
//     it can enter the table, and the set of variants upstream DECLARES must
//     equal the set this table names — an upstream addition that nobody
//     re-reviewed fails loudly instead of decoding as "unknown".
//
// Dependency-free on purpose: it is imported by the decode path.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const TOKEN_PINS = {
  splToken: {
    repo: 'solana-program/token',
    dir: 'spl-token',
    pin: '737788ff5bcc3f1f44cfb222f25483187650be76',
    file: 'interface/src/instruction.rs',
  },
  splToken2022: {
    repo: 'solana-program/token-2022',
    dir: 'spl-token-2022',
    pin: '5251dcc07ecbcb721d6c4f0231090defadf00311',
    file: 'interface/src/instruction.rs',
  },
};

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

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
 * The variant declarations of `pub enum TokenInstruction`: name -> declared
 * field names, in declaration order.
 *
 * Both field forms appear upstream and BOTH must be read: `decimals: u8`
 * (annotated) and `owner` (shorthand, which is what InitializeAccount2 uses).
 * A parser that only understood the annotated form would silently drop the
 * owner pubkey from three of the most frequent instructions.
 */
export function parseTokenVariants(src) {
  // Upstream annotates many fields with multi-line `#[cfg_attr(...)]`
  // attributes; they are not field declarations and must go before the split.
  src = src.replace(/#\[[\s\S]*?\]\s*/g, '');
  const at = src.indexOf('pub enum TokenInstruction');
  if (at < 0) throw Error('TokenInstruction enum not found');
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
  const variants = new Map();
  let i = 0;
  const IDENT = /[A-Za-z0-9_]/;
  const skip = (chars) => { while (i < body.length && chars.includes(body[i])) i++; };
  while (i < body.length) {
    skip(',\n\r\t ');
    if (i >= body.length) break;
    const start = i;
    while (i < body.length && IDENT.test(body[i])) i++;
    const name = body.slice(start, i);
    if (!/^[A-Z]/.test(name)) throw Error(`unexpected token in TokenInstruction body: ${name || body[i]}`);
    skip(' \n\r\t');
    const fields = [];
    if (body[i] === '{') {
      const open2 = i;
      let d = 0;
      for (; i < body.length; i++) {
        if (body[i] === '{') d++;
        else if (body[i] === '}') { d--; if (d === 0) { i++; break; } }
      }
      const inner = body.slice(open2 + 1, i - 1);
      for (const part of inner.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const annotated = trimmed.match(/^([a-z_][a-z0-9_]*)\s*:\s*(?:&'?a?\s*)?(?:\[u8\]|str|[A-Za-z0-9_<>:]+)$/);
        if (annotated) { fields.push(annotated[1]); continue; }
        const shorthand = trimmed.match(/^([a-z_][a-z0-9_]*)$/);
        if (shorthand) { fields.push(shorthand[1]); continue; }
        throw Error(`TokenInstruction::${name}: unreadable field declaration "${trimmed}"`);
      }
    }
    // `UnwrapLamports { .. } = 45` puts the tag after the field block, so
    // whitespace must be skipped again before looking for '='.
    skip(' \n\r\t');
    let explicitTag = null;
    if (body[i] === '=') {
      // `WithdrawExcessLamports = 38` / `UnwrapLamports { .. } = 45` /
      // `Batch = 255` — an explicit tag, consumed with its variant.
      const m = body.slice(i + 1).match(/^\s*(\d+)/);
      if (!m) throw Error(`TokenInstruction::${name}: '=' is not followed by a numeric tag`);
      explicitTag = Number(m[1]);
      i += 1 + m[0].length;
    }
    variants.set(name, { explicitTag, fields });
  }
  if (!variants.size) throw Error('TokenInstruction yielded no variants');
  return variants;
}

/**
 * The wire writes of ONE pack arm, in order, as pinned op records.
 *
 * Every op is matched EXACTLY once; an unrecognized write throws instead of
 * being skipped. That is the whole point of this module: a silent skip here
 * would produce a table that decodes the wrong number of bytes and labels
 * money movement with the wrong amount.
 */
function packArmOps(packBody, tag) {
  const at = packBody.indexOf(`buf.push(${tag})`);
  if (at < 0) throw Error(`pack arm for tag ${tag} not found`);
  const arrowAt = packBody.lastIndexOf('=>', at);
  if (arrowAt < 0) throw Error(`pack arm ${tag}: no match arm`);
  const between = packBody.slice(arrowAt + 2, at);
  if (!between.includes('{')) {
    // A brace-less arm (`Self::Revoke => buf.push(5),`) carries no args.
    return [];
  }
  const armOpen = arrowAt + between.indexOf('{');
  let depth = 0, end = -1;
  for (let i = armOpen; i < packBody.length; i++) {
    if (packBody[i] === '{') depth++;
    else if (packBody[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw Error(`pack arm ${tag}: body never closes`);
  const arm = packBody.slice(armOpen + 1, end);
  const ops = [];
  // The tag write itself is not an arg.
  const rest = arm.slice(arm.indexOf(`buf.push(${tag})`) + `buf.push(${tag})`.length);
  const patterns = [
    // for extension_type in extension_types { buf.extend_from_slice(&<[u8; 2]>::from(*extension_type)); }
    { re: /for\s+([a-z_]+)\s+in\s+([a-z_]+)\s*\{[^}]*buf\.extend_from_slice\(&<\[u8;\s*2\]>::from\(\*([a-z_]+)\)\);[^}]*\}/g,
      op: (m) => ({ kind: 'u16_vec', name: m[2] }) },
    // Self::pack_pubkey_option(x, &mut buf)
    { re: /Self::pack_pubkey_option\(&?([a-z_]+)\s*,\s*&mut buf\)/g,
      op: (m) => ({ kind: 'coption_pubkey', name: m[1] }) },
    // Self::pack_u64_option(x, &mut buf)
    { re: /Self::pack_u64_option\(&?([a-z_]+)\s*,\s*&mut buf\)/g,
      op: (m) => ({ kind: 'coption_u64', name: m[1] }) },
    // buf.extend_from_slice(&amount.to_le_bytes())
    { re: /buf\.extend_from_slice\(&([a-z_]+)\.to_le_bytes\(\)\)/g,
      op: (m) => ({ kind: 'le_int', name: m[1] }) },
    // buf.extend_from_slice(mint_authority.as_ref())
    { re: /buf\.extend_from_slice\(([a-z_]+)\.as_ref\(\)\)/g,
      op: (m) => ({ kind: 'pubkey', name: m[1] }) },
    // buf.extend_from_slice(ui_amount.as_bytes())
    { re: /buf\.extend_from_slice\(([a-z_]+)\.as_bytes\(\)\)/g,
      op: (m) => ({ kind: 'utf8_rest', name: m[1] }) },
    // buf.extend_from_slice(data)
    { re: /buf\.extend_from_slice\(([a-z_]+)\)/g,
      op: (m) => ({ kind: 'bytes', name: m[1] }) },
    // buf.push(authority_type.into())
    { re: /buf\.push\(([a-z_]+)\.into\(\)\)/g,
      op: (m) => ({ kind: 'authority_type', name: m[1] }) },
    // buf.push(decimals) / buf.push(m)
    { re: /buf\.push\(([a-z_]+)\)/g,
      op: (m) => ({ kind: 'u8', name: m[1] }) },
  ];
  for (const { re, op } of patterns) {
    for (const m of rest.matchAll(re)) ops.push({ at: m.index, ...op(m) });
  }
  ops.sort((a, b) => a.at - b.at);
  // Every byte write in the arm must be accounted for by exactly one op.
  const writes = [...rest.matchAll(/buf\.(?:push|extend_from_slice)\(|Self::pack_(?:pubkey|u64)_option\(/g)];
  if (writes.length !== ops.length) {
    throw Error(
      `pack arm ${tag}: ${writes.length} byte write(s) but ${ops.length} pinned op(s) — ` +
      'an upstream write is not covered by a pinned rule; re-review the pin');
  }
  return ops;
}

/** The fixed width of a `le_int` write, from the upstream `.to_le_bytes()` type. */
function leIntWidth(src, name, variant) {
  const re = new RegExp(`${variant}[^}]*?\\b${name}\\s*:\\s*([A-Za-z0-9_]+)`, 's');
  const m = src.match(re);
  if (!m) throw Error(`${variant}: field ${name} is not declared upstream`);
  const type = m[1];
  if (type === 'u8') return 1;
  if (type === 'u16') return 2;
  if (type === 'u64') return 8;
  throw Error(`${variant}: field ${name} has unpinned integer type ${type}`);
}

/** Derive one token program's interface document from its vendored upstream source. */
export function deriveTokenInterface(spec, { root = REPO_ROOT } = {}) {
  const file = path.join(root, 'vendor', spec.vendor.dir, spec.vendor.pin, spec.vendor.file);
  const raw = readFileSync(file);
  const fileSha256 = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const src = stripComments(raw.toString('utf8'));

  const declared = parseTokenVariants(src);
  const packBody = fnBody(src, 'pub fn pack(&self)');
  const unpackBody = src.includes('pub(crate) fn unpack_with_rest')
    ? fnBody(src, 'pub(crate) fn unpack_with_rest')
    : fnBody(src, 'pub fn unpack(input');

  const packTags = [...packBody.matchAll(/buf\.push\((\d+)\)/g)].map((m) => Number(m[1]));
  const unpackTags = [...unpackBody.matchAll(/^\s*((?:\d+\s*\|\s*)*\d+)\s*=>/gm)]
    .flatMap((m) => m[1].split('|').map((t) => Number(t.trim())));

  const packSet = new Set(packTags);
  const unpackSet = new Set(unpackTags);
  for (const tag of spec.expectedTags) {
    if (!packSet.has(tag)) throw Error(`${spec.label}: tag ${tag} is missing from upstream pack()`);
    if (!unpackSet.has(tag)) throw Error(`${spec.label}: tag ${tag} is missing from upstream unpack()`);
  }
  const extraPack = [...packSet].filter((t) => !spec.expectedTags.includes(t));
  const extraUnpack = [...unpackSet].filter((t) => !spec.expectedTags.includes(t));
  if (extraPack.length) throw Error(`${spec.label}: upstream pack() has tag(s) ${extraPack} this table does not name`);
  if (extraUnpack.length) throw Error(`${spec.label}: upstream unpack() has tag(s) ${extraUnpack} this table does not name`);

  const instructions = spec.expectedTags.map((tag) => {
    const meta = spec.variants[tag];
    if (!meta) throw Error(`${spec.label}: tag ${tag} has no declared variant metadata`);
    const variant = typeof meta === 'string' ? meta : meta.variant;
    if (!declared.has(variant)) throw Error(`${spec.label}: variant ${variant} is not declared upstream`);
    const fields = declared.get(variant).fields;
    const ops = packArmOps(packBody, tag);
    const args = [];
    for (const op of ops) {
      if (!fields.includes(op.name)) {
        throw Error(`${spec.label} tag ${tag} (${variant}): wire write "${op.name}" is not a declared field of the variant`);
      }
      let type = op.kind;
      if (op.kind === 'le_int') type = { u8: 'u8', u16: 'u16', u64: 'u64' }[leIntWidth(src, op.name, variant)] ?? 'u64';
      args.push({ name: op.name, type });
    }
    const names = args.map((a) => a.name);
    if (new Set(names).size !== names.length) throw Error(`${spec.label} tag ${tag}: duplicate arg names ${names}`);
    return { tag, name: variant, wire: 'accepted', args };
  });

  // Every variant upstream declares must be in the table. An upstream
  // addition nobody re-reviewed must fail here, not decode as "unknown".
  const named = new Set(instructions.map((ix) => ix.name));
  for (const variant of declared.keys()) {
    if (!named.has(variant)) throw Error(`${spec.label}: upstream declares ${variant}, this table does not name it`);
  }
  for (const ix of instructions) {
    if (!declared.has(ix.name)) throw Error(`${spec.label}: table names ${ix.name}, upstream does not declare it`);
  }

  return {
    program: spec.program,
    label: spec.label,
    scheme: 'native-token',
    source: {
      repo: spec.vendor.repo,
      pin: spec.vendor.pin,
      file: spec.vendor.file,
      enum: 'TokenInstruction (explicit tags, not declaration order)',
      fileSha256,
      vendoredAt: `vendor/${spec.vendor.dir}/${spec.vendor.pin}`,
      derivation: "src/token-interface.mjs: tag = the integer upstream pack() writes and unpack() matches; args = the pack arm's byte-write sequence; option encoding = upstream pack_pubkey_option/pack_u64_option (1 tag byte + payload)",
    },
    runtime: spec.runtime,
    selector: { width: 1, encoding: 'u8 enum tag (explicit, sparse)' },
    argEncoding: 'u8/u16/u64 LE; pubkey 32 raw bytes; COption = 1 tag byte (0 none / 1 some) + payload; utf8_rest = whole remainder; u16_vec = run of 2-byte extension-type ids; bytes = raw remainder',
    authorityType: deriveAuthorityTypes(spec, { root }),
    instructions,
  };
}

/** The AuthorityType enum byte rule, derived from the vendored source. */
export function deriveAuthorityTypes(spec, { root = REPO_ROOT } = {}) {
  const file = path.join(root, 'vendor', spec.vendor.dir, spec.vendor.pin, spec.vendor.file);
  const src = stripComments(readFileSync(file, 'utf8'));
  const fromBody = fnBody(src, 'fn from(index: u8)');
  const pairs = [...fromBody.matchAll(/(\d+)\s*=>\s*Ok\(AuthorityType::([A-Za-z0-9_]+)\)/g)]
    .map((m) => [Number(m[1]), m[2]]);
  if (pairs.length !== spec.authorityType.count) {
    throw Error(`${spec.label}: AuthorityType derived ${pairs.length} variants, expected ${spec.authorityType.count}`);
  }
  return pairs.map(([byte, name]) => ({ byte, name }));
}

/** The two pinned token specs. The tag -> variant map is the opinion layer; the
 * derivation checks it against upstream's own declaration list in both
 * directions, so an upstream change fails loudly instead of silently. */
export const TOKEN_SPECS = [
  {
    program: SPL_TOKEN_PROGRAM,
    label: 'SPL Token',
    vendor: TOKEN_PINS.splToken,
    runtime: 'solana-program/token program at this pin: unpack matches the same explicit tag set; an unknown tag is InvalidInstruction',
    expectedTags: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 38, 45, 255],
    variants: {
      0: 'InitializeMint', 1: 'InitializeAccount', 2: 'InitializeMultisig', 3: 'Transfer',
      4: 'Approve', 5: 'Revoke', 6: 'SetAuthority', 7: 'MintTo', 8: 'Burn', 9: 'CloseAccount',
      10: 'FreezeAccount', 11: 'ThawAccount', 12: 'TransferChecked', 13: 'ApproveChecked',
      14: 'MintToChecked', 15: 'BurnChecked', 16: 'InitializeAccount2', 17: 'SyncNative',
      18: 'InitializeAccount3', 19: 'InitializeMultisig2', 20: 'InitializeMint2',
      21: 'GetAccountDataSize', 22: 'InitializeImmutableOwner', 23: 'AmountToUiAmount',
      24: 'UiAmountToAmount', 38: 'WithdrawExcessLamports', 45: 'UnwrapLamports', 255: 'Batch',
    },
    authorityType: { count: 4 },
  },
  {
    program: SPL_TOKEN_2022_PROGRAM,
    label: 'Token-2022',
    vendor: TOKEN_PINS.splToken2022,
    runtime: 'solana-program/token-2022 program at this pin: the pod_instruction unpack matches the same explicit tag set; an unknown tag is InvalidInstruction; tags 26/27/28/30/33/34/36/37/39/40/41/42/43/44/46 dispatch into extension processors on input[1..]; 255 (Batch) is refused by the processor',
    expectedTags: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 255],
    variants: {
      0: 'InitializeMint', 1: 'InitializeAccount', 2: 'InitializeMultisig', 3: 'Transfer',
      4: 'Approve', 5: 'Revoke', 6: 'SetAuthority', 7: 'MintTo', 8: 'Burn', 9: 'CloseAccount',
      10: 'FreezeAccount', 11: 'ThawAccount', 12: 'TransferChecked', 13: 'ApproveChecked',
      14: 'MintToChecked', 15: 'BurnChecked', 16: 'InitializeAccount2', 17: 'SyncNative',
      18: 'InitializeAccount3', 19: 'InitializeMultisig2', 20: 'InitializeMint2',
      21: 'GetAccountDataSize', 22: 'InitializeImmutableOwner', 23: 'AmountToUiAmount',
      24: 'UiAmountToAmount', 25: 'InitializeMintCloseAuthority', 26: 'TransferFeeExtension',
      27: 'ConfidentialTransferExtension', 28: 'DefaultAccountStateExtension', 29: 'Reallocate',
      30: 'MemoTransferExtension', 31: 'CreateNativeMint', 32: 'InitializeNonTransferableMint',
      33: 'InterestBearingMintExtension', 34: 'CpiGuardExtension', 35: 'InitializePermanentDelegate',
      36: 'TransferHookExtension', 37: 'ConfidentialTransferFeeExtension', 38: 'WithdrawExcessLamports',
      39: 'MetadataPointerExtension', 40: 'GroupPointerExtension', 41: 'GroupMemberPointerExtension',
      42: 'ConfidentialMintBurnExtension', 43: 'ScaledUiAmountExtension', 44: 'PausableExtension',
      45: 'UnwrapLamports', 46: 'PermissionedBurnExtension', 255: 'Batch',
    },
    authorityType: { count: 18 },
  },
];

/** Derive both pinned token interfaces. */
export function deriveAllTokenInterfaces(options) {
  return TOKEN_SPECS.map((spec) => deriveTokenInterface(spec, options));
}

/** sha256 of a vendored upstream file, as `sha256:<hex>`. */
export function vendoredTokenHash(spec, { root = REPO_ROOT } = {}) {
  const raw = readFileSync(path.join(root, 'vendor', spec.vendor.dir, spec.vendor.pin, spec.vendor.file));
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}
