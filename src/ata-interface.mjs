// Derive the SPL Associated Token Account wire table from the VENDORED
// UPSTREAM RUST.
//
// Same contract as src/native-interface.mjs / src/token-interface.mjs /
// src/raydium-interface.mjs: this program publishes NO IDL account to pull
// (measured 2026-11-11 over 6 finalized mainnet blocks: 1,410 payloads, the
// single largest acquisition gap in research/ecosystem-coverage-2026-11-11.json,
// acquirable=false at both pullable addresses). Its interface is the upstream
// Rust sources, and its wire rule is small enough to be pinned exactly:
//
//   - interface/src/instruction.rs declares `AssociatedTokenAccountInstruction`
//     as a borsh UNIT enum: Create, CreateIdempotent, RecoverNested. The
//     instruction payload is borsh's own enum encoding — the variant index,
//     ONE byte, and no args — and the borsh serialise arms are the ground
//     truth for the tag: an index pushed with `push(idx)` in serialise is
//     the wire byte, and a declaration that no arm pushes is an upstream
//     addition nobody re-reviewed (it fails loudly instead of decoding as
//     "unknown").
//   - program/src/processor.rs is the RUNTIME verdict: `input.is_empty()` is
//     executed as `Create` (the empty payload the measurement saw 4 times is
//     a real instruction the chain runs, not a refusal), everything else is
//     judged by `try_from_slice`, and an unjudged input is
//     ProgramError::InvalidInstructionData — a named refusal, never a guess.
//
// Why derive instead of transcribe: the System/ComputeBudget table was once
// hand-typed, and the transcription carried a defect that survived review.
// Three variants is small, but the rule that held is the same: the table is
// derived from upstream's own text, both directions are cross-checked, and
// every vendored file is hashed so a swapped source refuses the load.
//
// Dependency-free on purpose: it is imported by the decode path.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const ATA_PINS = {
  interface: {
    repo: 'solana-program/associated-token-account',
    dir: 'spl-associated-token-account',
    pin: 'fbf5379e7398ac8b231c73ee8a9ff677b43dd0ec',
    license: 'Apache-2.0 (LICENSE vendored beside the sources)',
    files: [
      { file: 'interface/src/instruction.rs', role: 'AssociatedTokenAccountInstruction: borsh unit enum, serialise arms carry the wire byte' },
      { file: 'program/src/processor.rs', role: 'runtime verdict: empty input falls back to Create, borsh try_from_slice judges the rest, InvalidInstructionData refuses' },
      { file: 'interface/src/lib.rs', role: 'the program id (declare_id), read from upstream, not re-typed' },
    ],
  },
};

export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The body of a `fn ...` / `impl ...` block from comment-stripped source. */
function blockBody(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) throw Error(`block not found: ${signature}`);
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
 * The declared variants of `pub enum AssociatedTokenAccountInstruction`, in
 * declaration order, with the declared field list (a unit variant has none).
 * A tuple or struct variant is an upstream shape this module does not pin:
 * it throws instead of inventing an encoding for it.
 */
export function parseAtaVariants(src) {
  // Upstream annotates variants with multi-line `#[cfg_attr(...)]` and doc
  // attributes; they are not declarations and must go before the split.
  src = src.replace(/#\[[\s\S]*?\]\s*/g, '');
  const at = src.indexOf('pub enum AssociatedTokenAccountInstruction');
  if (at < 0) throw Error('AssociatedTokenAccountInstruction enum not found');
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
  for (const part of body.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const unit = trimmed.match(/^([A-Z][A-Za-z0-9_]*)$/);
    if (unit) { variants.push({ name: unit[1], fields: [] }); continue; }
    if (/^[A-Z][A-Za-z0-9_]*\s*[({]/.test(trimmed)) {
      throw Error(`AssociatedTokenAccountInstruction: variant "${trimmed}" is not a unit variant — this module pins unit enums only; re-review the pin`);
    }
    throw Error(`AssociatedTokenAccountInstruction: unreadable variant "${trimmed}"`);
  }
  if (!variants.length) throw Error('AssociatedTokenAccountInstruction yielded no variants');
  return variants;
}

/**
 * The wire byte of each variant, read from upstream's OWN builders.
 *
 * The borsh `serialise` is macro-generated, so it is not in the source text —
 * but upstream's instruction builders are, and each one writes the payload
 * byte it means to send together with the variant it means:
 *
 *   data: vec![2], // AssociatedTokenAccountInstruction::RecoverNested
 *   ... build_associated_token_account_instruction(..., 0, // ...::Create
 *
 * So the wire byte is upstream's own literal, cross-checked against the
 * declaration index upstream's borsh derive would use (the index in the
 * enum's declaration order). Both must agree: a builder that writes a byte
 * the declaration index does not carry is an upstream shape this module does
 * not pin, and it fails loudly instead of decoding as "unknown".
 */
function deriveWireTags(rawSrc, variantNames) {
  const src = rawSrc;
  const wires = new Map();
  // (a) the literal payload bytes of the builders, with the named variant
  const push = (byte, name, how) => {
    if (wires.has(name)) {
      if (wires.get(name).tag !== byte) {
        throw Error(`upstream writes ${name} with two different bytes (${wires.get(name).tag} and ${byte})`);
      }
      return;
    }
    wires.set(name, { tag: byte, how });
  };
  for (const m of src.matchAll(
    /data:\s*vec!\[(\d+)\]\s*,?\s*\/\/\s*AssociatedTokenAccountInstruction::([A-Za-z0-9_]+)/g,
  )) {
    push(Number(m[1]), m[2], 'data: vec![byte] in the instruction builder');
  }
  for (const m of src.matchAll(
    /(\d+)\s*,\s*\/\/\s*AssociatedTokenAccountInstruction::([A-Za-z0-9_]+)/g,
  )) {
    push(Number(m[1]), m[2], 'the instruction byte passed to the builder');
  }

  // Every declared variant must be written by upstream somewhere, and every
  // written name must be a declared variant.
  for (const [index, name] of variantNames.entries()) {
    if (!wires.has(name)) {
      throw Error(`variant ${name} (index ${index}) is declared upstream but no builder writes it — upstream added a variant this table does not pin`);
    }
    if (wires.get(name).tag !== index) {
      throw Error(`upstream writes ${name} with byte ${wires.get(name).tag}, but its declaration index is ${index} — this module pins the borsh index encoding only`);
    }
  }
  for (const name of wires.keys()) {
    if (!variantNames.includes(name)) {
      throw Error(`upstream writes ${name}, which the enum does not declare`);
    }
  }
  return wires;
}

/** The processor's own runtime verdict, read out of the vendored text. */
function deriveRuntime(src, variantNames) {
  const processBody = blockBody(src, 'pub fn process_instruction');

  // `let instruction = if input.is_empty() { <Fallback> } else { ... }`
  const fallback = processBody.match(
    /if input\.is_empty\(\)\s*\{\s*AssociatedTokenAccountInstruction::([A-Za-z0-9_]+)\s*\}/,
  );
  if (!fallback) throw Error('processor: the empty-input branch is not the shape this module pins');
  const emptyInputFallback = fallback[1];
  if (!variantNames.includes(emptyInputFallback)) {
    throw Error(`processor: empty-input fallback ${emptyInputFallback} is not a declared variant`);
  }

  // The judge: borsh `try_from_slice`, refusal mapped to InvalidInstructionData.
  if (!/try_from_slice\(input\)/.test(processBody)) {
    throw Error('processor: borsh try_from_slice is not the judge this module pins');
  }
  if (!/InvalidInstructionData/.test(processBody)) {
    throw Error('processor: the unjudged-input refusal (InvalidInstructionData) is missing');
  }

  return {
    judge: 'borsh AssociatedTokenAccountInstruction::try_from_slice(input)',
    emptyInputFallback,
    unknownInputRefusal: 'ProgramError::InvalidInstructionData',
    source: 'program/src/processor.rs at the pin',
  };
}

/** The program id, read from the vendored `declare_id!`, not re-typed. */
function deriveProgramId(src) {
  const m = src.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/);
  if (!m) throw Error('interface/src/lib.rs: no declare_id! found');
  return m[1];
}

/** Derive the ATA interface document from the vendored upstream sources. */
export function deriveAtaInterface(spec, { root = REPO_ROOT } = {}) {
  const base = path.join(root, 'vendor', ATA_PINS.interface.dir, ATA_PINS.interface.pin);
  const files = ATA_PINS.interface.files.map((entry) => {
    const raw = readFileSync(path.join(base, entry.file));
    return { ...entry, sha256: `sha256:${createHash('sha256').update(raw).digest('hex')}` };
  });

  const instructionRaw = readFileSync(path.join(base, 'interface/src/instruction.rs'), 'utf8');
  const instructionSrc = stripComments(instructionRaw);
  const processorSrc = stripComments(
    readFileSync(path.join(base, 'program/src/processor.rs'), 'utf8'),
  );
  const libSrc = readFileSync(path.join(base, 'interface/src/lib.rs'), 'utf8');

  const program = deriveProgramId(libSrc);
  if (program !== spec.expectedProgram) {
    throw Error(`upstream declares program ${program}, this table pins ${spec.expectedProgram}`);
  }

  const variants = parseAtaVariants(instructionSrc);
  const wires = deriveWireTags(instructionRaw, variants.map((v) => v.name));
  const runtime = deriveRuntime(processorSrc, variants.map((v) => v.name));

  const instructions = variants.map((variant) => ({
    tag: wires.get(variant.name).tag,
    name: variant.name,
    wire: 'borsh-unit-enum',
    args: [],
  }));

  return {
    program,
    label: spec.label,
    scheme: 'native-ata',
    source: {
      repo: ATA_PINS.interface.repo,
      pin: ATA_PINS.interface.pin,
      license: ATA_PINS.interface.license,
      enum: 'AssociatedTokenAccountInstruction (borsh unit enum: the variant index is the one-byte payload)',
      programSource: 'vendored interface/src/lib.rs declare_id',
      files,
      vendoredAt: `vendor/${ATA_PINS.interface.dir}/${ATA_PINS.interface.pin}`,
      derivation: 'src/ata-interface.mjs: tag = the declaration index upstream\'s borsh serialise arm pushes; args = none (unit enum); runtime verdicts read from the processor (empty input falls back to Create, borsh try_from_slice judges, InvalidInstructionData refuses)',
    },
    runtime,
    selector: {
      width: 1,
      encoding: 'borsh enum index, u8; empty input is the processor\'s own Create fallback, not an unknown selector',
    },
    argEncoding: 'unit enum: payload is exactly the one index byte; no argument bytes',
    instructions,
  };
}

/** The pinned ATA spec. The expected program is the opinion layer; the
 * derivation checks it against upstream's own declare_id. */
export const ATA_SPEC = {
  program: ATA_PROGRAM,
  expectedProgram: ATA_PROGRAM,
  label: 'SPL Associated Token Account',
};

/** sha256 of a vendored upstream file, as `sha256:<hex>`. */
export function vendoredAtaHash(file, { root = REPO_ROOT } = {}) {
  const raw = readFileSync(
    path.join(root, 'vendor', ATA_PINS.interface.dir, ATA_PINS.interface.pin, file),
  );
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}
