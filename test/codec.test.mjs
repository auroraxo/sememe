import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  decodeInstructionData, encodeInstructionData, decodeType, toJsonSafe, CodecError,
} from '../src/codec.mjs';

const b58 = (s) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
};

// The real Whirlpool on-chain IDL, pulled by `sememe pull` (receipt in the
// store). Used by the decode tests so they exercise production data, not a
// hand-written stand-in. Skipped when the store is absent (fresh checkout CI).
const STORE = process.env.SEMEME_TEST_STORE
  ?? path.join(os.tmpdir(), 'sememe-user-zero');
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
async function whirlpoolIdl() {
  const receipts = await (await import('node:fs/promises')).readdir(path.join(STORE, 'receipts'))
    .catch(() => []);
  const mine = receipts.filter((name) => name.startsWith(`${WHIRLPOOL}-`)).sort().pop();
  if (!mine) return null;
  const receipt = JSON.parse(await readFile(path.join(STORE, 'receipts', mine), 'utf8'));
  const fingerprint = receipt.fingerprint.replace('sha256:', '');
  return JSON.parse(await readFile(path.join(STORE, 'objects', `${fingerprint}.json`), 'utf8'));
}
const idl = await whirlpoolIdl();

const synthetic = {
  instructions: [
    { name: 'alpha', discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
      args: [
        { name: 'count', type: 'u16' },
        { name: 'flag', type: 'bool' },
        { name: 'who', type: 'pubkey' },
        { name: 'maybe', type: { option: 'u64' } },
        { name: 'tags', type: { vec: 'u8' } },
        { name: 'grid', type: { array: ['i32', 3] } },
        { name: 'box', type: { defined: { name: 'Payload' } } },
        { name: 'mode', type: { defined: { name: 'Mode' } } },
        { name: 'blob', type: 'string' },
      ] },
    { name: 'legacy_tag', discriminator: [9], args: [] },
  ],
  types: [
    { name: 'Payload', type: { kind: 'struct', fields: [
      { name: 'a', type: 'u64' },
      { name: 'b', type: { option: { defined: { name: 'Pair' } } } },
    ] } },
    { name: 'Pair', type: { kind: 'struct', fields: [
      { name: 'x', type: 'i128' }, { name: 'y', type: 'i128' },
    ] } },
    { name: 'Mode', type: { kind: 'enum', variants: [
      { name: 'Idle' }, { name: 'Busy', fields: ['u8', 'bool'] },
      { name: 'Tagged', fields: [{ name: 'label', type: 'u16' }] },
    ] } },
  ],
};

test('round-trips every argument kind through encode then decode', () => {
  const args = {
    count: 65_535, flag: true,
    who: '11111111111111111111111111111111',
    maybe: { __option: 'Some', value: 42n },
    tags: [7, 8, 9],
    grid: [-1, 0, 2_147_483_647],
    box: { a: 1n, b: { __option: 'Some', value: { x: -5n, y: 6n } } },
    mode: { __kind: 'Busy', fields: [3, false] },
    blob: 'hällo',
  };
  const bytes = encodeInstructionData(synthetic, 'alpha', args);
  const decoded = decodeInstructionData(synthetic, bytes);
  assert.equal(decoded.instruction, 'alpha');
  assert.equal(decoded.discriminator, '0102030405060708');
  assert.deepEqual(toJsonSafe(decoded.args), toJsonSafe(args));
  // and the byte layout is stable: re-encoding the decoded value is a fixed point
  assert.deepEqual(encodeInstructionData(synthetic, 'alpha', decoded.args), bytes);
});

test('option None encodes a single zero tag and enum unit variants one byte', () => {
  const args = {
    count: 1, flag: false, who: '11111111111111111111111111111111',
    maybe: { __option: 'None' }, tags: [], grid: [0, 0, 0],
    box: { a: 0n, b: { __option: 'None' } }, mode: { __kind: 'Idle' }, blob: '',
  };
  const bytes = encodeInstructionData(synthetic, 'alpha', args);
  const decoded = decodeInstructionData(synthetic, bytes);
  assert.deepEqual(toJsonSafe(decoded.args.mode), { __kind: 'Idle' });
  assert.deepEqual(toJsonSafe(decoded.args.maybe), { __option: 'None' });
});

test('rejects malformed bytes instead of guessing', () => {
  const good = {
    count: 1, flag: false, who: '11111111111111111111111111111111',
    maybe: { __option: 'None' }, tags: [], grid: [0, 0, 0],
    box: { a: 0n, b: { __option: 'None' } }, mode: { __kind: 'Idle' }, blob: '',
  };
  const base = encodeInstructionData(synthetic, 'alpha', good);
  // layout: disc(8) count(2) flag(1) who(32) maybe-tag(1) ... => tag at 8+2+1+32
  const tagAt = 8 + 2 + 1 + 32;
  assert.equal(base[tagAt], 0);
  // 1. unknown discriminator
  const foreign = Buffer.from(base);
  foreign[0] = 0xff;
  assert.throws(() => decodeInstructionData(synthetic, foreign), /unknown instruction discriminator/);
  // 2. trailing bytes
  assert.throws(() => decodeInstructionData(synthetic, Buffer.concat([base, Buffer.from([0])])),
    /trailing bytes/);
  assert.doesNotThrow(() => decodeInstructionData(synthetic,
    Buffer.concat([base, Buffer.from([0])]), { allowTrailing: true }));
  // 3. truncated input
  assert.throws(() => decodeInstructionData(synthetic, base.subarray(0, base.length - 1)), /truncated/);
  // 4. invalid option tag (0/1 only)
  const badTag = Buffer.from(base);
  badTag[tagAt] = 9;
  assert.throws(() => decodeInstructionData(synthetic, badTag), /invalid option tag 9/);
});

test('rejects invalid bool byte, unknown enum index and out-of-range numbers', () => {
  const good = {
    count: 5, flag: true, who: '11111111111111111111111111111111',
    maybe: { __option: 'None' }, tags: [], grid: [0, 0, 0],
    box: { a: 0n, b: { __option: 'None' } }, mode: { __kind: 'Idle' }, blob: '',
  };
  const goodBytes = encodeInstructionData(synthetic, 'alpha', good);
  const badBool = Buffer.from(goodBytes);
  badBool[8 + 2] = 2; // disc(8) + count(2) => flag byte
  assert.throws(() => decodeInstructionData(synthetic, badBool), /invalid bool byte 2/);

  const badEnum = Buffer.from(goodBytes);
  // disc(8) count(2) flag(1) who(32) maybe(1) tags(4) grid(12) box(8+1) => mode index
  const modeAt = 8 + 2 + 1 + 32 + 1 + 4 + 12 + 8 + 1;
  badEnum[modeAt] = 7;
  assert.throws(() => decodeInstructionData(synthetic, badEnum), /unknown variant index 7/);

  assert.throws(() => encodeInstructionData(synthetic, 'alpha', { ...good, count: 65_536 }),
    /out of range for 2-byte unsigned integer/);
  assert.throws(() => encodeInstructionData(synthetic, 'alpha', { ...good, blob: { not: 'a string' } }),
    /expected a string/);
});

test('hostile argument names never pollute prototypes', () => {
  // __proto__ as an IDL field name must land as a plain own property (or be
  // rejected) and must never rewrite Object.prototype.
  const hostile = {
    instructions: [{ name: 'evil', discriminator: [9, 9], args: [{ name: '__proto__', type: 'u8' }] }],
  };
  const decoded = decodeInstructionData(hostile, Buffer.from([9, 9, 1]));
  assert.equal(Object.getPrototypeOf(decoded.args), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(toJsonSafe(decoded.args), { __proto__: 1 });
  // representation keys are still rejected outright
  const repr = {
    instructions: [{ name: 'ev2', discriminator: [8, 8], args: [{ name: '__kind', type: 'u8' }] }],
  };
  assert.throws(() => decodeInstructionData(repr, Buffer.from([8, 8, 1])),
    /collides with the decoded representation/);
});

test('legacy one-byte discriminators and legacy defined/array type spellings', () => {
  const bytes = encodeInstructionData(synthetic, 'legacy_tag', {});
  assert.deepEqual(bytes, Buffer.from([9]));
  const legacy = {
    instructions: [{ name: 'go', discriminator: [4, 4], args: [
      { name: 'who', type: 'publicKey' },
      { name: 'mask', type: ['u8', 2] },
      { name: 'inner', type: { defined: 'Payload' } },
    ] }],
    types: synthetic.types,
  };
  const payload = encodeInstructionData(legacy, 'go', {
    who: '11111111111111111111111111111111', mask: [1, 2],
    inner: { a: 3n, b: { __option: 'None' } },
  });
  const decoded = decodeInstructionData(legacy, payload);
  assert.equal(decoded.args.who, '11111111111111111111111111111111');
  assert.deepEqual(decoded.args.mask, [1, 2]);
  assert.equal(decoded.args.inner.a, 3n);
});

test('unknown instruction, unknown type and unknown argument are hard errors', () => {
  assert.throws(() => encodeInstructionData(synthetic, 'nope', {}), /unknown instruction "nope"/);
  assert.throws(() => encodeInstructionData(synthetic, 'alpha', { count: 1 }), /missing argument/);
  const hole = { instructions: [{ name: 'h', discriminator: [1], args: [{ name: 'x', type: { defined: { name: 'Ghost' } } }] }] };
  assert.throws(() => decodeInstructionData(hole, Buffer.from([1, 0])), /unknown defined type "Ghost"/);
  assert.throws(() => decodeInstructionData(synthetic, Buffer.from([1, 2])), /unknown instruction discriminator/);
});

test('decodeType enforces exact consumption for standalone values', () => {
  const ctx = undefined;
  const value = decodeType({ option: 'u16' }, Buffer.from([1, 7, 0]), ctx, 'v');
  assert.deepEqual(value.value, { __option: 'Some', value: 7 });
  assert.equal(value.consumed, 3);
  assert.throws(() => decodeType({ option: 'u16' }, Buffer.from([1, 7, 0, 9]), ctx, 'v'), /trailing bytes/);
});

test('whirlpool on-chain IDL: discriminators are unique and decodable', { skip: !idl }, () => {
  const seen = new Set();
  for (const instruction of idl.instructions) {
    const key = Buffer.from(instruction.discriminator).toString('hex');
    assert.ok(!seen.has(key), `duplicate discriminator ${key}`);
    seen.add(key);
    assert.match(instruction.name, /^[a-z0-9_]+$/);
  }
  assert.ok(idl.instructions.length >= 60, `expected 66, got ${idl.instructions.length}`);
});

test('whirlpool on-chain IDL: synthetic encode->decode round trip for every instruction', { skip: !idl }, () => {
  // Build a value from the type shape with small deterministic seeds so the
  // test is reproducible; this exercises every instruction's layout.
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const sample = (type, depth = 0) => {
    if (depth > 8) return 0;
    if (typeof type === 'string') {
      switch (type) {
        case 'bool': return (rand() & 1) === 1;
        case 'pubkey': return '11111111111111111111111111111111';
        case 'string': return 'x';
        case 'bytes': return Buffer.from([1, 2]).toString('base64');
        case 'f32': case 'f64': return 1.5;
        case 'u8': return rand() & 0xff;
        case 'u16': return rand() & 0xffff;
        case 'u32': return rand() & 0xffffffff;
        case 'u64': return BigInt(rand());
        case 'u128': return BigInt(rand()) << 64n | BigInt(rand());
        case 'i8': case 'i16': case 'i32': { const magnitude = rand() & 0x7f; return magnitude === 0 ? 0 : -magnitude; }
        case 'i64': case 'i128': return -BigInt(rand());
        default: throw new Error(`unhandled primitive ${type}`);
      }
    }
    if (Array.isArray(type)) return Array.from({ length: type[1] }, () => sample(type[0], depth + 1));
    if ('option' in type) {
      if ((rand() & 1) === 0) return { __option: 'None' };
      return { __option: 'Some', value: sample(type.option, depth + 1) };
    }
    if ('vec' in type) return Array.from({ length: rand() % 3 }, () => sample(type.vec, depth + 1));
    if ('array' in type) {
      const [inner, length] = type.array;
      return Array.from({ length }, () => sample(inner, depth + 1));
    }
    if ('defined' in type) {
      const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
      const typedef = idl.types.find((entry) => entry.name === name);
      return sample(typedef.type, depth + 1);
    }
    if (type.kind === 'type') return sample(type.type, depth + 1);
    if (type.kind === 'struct' || (type.fields && !type.kind)) {
      const out = {};
      for (const field of type.fields) out[field.name] = sample(field.type, depth + 1);
      return out;
    }
    if (type.kind === 'enum' || type.variants) {
      const variant = type.variants[rand() % type.variants.length];
      const out = { __kind: variant.name };
      if (variant.fields) {
        if (typeof variant.fields[0] === 'string' || (variant.fields[0] && !('name' in variant.fields[0]))) {
          out.fields = variant.fields.map((f) => sample(f, depth + 1));
        } else {
          for (const field of variant.fields) out[field.name] = sample(field.type, depth + 1);
        }
      }
      return out;
    }
    if (type.kind === 'type') return sample(type.type, depth + 1);
    throw new Error(`unhandled type ${JSON.stringify(type).slice(0, 80)}`);
  };

  let checked = 0;
  for (const instruction of idl.instructions) {
    const args = {};
    for (const argument of instruction.args ?? []) args[argument.name] = sample(argument.type);
    const bytes = encodeInstructionData(idl, instruction.name, args);
    const decoded = decodeInstructionData(idl, bytes);
    assert.equal(decoded.instruction, instruction.name);
    assert.equal(decoded.consumed, bytes.length);
    assert.deepEqual(toJsonSafe(decoded.args), toJsonSafe(args),
      `round trip mismatch for ${instruction.name}`);
    checked++;
  }
  assert.ok(checked >= 60, `expected to exercise 66 instructions, did ${checked}`);
});
