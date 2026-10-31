// Derive a native program's instruction table from the VENDORED UPSTREAM RUST.
//
// Shared by two callers, deliberately:
//   - `tools/native-interface.mjs` writes the derived table into `interface/native-<program>.json`
//     (the reviewable, committable record of what upstream says),
//   - `src/native.mjs` derives the SAME table at load time and refuses to decode if the
//     vendored bytes do not hash to what the committed artifact claims.
//
// Why derive instead of transcribe: `src/native.mjs` was the one table in this repository
// whose rows were typed in by hand, and the first consumer's hand copy carried a defect
// (a u32 string-length header where the chain carries a u64) that survived exactly the
// kind of review a transcription gets — measured on real traffic: 0 of 63 live
// CreateAccountWithSeed payloads could be named. The fix is not a better review; it is
// removing the transcription step.
//
// The rules below are the pinned upstream's own declarations, not sememe's opinions:
//   - the wire selector of a variant is its DECLARATION INDEX,
//   - a struct variant's fields are in WIRE ORDER,
//   - a tuple variant's payload type is its single argument's type,
//   - `Address` is a 32-byte pubkey, `String` is a bincode u64-length-prefixed utf8.
//
// Two things upstream does NOT pin, and which are therefore stated explicitly here
// rather than inferred (both were verified against the pinned SDK and the chain):
//   - the ARGUMENT NAMES of tuple variants, which the enum leaves anonymous; they come
//     from the pinned SDK constructors (`set_compute_unit_price(micro_lamports)`),
//   - which variants the RUNTIME rejects; ComputeBudget's `Unused` (index 0) is
//     `InvalidInstructionData` on the wire, so it is emitted as wire-rejected.
//
// Anything else unexpected — an unknown arg type, a duplicate name, a variant count that
// does not match, a unit variant nobody declared — throws. A surprise must be loud.
//
// Dependency-free on purpose: this module is imported by the decode core, which must run
// in repositories with no npm packages installed.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const SDK_PIN = 'anza-xyz/solana-sdk@8db406e2edfafa25939ec782b77b5b6f30de164d';
export const VENDOR_DIR = 'vendor/anza-solana-sdk/8db406e2edfafa25939ec782b77b5b6f30de164d';

export const PROGRAMS = [
  {
    program: 'ComputeBudget111111111111111111111111111111',
    label: 'Compute Budget Program',
    file: 'compute-budget-interface/src/lib.rs',
    enumName: 'ComputeBudgetInstruction',
    selector: { width: 1, encoding: 'u8' },
    argEncoding: 'bare little-endian integer, no bincode wrapper (runtime `to_instruction!`: data[0] = tag, then $num.to_le_bytes())',
    runtime: 'anza-xyz/agave compute-budget-instruction: borsh `try_from_slice_unchecked`; an unclaimed tag or the reserved Unused(0) is InvalidInstructionData — the runtime REJECTS tag 0, so the decoder refuses instead of naming it',
    wireRejected: ['Unused'],
    unitVariants: ['Unused'],
    tupleArgNames: {
      RequestHeapFrame: 'bytes',
      SetComputeUnitLimit: 'units',
      SetComputeUnitPrice: 'micro_lamports',
      SetLoadedAccountsDataSizeLimit: 'bytes',
    },
    expectedCount: 5,
  },
  {
    program: '11111111111111111111111111111111',
    label: 'System Program',
    file: 'system-interface/src/instruction.rs',
    enumName: 'SystemInstruction',
    selector: { width: 4, encoding: 'u32 little-endian bincode enum tag' },
    argEncoding: 'bincode fixint: u32/u64 LE, pubkeys as 32 raw bytes, String as u64 length prefix + utf8',
    runtime: 'anza-xyz/agave system-program: accepts variants 0..13 (12 = UpgradeNonceAccount, 13 = CreateAccountAllowPrefund)',
    wireRejected: [],
    unitVariants: ['AdvanceNonceAccount', 'UpgradeNonceAccount'],
    tupleArgNames: {
      WithdrawNonceAccount: 'lamports',
      InitializeNonceAccount: 'authorized',
      AuthorizeNonceAccount: 'authorized',
    },
    expectedCount: 14,
  },
];

const ARG_TYPES = { u32: 'u32', u64: 'u64', Address: 'pubkey', String: 'string' };

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The body of `pub enum <name> { ... }` from comment-stripped source. */
function enumBody(src, enumName) {
  const marker = `pub enum ${enumName}`;
  const at = src.indexOf(marker);
  if (at < 0) throw Error(`enum ${enumName} not found`);
  const open = src.indexOf('{', at);
  if (open < 0) throw Error(`enum ${enumName} never opens`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw Error(`enum ${enumName} body never closes`);
}

/**
 * All variants of the enum body in declaration order, each `{ name, kind, inner }`.
 *
 * A single scanner rather than two regexes: the regex version silently DROPPED unit
 * variants (`Unused,`), which the first run caught as a variant-count mismatch — the
 * right failure (loud) from an implementation that could also miss a row silently.
 */
function parseVariants(body) {
  const variants = [];
  let i = 0;
  const IDENT = /[A-Za-z0-9_]/;
  const skip = (chars) => { while (i < body.length && chars.includes(body[i])) i++; };
  while (i < body.length) {
    skip(',\n\r\t ');
    if (i >= body.length) break;
    const start = i;
    while (i < body.length && IDENT.test(body[i])) i++;
    const name = body.slice(start, i);
    if (!/^[A-Z]/.test(name)) throw Error(`unexpected token in enum body: ${name || body[i]}`);
    skip(' \n\r\t');
    if (body[i] === '(' || body[i] === '{') {
      const open = body[i];
      const close = open === '(' ? ')' : '}';
      let depth = 0;
      const mark = i;
      for (; i < body.length; i++) {
        if (body[i] === open) depth++;
        else if (body[i] === close) {
          depth--;
          if (depth === 0) { i++; break; }
        }
      }
      if (depth !== 0) throw Error(`variant ${name}: unbalanced ${open}${close}`);
      variants.push({ name, kind: open === '(' ? 'tuple' : 'struct', inner: body.slice(mark + 1, i - 1) });
    } else {
      variants.push({ name, kind: 'unit', inner: '' });
    }
  }
  if (!variants.length) throw Error('enum body yielded no variants');
  return variants;
}

/** Derive one program's interface document from its vendored upstream source. */
export function deriveInterface(spec, { root = REPO_ROOT } = {}) {
  const file = path.join(root, VENDOR_DIR, spec.file);
  const raw = readFileSync(file);
  const fileSha256 = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const body = enumBody(stripComments(raw.toString('utf8')), spec.enumName);
  const derived = parseVariants(body);

  const names = derived.map((v) => v.name);
  if (new Set(names).size !== names.length) throw Error(`${spec.enumName}: duplicate variant names`);
  if (names.length !== spec.expectedCount) {
    throw Error(
      `${spec.enumName}: derived ${names.length} variants, expected ${spec.expectedCount} — ` +
        'upstream changed; update the pin and re-review before trusting this table',
    );
  }
  for (const rejected of spec.wireRejected) {
    if (!names.includes(rejected)) throw Error(`${spec.enumName}: expected wire-rejected variant ${rejected} is absent`);
  }

  const instructions = derived.map(({ name, kind, inner }, selector) => {
    if (spec.wireRejected.includes(name)) {
      return { selector, name, wire: 'rejected', args: [] };
    }
    let args;
    if (kind === 'struct') {
      args = [...inner.matchAll(/([a-z_][a-z0-9_]*)\s*:\s*([A-Za-z0-9_]+)/g)].map(([_, field, type]) => {
        if (!ARG_TYPES[type]) throw Error(`${spec.enumName}::${name}: field ${field} has unpinned type ${type}`);
        return { name: field, type: ARG_TYPES[type] };
      });
    } else if (kind === 'tuple') {
      const type = inner.trim();
      if (!ARG_TYPES[type]) {
        throw Error(`${spec.enumName}::${name}: tuple type ${type} is not a pinned interface type`);
      }
      const argName = spec.tupleArgNames?.[name];
      if (!argName) {
        throw Error(
          `${spec.enumName}::${name}: tuple payload has no declared argument name — ` +
            'upstream leaves it anonymous; take it from the pinned SDK constructor and declare it',
        );
      }
      args = [{ name: argName, type: ARG_TYPES[type] }];
    } else {
      // A unit variant outside the wire-rejected list. Upstream has one per enum
      // (System's `AdvanceNonceAccount` / `UpgradeNonceAccount`), and their wire shape
      // has to be stated explicitly rather than inferred: this module's job is to
      // notice surprises, not to pass over them.
      if (!spec.unitVariants?.includes(name)) {
        throw Error(
          `${spec.enumName}::${name}: unit variant not declared in unitVariants — ` +
            'unknown wire shape; declare it explicitly after checking the runtime',
        );
      }
      args = [];
    }
    if (kind !== 'unit' && !args.length) throw Error(`${spec.enumName}::${name}: no fields derived`);
    if (args.some((a) => !a.name || !a.type)) {
      throw Error(`${spec.enumName}::${name}: incomplete arg derivation from ${JSON.stringify(inner)}`);
    }
    if (new Set(args.map((a) => a.name)).size !== args.length) {
      throw Error(`${spec.enumName}::${name}: duplicate arg names`);
    }
    return { selector, name, wire: 'accepted', args };
  });

  return {
    program: spec.program,
    label: spec.label,
    scheme: 'native',
    source: {
      repo: 'anza-xyz/solana-sdk',
      pin: SDK_PIN,
      file: spec.file,
      enum: spec.enumName,
      fileSha256,
      vendoredAt: VENDOR_DIR,
      derivation: 'src/native-interface.mjs: declaration order = wire selector; struct-variant field order = wire order; tuple type = arg type; tuple arg names from the pinned SDK constructors',
    },
    runtime: spec.runtime,
    selector: spec.selector,
    argEncoding: spec.argEncoding,
    instructions,
  };
}

/** The spec of one program, by its id. */
export function specFor(program) {
  const spec = PROGRAMS.find((entry) => entry.program === program);
  if (!spec) throw Error(`no pinned native interface for ${program}`);
  return spec;
}

/** Derive every pinned native interface. */
export function deriveAll(options) {
  return PROGRAMS.map((spec) => deriveInterface(spec, options));
}

/** sha256 of a vendored upstream file, as `sha256:<hex>`. */
export function vendoredHash(spec, { root = REPO_ROOT } = {}) {
  const raw = readFileSync(path.join(root, VENDOR_DIR, spec.file));
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}
