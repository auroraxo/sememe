// Pin: test/live-layout-scan-measurement.test.mjs
//
// The card's standing next step 3 ("the three HADRo + CAMM only after our
// own chain witness") is now a LIVE measurement instead of an unavailable
// one. 13.11. PULS AG could not reach the chain (api.mainnet-beta answered
// 429 to every getTransaction); this pulse found the endpoint that answers
// (solana-rpc.publicnode.com) and measured the live windows:
//
//   HADRo (research/live-layout-scan-hadro-2026-11-14.json):
//     2000 pinned signatures, 2000 fetched, 0 missed, 3300 payloads, slots
//     469179697..469180764 pinned in the
//     artifact. The two RULE-TABLE instructions re-confirm on live traffic —
//     re-derived HERE, by re-running the analyzer (tools/lib/live-layout.mjs,
//     the same code the CLI runs) over the COMMITTED payload bytes:
//     setCurve|numPoints|points and setRiskCurve|numPoints|points carry
//     count-from-header for EVERY chain-accepted sampled payload.
//     The three UNWITNESSED shape-carrying instructions (updateSpreadConfig
//     0e, submitCurveUpdates 12, removeSpreadTriggers 1d): zero payloads in
//     the window.
//   CAMM (research/live-layout-scan-camm-2026-11-14.json):
//     1000 tx, live traffic is swap_v2 + swap only, discriminated at the
//     program's OWN 8-byte sighash length; update_operation_account
//     (7f467728bce33d07): zero payloads in the window.
//
// Verdicts: no-live-witness-in-window for both. A zero-payload window is a
// window, not an absence on chain — the limit is IN the artifact.
//
// FALSIFIERS (each turns a test red):
//   - the analyzer reading every discriminator as 1 byte mislabels CAMM's
//     8-byte sighashes;
//   - the analyzer forgetting pubkey / the array shape makes element sizes
//     unknown and the wired instructions stop re-confirming the rule;
//   - the analyzer swapping the count-from-header verdict for borsh-prefix
//     contradicts the committed bytes;
//   - tampering with any pinned count breaks a summary invariant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, loadTypes, typeSize } from '../tools/lib/live-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const readArtifact = (name) => JSON.parse(readFileSync(path.join(ROOT, 'research', name), 'utf8'));

const HADRO = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';
const CAMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

const hadro = readArtifact('live-layout-scan-hadro-2026-11-14.json');
const camm = readArtifact('live-layout-scan-camm-2026-11-14.json');

/** The committed IDL of one program, from the committed store. */
function committedIdl(address) {
  const store = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');
  const receipt = readdirSync(path.join(store, 'receipts')).find((n) => n.startsWith(`${address}-`));
  assert.ok(receipt, `committed receipt missing for ${address}`);
  const rc = JSON.parse(readFileSync(path.join(store, 'receipts', receipt), 'utf8'));
  const idl = JSON.parse(readFileSync(path.join(store, 'objects', `${rc.fingerprint.replace('sha256:', '')}.json`), 'utf8'));
  assert.equal(idl.address, address);
  return idl;
}

const hadroIdl = committedIdl(HADRO);
const cammIdl = committedIdl(CAMM);

test('the artifact names the tool and analyzer that produced it', () => {
  assert.equal(hadro.tool, 'tools/measure-live-layout-scan.mjs');
  assert.equal(hadro.analyzer, 'tools/lib/live-layout.mjs');
  assert.equal(camm.tool, 'tools/measure-live-layout-scan.mjs');
  assert.equal(hadro.program, HADRO);
  assert.equal(camm.program, CAMM);
  assert.match(hadro.rpc, /^https:\/\//);
});

test('the scanned window is pinned: signature lists match the counts', () => {
  for (const artifact of [hadro, camm]) {
    assert.ok(Number.isSafeInteger(artifact.scanned.signatures));
    assert.ok(Number.isSafeInteger(artifact.scanned.fetched));
    assert.equal(artifact.pinnedSignatures.length, artifact.scanned.signatures);
    assert.equal(artifact.scanned.missed, 0);
    assert.ok(artifact.scanned.payloads > 0);
    assert.ok(artifact.window.fromSlot < artifact.window.toSlot);
    assert.ok(artifact.payloadSample.length > 0);
    assert.ok(artifact.payloadSample.length <= 400);
  }
});

test('the committed payload sample reproduces the full-scan discriminator histogram', () => {
  for (const artifact of [hadro, camm]) {
    const idl = artifact.program === HADRO ? hadroIdl : cammIdl;
    const { byDiscriminator } = analyze(artifact.payloadSample, idl, loadTypes(idl));
    // The sample is a stride, so it may not reproduce exact COUNTS — but
    // every discriminator in the sample must be one the full scan recorded,
    // at the same resolved length, and the histogram must cover the same
    // discriminator set.
    const fullDisc = new Set(artifact.discriminatorList.map((d) => d.discriminator));
    const sampleDisc = new Set([...byDiscriminator.keys()]);
    for (const disc of sampleDisc) {
      assert.ok(fullDisc.has(disc),
        `sample discriminator ${disc} does not appear in the full-scan histogram`);
    }
    assert.equal(sampleDisc.size, fullDisc.size,
      'the sample must cover every discriminator the full scan found');
  }
});

// Re-run the analyzer over the committed payload bytes: the central layout
// claim must re-derive from the repository alone, without an RPC.
test('HADRo wired instructions re-confirm count-from-header from the COMMITTED BYTES', () => {
  const { perInstruction } = analyze(hadro.payloadSample, hadroIdl, loadTypes(hadroIdl));
  for (const name of ['setCurve', 'setRiskCurve']) {
    const entry = perInstruction.get(`${name}|numPoints|points`);
    assert.ok(entry, `${name} not measured from the committed sample`);
    assert.ok(entry.accepted > 0, `${name} has no chain-accepted payload in the committed sample`);
    // The analyzer counts a layout hypothesis per ACCEPTED payload only.
    const hypothesisTotal = Object.values(entry.hypotheses).reduce((sum, n) => sum + n, 0);
    assert.equal(hypothesisTotal, entry.accepted,
      `${name}: only chain-accepted payloads may carry the rule claim`);
    assert.deepEqual(entry.hypotheses, { 'count-from-header': entry.accepted },
      `${name}: the committed wire must carry the count in the header, not a Borsh prefix`);
    for (const example of entry.examples) {
      assert.equal(example.elementBytes, 21, `${name}: CurvePointInput is 21 bytes (u64+u64+u8+4xu8)`);
      assert.equal(example.trailingBytes, 8, `${name}: the measured 8-byte sequence tail`);
    }
  }
});

test("CAMM discriminators resolve at the program's OWN 8-byte length", () => {
  for (const disc of camm.discriminatorList) {
    assert.equal(disc.discriminator.length, 16,
      'CAMM stores 8-byte anchor sighashes; a 1-byte reading mislabels every payload');
  }
  const named = new Set(cammIdl.instructions.map((ix) => Buffer.from(ix.discriminator).toString('hex')));
  for (const disc of camm.discriminatorList) {
    assert.ok(named.has(disc.discriminator),
      `discriminator ${disc.discriminator} is not an instruction the committed IDL names`);
  }
});

test('the unwitnessed targets have zero payloads in their windows', () => {
  const hadroTargets = hadro.targets.witnessed.filter((t) => t.instruction !== 'update_operation_account');
  assert.equal(hadroTargets.length, 3);
  for (const t of hadroTargets) {
    assert.equal(t.witnessed, false);
    assert.equal(t.payloads, 0);
    assert.ok(!hadro.discriminatorList.some((d) => d.discriminator === t.discriminator));
  }
  const cammTarget = camm.targets.witnessed.find((t) => t.instruction === 'update_operation_account');
  assert.equal(cammTarget.witnessed, false);
  assert.ok(!camm.discriminatorList.some((d) => d.discriminator === cammTarget.discriminator));
  assert.equal(hadro.verdict, 'no-live-witness-in-window');
  assert.equal(camm.verdict, 'no-live-witness-in-window');
});

test('the discriminator histogram sums to the scanned payload count', () => {
  for (const artifact of [hadro, camm]) {
    const total = artifact.discriminatorList.reduce((sum, d) => sum + d.count, 0);
    assert.equal(total, artifact.scanned.payloads);
  }
});

test('the honest limit is stated in the artifact', () => {
  assert.ok(hadro.limits.some((l) => /window, not an absence/i.test(l)));
  assert.ok(camm.limits.some((l) => /window, not an absence/i.test(l)));
});

test('falsifier: tampering with a pinned count turns an invariant red', () => {
  const tampered = JSON.parse(JSON.stringify(hadro));
  tampered.scanned.payloads += 1;
  const totalsMatch = tampered.scanned.payloads === tampered.discriminatorList.reduce((sum, d) => sum + d.count, 0);
  assert.ok(!totalsMatch, 'a changed payload count must break the discriminator-sum invariant');

  const tamperedWindow = JSON.parse(JSON.stringify(hadro));
  tamperedWindow.window.fromSlot = tamperedWindow.window.toSlot;
  assert.ok(!(tamperedWindow.window.fromSlot < tamperedWindow.window.toSlot),
    'a collapsed window must break the range invariant');

  const tamperedSample = JSON.parse(JSON.stringify(hadro));
  tamperedSample.payloadSample = tamperedSample.payloadSample.filter((p) => !p.dataHex.startsWith('04'));
  const { byDiscriminator } = analyze(tamperedSample.payloadSample, hadroIdl, loadTypes(hadroIdl));
  assert.ok(!byDiscriminator.has('04'),
    'dropping the setCurve payloads must remove the discriminator from the derived histogram');
});

test('the element sizer agrees with the IDLs documented byte sizes', () => {
  // The IDL documents the wire size of each struct in its own `docs` (this
  // is the measurement's own evidence, not an external claim). A sizer that
  // forgets `pubkey` (32 bytes) or the Anchor array shape would report an
  // element size of null and silently decide NOTHING — the exact failure the
  // analyzer's whole point is to prevent.
  const documented = (idl, typeName) => {
    const t = idl.types.find((x) => x.name === typeName);
    return t;
  };
  const cases = [
    [hadroIdl, 'CurvePointInput', 21],
    [hadroIdl, 'SpreadTriggerInput', 66],
    [hadroIdl, 'SpreadTriggerKey', 64],
    [hadroIdl, 'CurveUpdateOp', 33],
  ];
  for (const [idl, typeName, expectedBytes] of cases) {
    const declared = documented(idl, typeName);
    assert.ok(declared, `${typeName} missing from the committed IDL`);
    const declaredBytes = Number((/\((\d+) bytes/.exec(declared.docs?.join(' ') ?? '') ?? [])[1]);
    assert.equal(declaredBytes, expectedBytes,
      `${typeName}: the IDL documents ${declaredBytes} bytes`);
    assert.equal(typeSize({ defined: { name: typeName } }, loadTypes(idl)), expectedBytes,
      `${typeName}: the analyzer's sizer must agree with the IDL's own documented byte size`);
  }
});
