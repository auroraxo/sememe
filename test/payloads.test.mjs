import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { extractPayloads, toHex, accountKeyList, programIdOf } from '../tools/lib/payloads.mjs';

const TARGET = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const OTHER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// base58 of arbitrary bytes, computed with the repo's own codec so the test
// does not depend on a third-party encoder.
function encode58(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (value > 0n) { out = A[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte === 0) out = `1${out}`; else break; }
  return out;
}

test('base58 instruction data becomes hex with the same bytes', () => {
  const bytes = Buffer.from([0x01, 0xb6, 0x87, 0x3b, 0x9b, 0x19, 0x63, 0xdf]);
  const roundTrip = toHex(encode58(bytes));
  assert.equal(roundTrip, bytes.toString('hex'));
  // A payload the IDL describes as 43 bytes plus trailing zeros must keep
  // every byte: losing them would hide the unexplained-bytes finding.
  const long = Buffer.alloc(50, 0);
  long[0] = 0x02;
  assert.equal(toHex(encode58(long)), long.toString('hex'));
  assert.equal(toHex(undefined), '');
  assert.equal(toHex(''), '');
});

test('a transaction that never invokes the target yields no payloads', () => {
  const tx = {
    transaction: {
      message: {
        instructions: [{ programId: OTHER, data: encode58(Buffer.from([9, 9])) }],
        innerInstructions: [{ index: 0, depth: 1, instructions: [{ programId: OTHER, data: encode58(Buffer.from([7])) }] }],
      },
    },
  };
  assert.deepEqual(extractPayloads(tx, TARGET), []);
  assert.deepEqual(extractPayloads({}, TARGET), []);
  assert.deepEqual(extractPayloads({ transaction: { message: {} } }, TARGET), []);
});

test('top-level AND CPI instructions of the target are collected', () => {
  const topBytes = Buffer.from('2b04ed0b1ac91e620736', 'hex');
  const cpiBytes = Buffer.from('a498cf631eba13b6', 'hex');
  const tx = {
    transaction: {
      message: {
        instructions: [
          { programId: OTHER, data: encode58(Buffer.from([1])) },
          { programId: TARGET, data: encode58(topBytes) },
          { programId: OTHER, data: encode58(Buffer.from([2])) },
        ],
        innerInstructions: [
          { index: 1, depth: 1, instructions: [{ programId: OTHER, data: encode58(Buffer.from([3])) }] },
          { index: 1, depth: 1, instructions: [{ programId: TARGET, data: encode58(cpiBytes) }] },
        ],
      },
    },
  };
  const payloads = extractPayloads(tx, TARGET);
  assert.equal(payloads.length, 2, 'a CPI into the target must not be dropped');

  const [top, cpi] = payloads;
  assert.equal(top.depth, 0);
  assert.equal(top.dataHex, topBytes.toString('hex'));
  assert.equal(top.dataBase58, encode58(topBytes));
  assert.equal(cpi.depth, 1, 'CPI payloads are marked so depth is auditable');
  assert.equal(cpi.ix, 1);
  assert.equal(cpi.dataHex, cpiBytes.toString('hex'));
});

test('an instruction with empty data is recorded, not silently skipped', () => {
  const tx = {
    transaction: {
      message: {
        instructions: [
          { programId: TARGET, data: '' },
          { programId: TARGET },
        ],
      },
    },
  };
  const payloads = extractPayloads(tx, TARGET);
  assert.equal(payloads.length, 2, 'a zero-length payload is still a payload');
  assert.equal(payloads[0].dataHex, '');
  assert.equal(payloads[1].dataHex, '');
});

// The real encoding:"json" shape. Instructions carry `programIdIndex`, not
// `programId`, and inner instructions live under `meta`. A harvester that
// reads `programId` and `message.innerInstructions` produces an EMPTY payload
// list here while still exiting 0 — that defect was found and fixed by
// checking against this shape.
test('encoding:json instructions resolve through programIdIndex', () => {
  const whirlData = Buffer.from('2b04ed0b1ac91e620736', 'hex');
  const tx = {
    transaction: {
      message: {
        // static keys only; lookup table entries are appended from meta
        accountKeys: ['FeePayer1111', 'StaticOther11'],
        instructions: [
          { programIdIndex: 1, accounts: [], data: encode58(Buffer.from([1])) },
          { programIdIndex: 0, accounts: [], data: encode58(Buffer.from([2])) },
        ],
      },
    },
    meta: {
      loadedAddresses: { writable: [TARGET], readonly: ['Readonly111'] },
      innerInstructions: [
        { index: 0, depth: 1, instructions: [{ programIdIndex: 2, data: encode58(whirlData) }] },
      ],
    },
  };

  const accounts = accountKeyList(tx);
  assert.deepEqual(accounts, ['FeePayer1111', 'StaticOther11', TARGET, 'Readonly111'],
    'account list must be static + loaded writable + loaded readonly');
  assert.equal(programIdOf(tx.transaction.message.instructions[0], accounts), 'StaticOther11');
  assert.equal(programIdOf({ programId: TARGET }, accounts), TARGET, 'explicit programId wins');

  const payloads = extractPayloads(tx, TARGET);
  assert.equal(payloads.length, 1, 'the CPI into the target must be found via programIdIndex');
  assert.equal(payloads[0].depth, 1);
  assert.equal(payloads[0].dataHex, whirlData.toString('hex'));
});

test('an out-of-range or missing programIdIndex resolves to null, not to a wrong program', () => {
  assert.equal(programIdOf({ programIdIndex: 99 }, ['a']), null);
  assert.equal(programIdOf({ programIdIndex: -1 }, ['a']), null);
  assert.equal(programIdOf({}, ['a']), null);
  assert.equal(programIdOf({ programIdIndex: 0 }, []), null);
  // Null must never be mistaken for the target, even if the target were empty.
  assert.equal(programIdOf({}, []), null);
});

test('a transaction whose account list is unresolvable yields no payloads', () => {
  const tx = {
    transaction: { message: { instructions: [{ programIdIndex: 0, data: encode58(Buffer.from([1])) }] } },
    meta: { innerInstructions: [] },
  };
  assert.deepEqual(accountKeyList(tx), [], 'no accountKeys means nothing is resolvable');
  assert.deepEqual(extractPayloads(tx, TARGET), [],
    'unresolvable must be treated as no payloads, never as a match');
});
