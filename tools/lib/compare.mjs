// Shared IDL-aware comparison between sememe's decode and an external oracle.
//
// Extracted from tools/crosscheck.mjs so that every tool that asks "do two
// decoders agree on these bytes?" answers that question with the SAME rules.
// The known representation gaps between the libraries are handled explicitly
// here instead of being ignored by each caller:
//   - oracle field names are camelCase, the on-chain IDL is snake_case
//   - oracle hoists single-field struct arguments into the parent object
//   - oracle decodes unit-variant enums to a raw variant index
// Anything that is not one of those three is reported as a mismatch.

export const camel = (text) => text.replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase());
export const pick = (object, name) => (object?.[name] !== undefined ? object[name] : object?.[camel(name)]);
export const structShape = (type) => (type && typeof type === 'object' && Array.isArray(type.fields)
  && (type.kind === 'struct' || type.kind === undefined)) ? type.fields : null;
export const enumShape = (type) => (type && typeof type === 'object' && Array.isArray(type.variants)
  && (type.kind === 'enum' || type.kind === undefined)) ? type.variants : null;
export const variantShape = (variant) => {
  const fields = variant?.fields;
  if (!fields || !fields.length) return { kind: 'unit' };
  if (fields.every((field) => field && typeof field === 'object' && typeof field.name === 'string' && 'type' in field)) {
    return { kind: 'named', fields };
  }
  return { kind: 'tuple', fields };
};

/**
 * Build a comparator bound to one IDL and one oracle module.
 * `oracleRequire` is the require function the caller used to load the oracle,
 * needed to resolve @solana/kit addresses when the oracle hands back Uint8Array.
 *
 * Returns `compare(instruction, mine, theirs)` which appends any field-level
 * disagreement to the shared `diffs` array and returns them.
 */
export function createComparator({ idl, oracle, oracleRequire, program = null }) {
  const typeByName = new Map((idl.types ?? []).map((entry) => [entry.name, entry.type]));
  const diffs = [];

  const equal = (location, mine, theirs) => {
    const a = typeof mine === 'bigint' ? mine.toString() : mine;
    const b = typeof theirs === 'bigint' ? theirs.toString() : theirs;
    if (Object.is(a, b)) return true;
    if (typeof a === 'number' && typeof b === 'number' && Object.is(a, -0) && Object.is(b, 0)) return true;
    diffs.push({ path: location, sememe: String(a).slice(0, 160), oracle: String(b).slice(0, 160) });
    return false;
  };

  function same(type, mine, theirs, location) {
    if (typeof type === 'string') {
      if (type === 'pubkey') {
        let value = theirs;
        if (value instanceof Uint8Array) {
          try { value = new oracleRequire('@solana/kit').Address(value); } catch { value = Buffer.from(value).toString('hex'); }
        }
        return equal(location, mine, String(value));
      }
      if (type === 'bool') return equal(location, mine, theirs === true || theirs === 1);
      return equal(location, mine, theirs);
    }
    if (Array.isArray(type)) {
      if (!Array.isArray(theirs)) return equal(location, 'array', typeof theirs);
      if (mine.length !== theirs.length) { diffs.push({ path: location, reason: `length ${mine.length} vs ${theirs.length}` }); return false; }
      return mine.every((item, index) => same(type[0], item, theirs[index], `${location}[${index}]`));
    }
    if ('option' in type) {
      if (!theirs || !('__option' in theirs)) return equal(location, 'option', JSON.stringify(theirs)?.slice(0, 80));
      if (mine.__option !== theirs.__option) return equal(location, mine.__option, theirs.__option);
      if (mine.__option === 'None') return true;
      return same(type.option, mine.value, theirs.value, `${location}.value`);
    }
    if ('vec' in type) {
      if (!Array.isArray(theirs)) return equal(location, 'vec', typeof theirs);
      if (mine.length !== theirs.length) { diffs.push({ path: location, reason: `vec length ${mine.length} vs ${theirs.length}` }); return false; }
      return mine.every((item, index) => same(type.vec, item, theirs[index], `${location}[${index}]`));
    }
    if ('array' in type) {
      const [inner] = type.array;
      if (!Array.isArray(theirs)) return equal(location, 'array', typeof theirs);
      if (mine.length !== theirs.length) { diffs.push({ path: location, reason: `array length ${mine.length} vs ${theirs.length}` }); return false; }
      return mine.every((item, index) => same(inner, item, theirs[index], `${location}[${index}]`));
    }
    if ('defined' in type) {
      const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
      return same(typeByName.get(name), mine, theirs, name);
    }
    if (type.kind === 'type') return same(type.type, mine, theirs, location);
    const fields = structShape(type);
    if (fields) {
      if (!theirs || typeof theirs !== 'object') return equal(location, 'struct', typeof theirs);
      return fields.every((field) => {
        const value = pick(theirs, field.name);
        if (value === undefined) { diffs.push({ path: `${location}.${field.name}`, reason: 'missing in oracle output' }); return false; }
        return same(field.type, mine[field.name], value, `${location}.${field.name}`);
      });
    }
    const variants = enumShape(type);
    if (variants) {
      if (typeof theirs === 'number') {
        const variant = variants[theirs];
        if (!variant) return equal(location, mine.__kind, `index ${theirs}`);
        return equal(location, mine.__kind, variant.name);
      }
      if (!theirs || typeof theirs !== 'object') return equal(location, 'enum', JSON.stringify(theirs)?.slice(0, 80));
      if (mine.__kind !== theirs.__kind) return equal(location, mine.__kind, theirs.__kind);
      const shape = variantShape(variants.find((variant) => variant.name === mine.__kind));
      if (shape.kind === 'unit') return true;
      if (shape.kind === 'tuple') {
        return mine.fields.every((item, index) => same(shape.fields[index], item, theirs.fields?.[index], `${location}.fields[${index}]`));
      }
      return shape.fields.every((field) => {
        const value = pick(theirs, field.name);
        if (value === undefined) { diffs.push({ path: `${location}.${field.name}`, reason: 'missing in oracle output' }); return false; }
        return same(field.type, mine[field.name], value, `${location}.${field.name}`);
      });
    }
    return equal(location, JSON.stringify(mine)?.slice(0, 120), JSON.stringify(theirs)?.slice(0, 120));
  }

  /** Compare every IDL argument of one instruction; returns the new diffs. */
  function compare(instruction, mine, theirs) {
    const before = diffs.length;
    for (const argument of instruction.args ?? []) {
      const argumentType = (typeof argument.type === 'object' && argument.type.defined)
        ? typeByName.get(argument.type.defined.name) : argument.type;
      let target = pick(theirs, argument.name);
      if (target === undefined) {
        const shape = structShape(argumentType);
        if (shape && shape.every((field) => pick(theirs, field.name) !== undefined)) target = theirs;
        else { diffs.push({ path: `${instruction.name}.${argument.name}`, reason: 'argument absent in oracle output' }); continue; }
      }
      same(argumentType, mine.args[argument.name], target, `${instruction.name}.${argument.name}`);
    }
    return diffs.splice(before);
  }

  return { compare, same, equal, typeByName, diffs, program };
}

/** Name an oracle codec pair for an IDL instruction: {encoder, decoder} or null. */
export function oracleCodecs(oracle, instructionName) {
  const oracleName = camel(instructionName);
  const prefix = `${oracleName[0].toUpperCase()}${oracleName.slice(1)}`;
  return {
    encoder: oracle[`get${prefix}InstructionDataEncoder`],
    decoder: oracle[`get${prefix}InstructionDataDecoder`],
  };
}
