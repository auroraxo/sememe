// src/rawle.mjs — the raw little-endian tag-dispatch dialect ENGINE.
//
// Why this exists: 12.11. PULS X named the refusal for interfaces sememe
// does not speak (src/dialect.mjs) — the right first step, but Benennen is
// NICHT Support. The measured face: DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4
// WoLxc5z (cryptodiablo/diabloarb, first-party IDL at pin f5005ac4) — 102
// payloads in the committed ecosystem sample, 0 decoded: the dialect gate
// refuses its whole file. The refusal was honest because the grammar
// carries no Anchor/shank structure the codec could read: `types` is a
// dict, instructions dispatch on a 1-byte `tag`, and list lengths are u8
// COUNTERS in the header, not Borsh u32 prefixes.
//
// What this file is: an engine for exactly the shape the interface
// DECLARES it speaks — `encoding: "little-endian; u8/u16/u32/u64 unsigned,
// i64 signed; no padding; no length prefixes except the u8 counters named
// in each header"` (the file's own words). It decodes the declared field
// list over the bytes, and encodes the field list back. Byte-exactness of
// decode -> encode is the only evidence it offers, and the measurement
// (tools/measure-rawle-decoder.mjs) holds it against the REAL wire of all
// 102 committed payloads: anything the fixed grammar cannot explain exits
// as a named refusal, never a guess.
//
// The grammar it accepts (and NOTHING else):
//   - instruction dispatch: a `tag` (0..255) plus a `data` field list whose
//     first entry is { name: 'tag', type: 'u8', value: <tag> }.
//   - primitives: u8, u16, u32, u64 (unsigned), i64 (signed) — exactly the
//     set the declared encoding names. Anything else (string, bytes,
//     pubkey, bool, floats, i8/i16/i32/i128, u128) is OUT: a dialect the
//     file does not declare is not this dialect.
//   - named types: `types` as a DICT keyed by name; each entry is a field
//     list, optionally with a declared fixed `size` that MUST equal the
//     sum of its fields (measured: Hop size 5 = 5x u8, Base 24 = 3x u64) —
//     a size that disagrees is a grammar the engine will not pretend to
//     read.
//   - length-prefixed-by-counter arrays: `Type[n_field]` where `n_field` is
//     a preceding u8 primitive field in the SAME field list (measured:
//     Base[n_bases], Hop[n_windows], Route[n_routes], u8[n_hops]).
//   - one trailing OPTIONAL field: `optional: <prose>` on the LAST field
//     only. The prose (measured: "present only with SearchFlags.BUDGET") is
//     not machine-readable, so presence is decided BY THE BYTES: the option
//     field is read exactly when its full size fits the remainder to zero.
//     A remainder that is neither exactly the option size nor zero is a
//     named refusal (trailing bytes the layout does not explain).
//
// NOT WIRED INTO THE PRODUCT. No call site in codec/union/adopt/store-read
// or the CLI routes through this engine yet — PULS X's named refusal stays
// the product's answer at every boundary, byte for byte, and the dialect
// gate is untouched. That is deliberate: making support the product answer
// changes 19 pinned faces of the PULS X measurement (its artifacts and
// tools assert the refusal of THIS interface), and the release it belongs
// to must state the change. The engine + measurement first, the wiring
// with the pins it rewrites — this is the same order every pulse in this
// repo has worked in.
//
// Byte-exactness note: decoded integers come back as Number (<= 4 bytes)
// or BigInt (8 bytes), exactly like src/codec.mjs's own convention, and
// `encodeRawLe` accepts Number, BigInt or decimal-string inputs.

class RawLeError extends Error {
  constructor(message, path) {
    super(path ? `${message} (${path})` : message);
    this.name = 'RawLeError';
    this.path = path ?? null;
  }
}

const PRIMITIVE_SIZES = { u8: 1, u16: 2, u32: 4, u64: 8, i64: 8 };
const SIGNED = new Set(['i64']);

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

const ARRAY_SYNTAX = /^([A-Za-z_][A-Za-z0-9_]*)\[([A-Za-z_][A-Za-z0-9_]*)\]$/;

/**
 * Is this IDL written in the dialect THIS engine speaks? Returns null when
 * the whole file is inside the grammar above, or a named reason when any
 * part of it is not. Never throws: this is the gate that decides whether
 * the engine may even be asked.
 */
export function rawLeDialectReason(idl) {
  if (!isPlainObject(idl)) return 'not an IDL object';
  if (typeof idl.encoding !== 'string' || !/^little-endian\b/.test(idl.encoding)) {
    return 'no little-endian encoding declaration — this engine speaks only the dialect the file itself declares';
  }
  if (!Array.isArray(idl.instructions) || idl.instructions.length === 0) {
    return 'no instructions array';
  }
  if (idl.types !== undefined && !isPlainObject(idl.types)) {
    return 'types must be a dict keyed by name in this dialect';
  }
  const typeNames = new Set(Object.keys(idl.types ?? {}));

  const fieldsReason = (fields, where) => {
    if (!Array.isArray(fields)) return `${where}: field list is not an array`;
    let previousNames = new Set();
    for (const [index, field] of fields.entries()) {
      if (!isPlainObject(field) || typeof field.name !== 'string') {
        return `${where}: field ${index} is not a named field`;
      }
      const reason = fieldReason(field, previousNames, typeNames, `${where}.${field.name}`);
      if (reason) return reason;
      if (field.optional !== undefined && index !== fields.length - 1) {
        return `${where}.${field.name}: an optional field must be the last field — a hole in the middle cannot be told apart from garbage`;
      }
      previousNames.add(field.name);
    }
    return null;
  };

  for (const [name, type] of Object.entries(idl.types ?? {})) {
    if (!isPlainObject(type)) return `types.${name}: not a field-list object`;
    const reason = fieldsReason(type.fields, `types.${name}`);
    if (reason) return reason;
    // A numeric `size` is a fixed-size claim and must equal the field sum
    // (measured: Hop 5 = 5x u8, Base 24 = 3x u64). A string `size` like
    // "2 + n_hops" declares a VARIABLE size — the file says so itself, and
    // there is nothing to check against a fixed sum.
    if (typeof type.size === 'number') {
      const fixed = fixedSizeOf(type.fields, typeNames);
      if (fixed === null) {
        return `types.${name}: declares a fixed size but its fields are not all fixed (counter arrays need a runtime count)`;
      }
      if (fixed !== type.size) {
        return `types.${name}: declared size ${type.size} does not equal the field sum ${fixed}`;
      }
    } else if (type.size !== undefined && typeof type.size !== 'string') {
      return `types.${name}: malformed size declaration ${JSON.stringify(type.size)}`;
    }
  }

  const tags = new Map();
  for (const instruction of idl.instructions) {
    if (!isPlainObject(instruction)) return 'instruction entries must be objects';
    if (!Number.isInteger(instruction.tag) || instruction.tag < 0 || instruction.tag > 255) {
      return `instruction ${JSON.stringify(instruction.name ?? null)}: no u8 tag — tag dispatch is the whole of this dialect`;
    }
    if (tags.has(instruction.tag)) {
      return `duplicate instruction tag ${instruction.tag} (${tags.get(instruction.tag)} / ${instruction.name})`;
    }
    // Instructions with a tag and NO data list exist in the measured file
    // (diabloarb `route` tag 0, `withdraw` tag 3 — owner-only stubs with
    // empty data). The wire face of all 102 sampled payloads is tag 01,
    // so a dispatch on such a tag is a refusal at DECODE time; the
    // grammar itself stays decidable here.
    if (instruction.data !== undefined && !Array.isArray(instruction.data)) {
      return `instruction ${JSON.stringify(instruction.name)}: data must be a field list`;
    }
    if (Array.isArray(instruction.data)) {
      if (instruction.data.length === 0) {
        return `instruction ${JSON.stringify(instruction.name)}: empty data list`;
      }
      const first = instruction.data[0];
      if (!isPlainObject(first) || first.name !== 'tag' || first.type !== 'u8' || first.value !== instruction.tag) {
        return `instruction ${JSON.stringify(instruction.name)}: data must start with { name: 'tag', type: 'u8', value: tag }`;
      }
      const reason = fieldsReason(instruction.data, `instruction ${instruction.name}`);
      if (reason) return reason;
    }
    tags.set(instruction.tag, instruction.name);
  }
  return null;
}

function fieldReason(field, previousNames, typeNames, path) {
  if (field.optional !== undefined && typeof field.optional !== 'string') {
    return `${path}: optional must state its condition as prose`;
  }
  const type = field.type;
  if (typeof type !== 'string') return `${path}: type must be a string in this dialect`;
  if (PRIMITIVE_SIZES[type]) return null;
  if (typeNames.has(type)) return null;
  const match = ARRAY_SYNTAX.exec(type);
  if (!match) return `${path}: unsupported type ${JSON.stringify(type.slice(0, 60))} — outside the declared grammar (u8/u16/u32/u64/i64, named types, Type[counter])`;
  const [, element, counter] = match;
  if (!(PRIMITIVE_SIZES[element] || typeNames.has(element))) {
    return `${path}: array element ${JSON.stringify(element)} is not a supported type`;
  }
  if (!previousNames.has(counter)) {
    return `${path}: counter ${JSON.stringify(counter)} is not a preceding field of the same list`;
  }
  return null;
}

/** The fixed byte size of a field list when all of it is fixed, else null. */
function fixedSizeOf(fields, typeNames) {
  let total = 0;
  for (const field of fields) {
    if (field.optional !== undefined) return null; // conditionally present is not fixed
    const size = typeFixedSize(field.type, typeNames);
    if (size === null) return null;
    total += size;
  }
  return total;
}

function typeFixedSize(type, typeNames) {
  if (typeof type !== 'string') return null;
  if (PRIMITIVE_SIZES[type]) return PRIMITIVE_SIZES[type];
  if (!typeNames.has(type)) return null;
  return null; // named types are resolved with their field list elsewhere
}

// --- decode -----------------------------------------------------------------

class Reader {
  constructor(bytes) {
    this.bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
    this.offset = 0;
  }
  take(count, path) {
    if (!Number.isSafeInteger(count) || count < 0 || this.offset + count > this.bytes.length) {
      throw new RawLeError(
        `truncated input: need ${count} byte(s) at offset ${this.offset}, only ${this.bytes.length - this.offset} left`, path);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }
  get remaining() { return this.bytes.length - this.offset; }
}

const readInt = (slice, signed) => {
  let value = 0n;
  for (let index = slice.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(slice[index]);
  if (signed && value >= (1n << BigInt(slice.length * 8 - 1))) value -= 1n << BigInt(slice.length * 8);
  return slice.length <= 4 ? Number(value) : value;
};

/**
 * Decode one instruction payload with its declared raw-LE field list.
 * `trailing: 'error'` (default 'report') refuses any byte the layout did
 * not read — the exactness the measurement pins per payload.
 */
export function decodeRawLe(idl, data) {
  const reason = rawLeDialectReason(idl);
  if (reason) throw new RawLeError(`not a raw-LE dialect this engine speaks: ${reason}`, null);
  const bytes = data instanceof Uint8Array ? data : (() => { throw new RawLeError('instruction data must be a Uint8Array/Buffer', null); })();
  if (bytes.length === 0) throw new RawLeError('empty payload: no tag byte to dispatch on', null);
  const instruction = idl.instructions.find((candidate) => candidate.tag === bytes[0]);
  if (!instruction) {
    const known = idl.instructions.map((candidate) => candidate.tag);
    throw new RawLeError(`unknown instruction tag 0x${bytes[0].toString(16).padStart(2, '0')} (${known.length} known: ${known.join(', ')})`, null);
  }
  if (!Array.isArray(instruction.data)) {
    throw new RawLeError(`instruction ${JSON.stringify(instruction.name)} declares no field list — the interface publishes no layout for this tag`, instruction.name);
  }
  const types = idl.types ?? {};
  const reader = new Reader(bytes);
  reader.take(1, `${instruction.name}.tag`); // the tag dispatch byte, re-read below as a field
  reader.offset = 0;
  const args = {};
  const absent = [];
  const fieldValues = new Map();
  for (const field of instruction.data) {
    const fieldPath = `${instruction.name}.${field.name}`;
    const valueOrAbsent = readField(field, reader, types, fieldValues, fieldPath);
    if (valueOrAbsent === ABSENT) { absent.push(field.name); continue; }
    args[field.name] = valueOrAbsent;
    fieldValues.set(field.name, valueOrAbsent);
  }
  const trailingCount = reader.remaining;
  if (trailingCount > 0) {
    throw new RawLeError(
      `trailing bytes after ${instruction.name}: consumed ${reader.offset} of ${bytes.length}`, instruction.name);
  }
  return {
    kind: 'instruction',
    instruction: instruction.name,
    tag: bytes[0],
    args,
    absent,
    consumed: reader.offset,
    total: bytes.length,
    trailing: { count: trailingCount, hex: '' },
  };
}

const ABSENT = Symbol('absent');

function readField(field, reader, types, fieldValues, path) {
  // Optional fields are decided by the bytes: present exactly when the full
  // size fits the remainder to zero and the field is last.
  if (field.optional !== undefined) {
    const size = declaredFieldByteSize(field.type, types, fieldValues, path, reader.remaining);
    if (size === null || size !== reader.remaining) return ABSENT;
  }
  return readValue(field.type, reader, types, fieldValues, path);
}

function resolveType(type, types, path) {
  if (PRIMITIVE_SIZES[type]) return { kind: 'primitive', name: type };
  if (Object.prototype.hasOwnProperty.call(types, type)) return { kind: 'named', name: type };
  const match = ARRAY_SYNTAX.exec(type);
  if (match) return { kind: 'array', element: match[1], counter: match[2] };
  throw new RawLeError(`unsupported type ${JSON.stringify(type)}`, path);
}

function readValue(type, reader, types, fieldValues, path) {
  const resolved = resolveType(type, types, path);
  if (resolved.kind === 'primitive') {
    const slice = reader.take(PRIMITIVE_SIZES[resolved.name], path);
    return readInt(slice, SIGNED.has(resolved.name));
  }
  if (resolved.kind === 'named') {
    return readFields(types[resolved.name].fields, reader, types, path, {});
  }
  const countRaw = fieldValues.get(resolved.counter);
  const count = typeof countRaw === 'bigint' ? Number(countRaw) : countRaw;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RawLeError(`counter ${JSON.stringify(resolved.counter)} is not a usable count`, path);
  }
  const out = [];
  for (let index = 0; index < count; index++) {
    out.push(readValue(resolved.element, reader, types, fieldValues, `${path}[${index}]`));
  }
  return out;
}

function readFields(fields, reader, types, path, args) {
  const fieldValues = new Map();
  const absent = [];
  for (const field of fields) {
    const fieldPath = `${path}.${field.name}`;
    let value;
    if (field.optional !== undefined) {
      const size = declaredFieldByteSize(field.type, types, fieldValues, fieldPath, reader.remaining);
      value = size !== null && size === reader.remaining
        ? readValue(field.type, reader, types, fieldValues, fieldPath)
        : ABSENT;
    } else {
      value = readValue(field.type, reader, types, fieldValues, fieldPath);
    }
    if (value === ABSENT) { absent.push(field.name); continue; }
    args[field.name] = value;
    fieldValues.set(field.name, value);
  }
  args.absent = absent;
  return args;
}

// --- encode -----------------------------------------------------------------

const toBigInt = (value, path) => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new RawLeError(`expected an integer, got ${typeof value}`, path);
};

const writeInt = (size, signed, value, path) => {
  const bits = BigInt(size * 8);
  if (signed) {
    if (value < -(1n << (bits - 1n)) || value >= 1n << (bits - 1n)) {
      throw new RawLeError(`${value} out of range for ${size}-byte signed integer`, path);
    }
    if (value < 0n) value += 1n << bits;
  } else if (value < 0n || value >= 1n << bits) {
    throw new RawLeError(`${value} out of range for ${size}-byte unsigned integer`, path);
  }
  const out = Buffer.alloc(size);
  for (let index = 0; index < size; index++) { out[index] = Number(value & 0xffn); value >>= 8n; }
  return out;
};

/** Encode one instruction payload back to its exact wire bytes.
 * `absent` names optional fields to omit — same call shape as the codec's
 * own encodeInstructionData ({ absent: [...] }), and args.absent works too. */
export function encodeRawLe(idl, name, args, { absent } = {}) {
  const reason = rawLeDialectReason(idl);
  if (reason) throw new RawLeError(`not a raw-LE dialect this engine speaks: ${reason}`, null);
  const instruction = idl.instructions.find((candidate) => candidate.name === name);
  if (!instruction) throw new RawLeError(`unknown instruction ${JSON.stringify(name)}`, null);
  const types = idl.types ?? {};
  const parts = [];
  const fieldValues = new Map();
  const absentSet = new Set(Array.isArray(absent) ? absent : (Array.isArray(args?.absent) ? args.absent : []));
  for (const field of instruction.data) {
    const fieldPath = `${instruction.name}.${field.name}`;
    if (absentSet.has(field.name)) {
      if (field.optional === undefined) {
        throw new RawLeError(`field ${JSON.stringify(field.name)} is not optional — it cannot be absent`, fieldPath);
      }
      continue;
    }
    const value = args?.[field.name];
    if (value === undefined) throw new RawLeError(`missing argument ${JSON.stringify(field.name)}`, fieldPath);
    if (field.type === 'u8' && field.name === 'tag') {
      const tag = toBigInt(value, fieldPath);
      if (tag !== BigInt(instruction.tag)) throw new RawLeError(`tag value ${value} disagrees with the instruction tag ${instruction.tag}`, fieldPath);
      parts.push(Buffer.from([instruction.tag]));
      fieldValues.set(field.name, Number(tag));
      continue;
    }
    parts.push(encodeValue(field.type, value, types, fieldValues, fieldPath));
    fieldValues.set(field.name, value);
  }
  return Buffer.concat(parts);
}

function encodeValue(type, value, types, fieldValues, path) {
  const resolved = resolveType(type, types, path);
  if (resolved.kind === 'primitive') {
    return writeInt(PRIMITIVE_SIZES[resolved.name], SIGNED.has(resolved.name), toBigInt(value, path), path);
  }
  if (resolved.kind === 'named') {
    if (!isPlainObject(value)) throw new RawLeError(`expected an object for named type ${JSON.stringify(resolved.name)}`, path);
    const localValues = new Map();
    const parts = [];
    const absentSet = new Set(Array.isArray(value.absent) ? value.absent : []);
    for (const field of types[resolved.name].fields) {
      const fieldPath = `${path}.${field.name}`;
      if (absentSet.has(field.name)) {
        if (field.optional === undefined) throw new RawLeError(`field ${JSON.stringify(field.name)} is not optional`, fieldPath);
        continue;
      }
      if (value[field.name] === undefined) throw new RawLeError(`missing field ${JSON.stringify(field.name)} of ${resolved.name}`, fieldPath);
      parts.push(encodeValue(field.type, value[field.name], types, localValues, fieldPath));
      localValues.set(field.name, value[field.name]);
    }
    return Buffer.concat(parts);
  }
  if (!Array.isArray(value)) throw new RawLeError(`expected an array for ${JSON.stringify(type)}`, path);
  const declaredCount = fieldValues.get(resolved.counter);
  const count = typeof declaredCount === 'bigint' ? Number(declaredCount) : declaredCount;
  if (value.length !== count) {
    throw new RawLeError(`array of ${value.length} item(s) contradicts counter ${JSON.stringify(resolved.counter)}=${count}`, path);
  }
  return Buffer.concat(value.map((item, index) => encodeValue(resolved.element, item, types, fieldValues, `${path}[${index}]`)));
}

// The byte size a field occupies when it is fixed-size; null when the size
// depends on runtime counts (arrays, and named types containing them) —
// the optional-field presence check only fires for fixed-size fields, so
// 'u8[n_hops]'-style shapes never pretend to be optional-sized.
function declaredFieldByteSize(type, types, fieldValues, path, max) {
  const resolved = resolveType(type, types, path);
  if (resolved.kind === 'primitive') return PRIMITIVE_SIZES[resolved.name];
  if (resolved.kind === 'named') {
    let total = 0;
    for (const field of types[resolved.name].fields) {
      const size = declaredFieldByteSize(field.type, types, fieldValues, `${path}.${field.name}`, max);
      if (size === null) return null;
      total += size;
    }
    return total;
  }
  return null;
}

export { RawLeError };
