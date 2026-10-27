import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { PublicKey } from '@solana/web3.js';
import { addresses, inspect, measure, METADATA_PROGRAM } from '../tools/measure.mjs';

const program = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const idl = { address: program, instructions: [{ name: 'swap', args: [] }] };
function legacyAccount(data = idl) {
  const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(data)));
  const header = Buffer.alloc(44); Buffer.from([24,70,98,191,58,144,123,158]).copy(header);
  header.writeUInt32LE(compressed.length, 40);
  return { owner: program, data: [Buffer.concat([header,compressed]).toString('base64'), 'base64'] };
}
test('metadata and legacy PDAs derive as distinct addresses', async () => {
  const { metadata, anchor } = await addresses(program);
  assert.notEqual(metadata, anchor);
  // Independently pinned in auroraxo/idl-drift/test/run.mjs.
  assert.equal(metadata, '9fQgUeE2BpGXLHopvZhDKTskXV2druezgX6hpmscbya5');
  assert.equal(anchor, '2KFqE4RWoPVbvodo8vbggCFeHPS8TDvgpwp79ALMrcyn');
  assert.equal(new PublicKey(metadata).toBytes().length, 32);
  assert.equal(new PublicKey(anchor).toBytes().length, 32);
});
test('usable legacy IDL needs correct owner, discriminator and instruction schema', () => {
  assert.equal(inspect(legacyAccount(), 'anchor', program).state, 'usable');
  assert.equal(inspect(null, 'anchor', program).state, 'missing');
  assert.equal(inspect({ ...legacyAccount(), owner: METADATA_PROGRAM.toBase58() }, 'anchor', program).state, 'wrong_owner');
  assert.equal(inspect(legacyAccount({ address: program, instructions: [] }), 'anchor', program).state, 'undecodable');
  const wrong = '11111111111111111111111111111111';
  assert.equal(inspect(legacyAccount({ address: wrong, instructions: [{ name: 'swap' }] }), 'anchor', program).state, 'undecodable');
});
test('pre-registration requires twenty unique programs', async () => {
  await assert.rejects(measure([], 'https://example.invalid'), /twenty|20/);
  await assert.rejects(measure(Array(20).fill({ id: program }), 'https://example.invalid'), /unique/);
});
test('RPC missing vs RPC error are different; not inferred as absence', async () => {
  const programs = Array.from({ length: 20 }, (_, i) => ({ id: new PublicKey(Buffer.alloc(32, i + 1)).toBase58(), name: `test${i + 1}`, source: 'fixture' }));
  const missing = async () => ({ ok: true, json: async () => ({ result: { context: { slot: 1 }, value: Array(40).fill(null) } }) });
  const rows = await measure(programs, 'https://example.invalid', missing);
  assert.deepEqual({ usable: rows.usable, unknown: rows.unknown, notUsable: rows.notUsable }, { usable: 0, unknown: 0, notUsable: 20 });
  assert.match(rows.interpretation, /below 50%/);
  const failing = async () => { throw Error('offline'); };
  // Test a deterministic fail-fast error by letting the retry loop run with 3 attempts;
  // does not fabricate negative coverage from unavailable RPC.
  const errors = await measure(programs, 'https://example.invalid', failing, { tries: 1 });
  assert.equal(errors.notUsable, 0); assert.equal(errors.unknown, 20);
  assert.match(errors.interpretation, /incomplete/);
});
