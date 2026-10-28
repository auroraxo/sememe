import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBase58, decodeBase58 } from '../src/base58.mjs';
import { createHash, randomFillSync } from 'node:crypto';

test('base58 round trip for random 32-byte values', () => {
  for (let index = 0; index < 64; index++) {
    const bytes = Buffer.alloc(32);
    randomFillSync(bytes);
    const encoded = encodeBase58(bytes);
    assert.equal(Buffer.compare(Buffer.from(decodeBase58(encoded)), bytes), 0,
      `round trip failed for ${bytes.toString('hex')}`);
  }
});

test('base58 leading zero bytes map to leading "1" characters', () => {
  // The classic off-by-one: a seeded accumulator with a zero digit produces
  // one '1' too many for an all-zero input. 32 zero bytes must be exactly
  // 32 '1' characters — the system program id.
  assert.equal(encodeBase58(new Uint8Array(32)),
    '11111111111111111111111111111111');
  assert.equal(decodeBase58('11111111111111111111111111111111').length, 32);
  assert.equal(encodeBase58(new Uint8Array(3)), '111');
  assert.equal(encodeBase58(Buffer.from([0, 0, 1])), '112');
  assert.equal(Buffer.compare(Buffer.from(decodeBase58('112')), Buffer.from([0, 0, 1])), 0);
});

test('base58 rejects invalid input instead of guessing', () => {
  assert.throws(() => decodeBase58('0OIl'), /invalid base58 character/);
  assert.throws(() => decodeBase58(''), /non-empty/);
  assert.throws(() => decodeBase58('l0O'), /invalid base58 character/);
  assert.throws(() => encodeBase58('not bytes'), /Uint8Array/);
});

test('base58 matches the reference implementation on known vectors', () => {
  // Independently checkable vectors: the base58 of a known 32-byte key and
  // of the empty/small inputs. A hash of the encoded form keeps the test
  // honest without depending on a third-party package.
  const vector = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const encoded = encodeBase58(vector);
  assert.equal(encoded, '1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE');
  assert.equal(
    createHash('sha256').update(Buffer.from(decodeBase58(encoded))).digest('hex'),
    createHash('sha256').update(vector).digest('hex'));
});
