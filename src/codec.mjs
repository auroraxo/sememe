// Instruction-data codec driven purely by a stored on-chain IDL.
//
// Design rules:
// - The byte layout is read from the IDL itself; no generated code and no
//   third-party codec library is involved (sememe's independence claim).
//   The only non-`node:` import used to be `@solana/web3.js`, and it was
//   used solely to base58-encode 32 raw pubkey bytes; `src/base58.mjs`
//   does that now, so the decode core runs in a repository with no npm
//   dependencies at all.
// - Decode is strict: unknown discriminators, unknown variants, invalid option
//   tags, invalid bool bytes, out-of-range numbers and trailing bytes are
//   errors instead of silent coercion.
// - Values are JSON-friendly after toJsonSafe(): 64/128-bit integers become
//   decimal strings, pubkeys become base58 strings, options use
//   {"__option":"None"|"Some", ...} and enums use {"__kind": "<Variant>", ...}.
//   Field names are the exact IDL names (snake_case).
//
// Supported IDL shapes: spec 0.1.0 (Anchor on-chain) plus the legacy forms
// {"defined": "Name"}, ["u8", 32] and {"kind": "type"} aliases.

import { encodeBase58, decodeBase58 } from './base58.mjs';

const MAX_DEPTH = 32;
// Instruction data is bounded by transaction size; a hostile length prefix
// larger than this cannot occur in honest data and guards empty-element loops.
const HARD_VEC_CAP = 1 << 20;

export class CodecError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CodecError';
    this.path = path ?? null;
  }
}

class Cursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }
  take(count, what) {
    if (!Number.isSafeInteger(count) || count < 0 || this.offset + count > this.bytes.length) {
      throw new CodecError(
        `truncated input: need ${count} byte(s) for ${what} at offset ${this.offset}, ` +
        `only ${this.bytes.length - this.offset} left`);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }
  get remaining() { return this.bytes.length - this.offset; }
}

// --- primitives -------------------------------------------------------------

const PRIMITIVES = {
  u8: { size: 1, signed: false }, u16: { size: 2, signed: false },
  u32: { size: 4, signed: false }, u64: { size: 8, signed: false },
  u128: { size: 16, signed: false },
  i8: { size: 1, signed: true }, i16: { size: 2, signed: true },
  i32: { size: 4, signed: true }, i64: { size: 8, signed: true },
  i128: { size: 16, signed: true },
};
// Alias accepted for readers of newer IDL drafts.
const ALIASES = { publicKey: 'pubkey', address: 'pubkey' };

function readLittle(cur, size, signed, path) {
  const bytes = cur.take(size, `${size}-byte integer`);
  let value = 0n;
  for (let index = size - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]);
  if (signed && value >= (1n << BigInt(size * 8 - 1))) value -= 1n << BigInt(size * 8);
  return size <= 4 ? Number(value) : value;
}

function writeLittle(size, signed, input, path) {
  let value = typeof input === 'bigint' ? input
    : typeof input === 'number' && Number.isSafeInteger(input) ? BigInt(input)
    : typeof input === 'string' && /^-?\d+$/.test(input) ? BigInt(input)
    : (() => { throw new CodecError(`expected an integer, got ${describe(input)}`, path); })();
  const bits = BigInt(size * 8);
  if (signed) {
    if (value < -(1n << (bits - 1n)) || value >= 1n << (bits - 1n)) {
      throw new CodecError(`${value} out of range for ${size}-byte signed integer`, path);
    }
    if (value < 0n) value += 1n << bits;
  } else {
    if (value < 0n || value >= 1n << bits) {
      throw new CodecError(`${value} out of range for ${size}-byte unsigned integer`, path);
    }
  }
  const out = Buffer.alloc(size);
  for (let index = 0; index < size; index++) {
    out[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string ${JSON.stringify(value.slice(0, 40))}`;
  if (typeof value === 'object') return Array.isArray(value) ? 'array' : `object with keys [${Object.keys(value).slice(0, 8)}]`;
  return `${typeof value} ${String(value).slice(0, 40)}`;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodePrimitive(name, cur, path) {
  switch (name) {
    case 'bool': {
      const byte = cur.take(1, 'bool')[0];
      if (byte === 0) return false;
      if (byte === 1) return true;
      throw new CodecError(`invalid bool byte ${byte} (must be 0 or 1)`, path);
    }
    case 'pubkey': return encodeBase58(cur.take(32, 'pubkey'));
    case 'string': {
      const length = readLittle(cur, 4, false, path);
      try { return utf8Decoder.decode(cur.take(length, 'utf-8 string')); }
      catch (error) {
        if (error instanceof CodecError) throw error;
        throw new CodecError(`invalid utf-8: ${error.message}`, path);
      }
    }
    case 'bytes': {
      const length = readLittle(cur, 4, false, path);
      return cur.take(length, 'bytes').toString('base64');
    }
    case 'f32': { const slice = cur.take(4, 'f32'); return slice.readFloatLE(0); }
    case 'f64': { const slice = cur.take(8, 'f64'); return slice.readDoubleLE(0); }
    default: {
      const primitive = PRIMITIVES[name];
      if (!primitive) throw new CodecError(`unknown primitive type ${JSON.stringify(name)}`, path);
      return readLittle(cur, primitive.size, primitive.signed, path);
    }
  }
}

function encodePrimitive(name, value, path) {
  switch (name) {
    case 'bool': {
      if (value !== true && value !== false) throw new CodecError(`expected true/false, got ${describe(value)}`, path);
      return Buffer.from([value ? 1 : 0]);
    }
    case 'pubkey': {
      if (value instanceof Uint8Array || Array.isArray(value)) {
        if (value.length !== 32) throw new CodecError(`pubkey must be 32 bytes, got ${value.length}`, path);
        return Buffer.from(value);
      }
      if (typeof value !== 'string') throw new CodecError(`expected a base58 pubkey, got ${describe(value)}`, path);
      try {
        const decoded = decodeBase58(value);
        // `PublicKey` enforced exactly this: a base58 string that decodes to 32 bytes.
        if (decoded.length !== 32) {
          throw new CodecError(`invalid pubkey: expected 32 bytes, got ${decoded.length}`, path);
        }
        return Buffer.from(decoded);
      } catch (error) {
        if (error instanceof CodecError) throw error;
        throw new CodecError(`invalid pubkey: ${error.message}`, path);
      }
    }
    case 'string': {
      if (typeof value !== 'string') throw new CodecError(`expected a string, got ${describe(value)}`, path);
      const bytes = Buffer.from(value, 'utf8');
      if (Buffer.compare(Buffer.from(bytes, 'utf8'), Buffer.from(value, 'utf8')) !== 0) {
        /* round-trip check is redundant; utf8 encoding is lossless for valid strings */
      }
      return Buffer.concat([writeLittle(4, false, bytes.length, path), bytes]);
    }
    case 'bytes': {
      if (typeof value !== 'string') throw new CodecError(`expected base64 for bytes, got ${describe(value)}`, path);
      const bytes = Buffer.from(value, 'base64');
      if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
        throw new CodecError('invalid base64 payload', path);
      }
      return Buffer.concat([writeLittle(4, false, bytes.length, path), bytes]);
    }
    case 'f32': {
      if (typeof value !== 'number') throw new CodecError(`expected a number, got ${describe(value)}`, path);
      const out = Buffer.alloc(4); out.writeFloatLE(value, 0); return out;
    }
    case 'f64': {
      if (typeof value !== 'number') throw new CodecError(`expected a number, got ${describe(value)}`, path);
      const out = Buffer.alloc(8); out.writeDoubleLE(value, 0); return out;
    }
    default: {
      const primitive = PRIMITIVES[name];
      if (!primitive) throw new CodecError(`unknown primitive type ${JSON.stringify(name)}`, path);
      return writeLittle(primitive.size, primitive.signed, value, path);
    }
  }
}

// --- type dispatch ----------------------------------------------------------

function assign(target, key, value, path) {
  if (key === '__kind' || key === '__option') {
    // defineProperty would still shadow the representation keys on decode.
    throw new CodecError(`field name ${JSON.stringify(key)} collides with the decoded representation`, path);
  }
  Object.defineProperty(target, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

function resolveDefined(typeName, ctx, path) {
  const typedef = ctx.types.get(typeName);
  if (!typedef) throw new CodecError(`unknown defined type ${JSON.stringify(typeName)}`, path);
  return typedef.type;
}

function arrayParts(type) {
  const array = type.array;
  if (Array.isArray(array)) {
    if (array.length !== 2) throw null;
    return { inner: array[0], length: array[1] };
  }
  if (array && typeof array === 'object' && 'inner' in array && 'len' in array) {
    return { inner: array.inner, length: array.len };
  }
  return null;
}

function variantFields(variant) {
  const fields = variant.fields;
  if (fields === undefined || fields === null) return { kind: 'unit', fields: [] };
  if (!Array.isArray(fields)) return null;
  if (fields.length === 0) return { kind: 'tuple', fields: [] };
  const named = fields.every((field) => field && typeof field === 'object'
    && typeof field.name === 'string' && 'type' in field);
  if (named) return { kind: 'named', fields };
  const plain = fields.every((field) => typeof field === 'string' || (field && typeof field === 'object' && !('name' in field)));
  if (plain) return { kind: 'tuple', fields };
  return null;
}

function structShape(type) {
  if (type && typeof type === 'object' && Array.isArray(type.fields)
      && (type.kind === 'struct' || type.kind === undefined)) return type.fields;
  return null;
}

function enumShape(type) {
  if (type && typeof type === 'object' && Array.isArray(type.variants)
      && (type.kind === 'enum' || type.kind === undefined)) return type.variants;
  return null;
}

export function decodeType(type, bytes, ctx, path = 'value', depth = 0, cursor = null) {
  const cur = cursor ?? new Cursor(bytes);
  const value = decodeAt(type, cur, ctx, path, depth);
  if (cursor === null) {
    if (cur.remaining !== 0) throw new CodecError(`trailing bytes: consumed ${cur.offset} of ${cur.bytes.length}`, path);
    return { value, consumed: cur.offset };
  }
  return value;
}

function decodeAt(type, cur, ctx, path, depth) {
  if (depth > MAX_DEPTH) throw new CodecError('type nesting too deep (recursive type?)', path);

  if (typeof type === 'string') return decodePrimitive(ALIASES[type] ?? type, cur, path);

  if (Array.isArray(type)) { // legacy ["u8", 32]
    if (type.length !== 2) throw new CodecError(`malformed array type ${JSON.stringify(type).slice(0, 60)}`, path);
    return decodeArray(type[0], type[1], cur, ctx, path, depth);
  }

  if (!type || typeof type !== 'object') {
    throw new CodecError(`unsupported type ${JSON.stringify(type)?.slice(0, 80)}`, path);
  }

  if ('option' in type) {
    const tag = cur.take(1, 'option tag')[0];
    if (tag === 0) return { __option: 'None' };
    if (tag !== 1) throw new CodecError(`invalid option tag ${tag} (must be 0 or 1)`, path);
    return { __option: 'Some', value: decodeAt(type.option, cur, ctx, `${path}.value`, depth + 1) };
  }
  if ('vec' in type) {
    const length = readLittle(cur, 4, false, path);
    const minimum = minSize(type.vec, ctx);
    if (minimum === 0 && length > HARD_VEC_CAP) {
      throw new CodecError(`vector length ${length} exceeds limit for ${path}`, path);
    }
    if (minimum !== null && BigInt(length) * BigInt(minimum) > BigInt(cur.remaining)) {
      throw new CodecError(`vector length ${length} needs ${length * minimum} byte(s) but ${cur.remaining} remain`, path);
    }
    const out = [];
    for (let index = 0; index < length; index++) {
      out.push(decodeAt(type.vec, cur, ctx, `${path}[${index}]`, depth + 1));
    }
    return out;
  }
  if ('array' in type) {
    const parts = arrayParts(type);
    if (!parts) throw new CodecError(`malformed array type ${JSON.stringify(type.array).slice(0, 60)}`, path);
    if (!Number.isSafeInteger(parts.length) || parts.length < 0) {
      throw new CodecError(`array length must be a non-negative integer, got ${JSON.stringify(parts.length)}`, path);
    }
    return decodeArray(parts.inner, parts.length, cur, ctx, path, depth);
  }
  if ('defined' in type) {
    const name = typeof type.defined === 'string' ? type.defined : type.defined?.name;
    if (typeof name !== 'string') throw new CodecError('malformed defined type', path);
    ctx.missing?.add(name);
    return decodeAt(resolveDefined(name, ctx, path), cur, ctx, name, depth + 1);
  }
  if ('generic' in type) {
    throw new CodecError(`generic parameter ${JSON.stringify(type.generic)} cannot be decoded`, path);
  }

  if (type.kind === 'type') return decodeAt(type.type, cur, ctx, path, depth + 1);

  const fields = structShape(type);
  if (fields) {
    const out = {};
    for (const field of fields) {
      if (!field || typeof field.name !== 'string' || !('type' in field)) {
        throw new CodecError('malformed struct field', path);
      }
      assign(out, field.name, decodeAt(field.type, cur, ctx, `${path}.${field.name}`, depth + 1), path);
    }
    return out;
  }

  const variants = enumShape(type);
  if (variants) {
    const index = cur.take(1, 'enum variant index')[0];
    if (index >= variants.length) {
      throw new CodecError(`unknown variant index ${index} (type has ${variants.length} variant(s))`, path);
    }
    const variant = variants[index];
    const shape = variantFields(variant);
    if (!shape) throw new CodecError(`malformed variant ${JSON.stringify(variant.name)}`, path);
    const out = { __kind: variant.name };
    if (shape.kind === 'unit') return out;
    if (shape.kind === 'tuple') {
      out.fields = shape.fields.map((fieldType, position) =>
        decodeAt(fieldType, cur, ctx, `${path}.fields[${position}]`, depth + 1));
      return out;
    }
    for (const field of shape.fields) {
      assign(out, field.name, decodeAt(field.type, cur, ctx, `${path}.${field.name}`, depth + 1), path);
    }
    return out;
  }

  throw new CodecError(`unsupported type ${JSON.stringify(type).slice(0, 80)}`, path);
}

function decodeArray(inner, length, cur, ctx, path, depth) {
  const out = [];
  for (let index = 0; index < length; index++) {
    out.push(decodeAt(inner, cur, ctx, `${path}[${index}]`, depth + 1));
  }
  return out;
}

// --- encoder ----------------------------------------------------------------

function encodeAt(type, value, ctx, path, depth) {
  if (depth > MAX_DEPTH) throw new CodecError('type nesting too deep (recursive type?)', path);

  if (typeof type === 'string') return encodePrimitive(ALIASES[type] ?? type, value, path);

  if (Array.isArray(type)) {
    if (type.length !== 2) throw new CodecError(`malformed array type ${JSON.stringify(type).slice(0, 60)}`, path);
    return encodeArray(type[0], type[1], value, ctx, path, depth);
  }

  if (!type || typeof type !== 'object') {
    throw new CodecError(`unsupported type ${JSON.stringify(type)?.slice(0, 80)}`, path);
  }

  if ('option' in type) {
    if (!value || typeof value !== 'object' || !('__option' in value)) {
      throw new CodecError(`expected {"__option":"None"|"Some"} object, got ${describe(value)}`, path);
    }
    const extra = Object.keys(value).filter((key) => key !== '__option' && key !== 'value');
    if (extra.length) throw new CodecError(`unexpected keys in option: ${extra.join(', ')}`, path);
    if (value.__option === 'None') return Buffer.from([0]);
    if (value.__option !== 'Some') {
      throw new CodecError(`__option must be "None" or "Some", got ${JSON.stringify(value.__option)}`, path);
    }
    if (!('value' in value)) throw new CodecError('option "Some" requires a "value" key', path);
    return Buffer.concat([Buffer.from([1]), encodeAt(type.option, value.value, ctx, `${path}.value`, depth + 1)]);
  }
  if ('vec' in type) {
    if (!Array.isArray(value)) throw new CodecError(`expected an array, got ${describe(value)}`, path);
    if (value.length > 0xffffffff) throw new CodecError(`vector length ${value.length} exceeds u32`, path);
    const parts = [writeLittle(4, false, value.length, path)];
    value.forEach((item, index) =>
      parts.push(encodeAt(type.vec, item, ctx, `${path}[${index}]`, depth + 1)));
    return Buffer.concat(parts);
  }
  if ('array' in type) {
    const parts = arrayParts(type);
    if (!parts) throw new CodecError(`malformed array type ${JSON.stringify(type.array).slice(0, 60)}`, path);
    return encodeArray(parts.inner, parts.length, value, ctx, path, depth);
  }
  if ('defined' in type) {
    const name = typeof type.defined === 'string' ? type.defined : type.defined?.name;
    if (typeof name !== 'string') throw new CodecError('malformed defined type', path);
    return encodeAt(resolveDefined(name, ctx, path), value, ctx, name, depth + 1);
  }
  if ('generic' in type) {
    throw new CodecError(`generic parameter ${JSON.stringify(type.generic)} cannot be encoded`, path);
  }

  if (type.kind === 'type') return encodeAt(type.type, value, ctx, path, depth + 1);

  const fields = structShape(type);
  if (fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CodecError(`expected a struct object, got ${describe(value)}`, path);
    }
    const expected = new Set(fields.map((field) => field.name));
    const unknown = Object.keys(value).filter((key) => !expected.has(key));
    if (unknown.length) throw new CodecError(`unexpected field(s): ${unknown.join(', ')}`, path);
    const parts = [];
    for (const field of fields) {
      if (!(field.name in value)) throw new CodecError(`missing field ${JSON.stringify(field.name)}`, path);
      parts.push(encodeAt(field.type, value[field.name], ctx, `${path}.${field.name}`, depth + 1));
    }
    return Buffer.concat(parts);
  }

  const variants = enumShape(type);
  if (variants) {
    if (!value || typeof value !== 'object' || typeof value.__kind !== 'string') {
      throw new CodecError(`expected {"__kind": "<variant>"}, got ${describe(value)}`, path);
    }
    const index = variants.findIndex((variant) => variant.name === value.__kind);
    if (index < 0) {
      throw new CodecError(`unknown variant ${JSON.stringify(value.__kind)}; expected one of [${variants.map((v) => v.name).join(', ')}]`, path);
    }
    if (index > 0xff) throw new CodecError(`variant index ${index} does not fit in one byte`, path);
    const variant = variants[index];
    const shape = variantFields(variant);
    if (!shape) throw new CodecError(`malformed variant ${JSON.stringify(variant.name)}`, path);
    const extra = Object.keys(value).filter((key) =>
      key !== '__kind' && !(shape.kind === 'tuple' && key === 'fields') && !shape.fields.some((f) => f.name === key));
    if (extra.length) throw new CodecError(`unexpected key(s) for variant ${variant.name}: ${extra.join(', ')}`, path);
    const parts = [Buffer.from([index])];
    if (shape.kind === 'unit') return Buffer.concat(parts);
    if (shape.kind === 'tuple') {
      if (!Array.isArray(value.fields)) throw new CodecError(`variant ${variant.name} requires a "fields" array`, path);
      if (value.fields.length !== shape.fields.length) {
        throw new CodecError(`variant ${variant.name} expects ${shape.fields.length} field(s), got ${value.fields.length}`, path);
      }
      shape.fields.forEach((fieldType, position) =>
        parts.push(encodeAt(fieldType, value.fields[position], ctx, `${path}.fields[${position}]`, depth + 1)));
      return Buffer.concat(parts);
    }
    for (const field of shape.fields) {
      if (!(field.name in value)) throw new CodecError(`missing field ${JSON.stringify(field.name)}`, path);
      parts.push(encodeAt(field.type, value[field.name], ctx, `${path}.${field.name}`, depth + 1));
    }
    return Buffer.concat(parts);
  }

  throw new CodecError(`unsupported type ${JSON.stringify(type).slice(0, 80)}`, path);
}

function encodeArray(inner, length, value, ctx, path, depth) {
  if (!Array.isArray(value)) throw new CodecError(`expected an array of length ${length}, got ${describe(value)}`, path);
  if (value.length !== length) throw new CodecError(`expected an array of length ${length}, got ${value.length} element(s)`, path);
  return Buffer.concat(value.map((item, index) =>
    encodeAt(inner, item, ctx, `${path}[${index}]`, depth + 1)));
}

// --- sizing (for hostile-length pre-checks only) -----------------------------

function minSize(type, ctx) {
  if (typeof type === 'string') {
    const name = ALIASES[type] ?? type;
    if (name === 'bool' || name === 'pubkey') return name === 'bool' ? 1 : 32;
    if (name === 'string' || name === 'bytes') return 4;
    if (name === 'f32') return 4;
    if (name === 'f64') return 8;
    return PRIMITIVES[name]?.size ?? null;
  }
  if (Array.isArray(type)) {
    const inner = minSize(type[0], ctx);
    return inner === null || !Number.isSafeInteger(type[1]) ? null : inner * type[1];
  }
  if (!type || typeof type !== 'object') return null;
  if ('option' in type) { const inner = minSize(type.option, ctx); return inner === null ? null : 1 + inner; }
  if ('vec' in type) return 4;
  if ('array' in type) {
    const parts = arrayParts(type);
    if (!parts) return null;
    const inner = minSize(parts.inner, ctx);
    return inner === null ? null : inner * parts.length;
  }
  if ('defined' in type) {
    const name = typeof type.defined === 'string' ? type.defined : type.defined?.name;
    const typedef = name ? ctx.types.get(name) : null;
    return typedef ? minSize(typedef.type, ctx) : null;
  }
  if (type.kind === 'type') return minSize(type.type, ctx);
  const fields = structShape(type);
  if (fields) {
    let total = 0;
    for (const field of fields) {
      const size = minSize(field.type, ctx);
      if (size === null) return null;
      total += size;
    }
    return total;
  }
  const variants = enumShape(type);
  if (variants) {
    let largest = 1;
    for (const variant of variants) {
      const shape = variantFields(variant);
      if (!shape) return null;
      let total = 1;
      if (shape.kind === 'tuple') {
        for (const fieldType of shape.fields) {
          const size = minSize(fieldType, ctx);
          if (size === null) return null;
          total += size;
        }
      } else if (shape.kind === 'named') {
        for (const field of shape.fields) {
          const size = minSize(field.type, ctx);
          if (size === null) return null;
          total += size;
        }
      }
      largest = Math.max(largest, total);
    }
    return largest;
  }
  return null;
}

// --- instruction level ------------------------------------------------------

function context(idl) {
  if (!idl || !Array.isArray(idl.instructions)) throw new CodecError('IDL has no instructions array', null);
  const types = new Map();
  for (const typedef of idl.types ?? []) {
    if (typedef && typeof typedef.name === 'string') types.set(typedef.name, typedef);
  }
  return { types };
}

function discriminatorBytes(instruction) {
  const raw = instruction?.discriminator;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new CodecError(`instruction ${JSON.stringify(instruction?.name)} has a malformed discriminator`, null);
  }
  return Buffer.from(raw);
}

export function instructionIndex(idl) {
  const index = new Map();
  for (const instruction of idl.instructions) {
    const bytes = discriminatorBytes(instruction);
    if (!bytes) continue;
    const key = bytes.toString('hex');
    if (index.has(key)) {
      throw new CodecError(`duplicate instruction discriminator ${key} (${index.get(key).name} / ${instruction.name})`, null);
    }
    index.set(key, instruction);
  }
  return index;
}

function instructionByName(idl, name) {
  const instruction = idl.instructions.find((candidate) => candidate.name === name);
  if (!instruction) {
    const known = idl.instructions.map((candidate) => candidate.name);
    const near = known.filter((candidate) => candidate.startsWith(String(name).slice(0, 6))).slice(0, 3);
    throw new CodecError(
      `unknown instruction ${JSON.stringify(name)}` +
      (near.length ? ` (similar: ${near.join(', ')})` : `; ${known.length} instruction(s) in this IDL`), null);
  }
  return instruction;
}

/**
 * Decode one instruction payload (discriminator + args) using the IDL.
 *
 * The stored IDL describes the bytes it knows; it does not have to describe
 * every byte in the buffer. `trailing` chooses what happens to bytes the IDL
 * does not explain:
 *   'report' (default) decode the described prefix and return the unexplained
 *             bytes under `trailing` — surfaced, never silently dropped.
 *   'error'  refuse the whole payload.
 * `allowTrailing: false` is accepted as an alias for `{ trailing: 'error' }`.
 *
 * 'report' is the default because it matches the program being decoded: Anchor
 * deserialises instruction args with Borsh `deserialize` over a slice, which
 * reads what the struct needs and does not require the slice to be exhausted.
 * Two real mainnet Whirlpool `swap_v2` payloads carry 7 bytes beyond the stored
 * IDL, both in transactions that succeeded on-chain (slot 462101502, and the
 * 43-byte form of the same instruction at slot 462101506) — refusing them
 * rejected 2 of 50 harvested payloads that the deployed program accepted.
 */
export function decodeInstructionData(idl, data, { allowTrailing, trailing } = {}) {
  const policy = trailing ?? (allowTrailing === false ? 'error' : 'report');
  if (policy !== 'report' && policy !== 'error') {
    throw new CodecError(`unknown trailing policy ${JSON.stringify(trailing)}`, null);
  }
  if (!(data instanceof Uint8Array)) throw new CodecError('instruction data must be a Uint8Array/Buffer', null);
  const ctx = context(idl);
  const index = instructionIndex(idl);
  const prefixLength = Math.min(8, data.length);
  const key = Buffer.from(data.subarray(0, prefixLength)).toString('hex');
  let instruction = null;
  let consumed = 0;
  // Discriminators may be shorter than 8 bytes in generated IDLs; match on the
  // stored prefix length instead of assuming 8.
  for (const [candidate, entry] of index) {
    if (key.startsWith(candidate)) { instruction = entry; consumed = candidate.length / 2; break; }
  }
  if (!instruction) {
    const hint = [...index.keys()].slice(0, 3).join(', ');
    throw new CodecError(
      `unknown instruction discriminator ${key.slice(0, 16)} ` +
      `(${index.size} known, e.g. ${hint})`, null);
  }
  if (data.length < consumed) throw new CodecError('truncated discriminator', null);
  const cursor = new Cursor(data);
  cursor.offset = consumed;
  const args = {};
  for (const argument of instruction.args ?? []) {
    if (!argument || typeof argument.name !== 'string' || !('type' in argument)) {
      throw new CodecError(`instruction ${instruction.name} has a malformed argument`, null);
    }
    assign(args, argument.name, decodeAt(argument.type, cursor, ctx, `${instruction.name}.${argument.name}`, 0), instruction.name);
  }
  const trailingCount = cursor.remaining;
  const trailingHex = trailingCount > 0
    ? Buffer.from(data.subarray(cursor.offset)).toString('hex')
    : '';
  if (trailingCount > 0 && policy === 'error') {
    throw new CodecError(
      `trailing bytes after ${instruction.name}: consumed ${cursor.offset} of ${data.length}`, instruction.name);
  }
  return {
    instruction: instruction.name,
    discriminator: Buffer.from(data.subarray(0, consumed)).toString('hex'),
    args,
    consumed: cursor.offset,
    total: data.length,
    // Bytes the IDL does not explain, as count + hex. Present (0, '') when the
    // payload is fully described, so `trailing.count === 0` is a usable
    // completeness assertion and `count > 0` is an IDL-drift signal.
    trailing: { count: trailingCount, hex: trailingHex },
  };
}

/** Encode one instruction payload (discriminator + args) using the IDL. */
export function encodeInstructionData(idl, name, args) {
  const ctx = context(idl);
  const instruction = instructionByName(idl, name);
  const bytes = discriminatorBytes(instruction) ?? (() => {
    throw new CodecError(`instruction ${JSON.stringify(name)} has no discriminator in this IDL`, null);
  })();
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new CodecError('args must be an object', null);
  const known = new Set((instruction.args ?? []).map((argument) => argument.name));
  const unknown = Object.keys(args).filter((key) => !known.has(key));
  if (unknown.length) {
    throw new CodecError(`unexpected argument(s) for ${instruction.name}: ${unknown.join(', ')}`, null);
  }
  const parts = [bytes];
  for (const argument of instruction.args ?? []) {
    if (!(argument.name in args)) throw new CodecError(`missing argument ${JSON.stringify(argument.name)}`, instruction.name);
    parts.push(encodeAt(argument.type, args[argument.name], ctx, `${instruction.name}.${argument.name}`, 0));
  }
  return Buffer.concat(parts);
}

/** Deep-copy a decoded value into JSON-safe form: bigint -> decimal string. */
export function toJsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = toJsonSafe(value[key]);
    return out;
  }
  return value;
}
