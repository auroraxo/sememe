#!/usr/bin/env node
// tools/hadro-count-header-probe.mjs — ONE byte-identical probe, two trees.
//
// Answers the SAME question in the pre-fix tree and in the fixed tree:
// "what does the product do with the 144 committed HADRo setCurve /
// setRiskCurve payloads?"
//
// The probe lives in ONE file, copied byte-identically into both trees, so
// the two answers differ ONLY by the product code — never by the question.
// It imports the tree's OWN src/decode.mjs, so the prefix tree answers with
// the prefix codec and the fixed tree answers with the fixed codec.
//
// It writes its answer as JSON on stdout and nothing else.
//
// Usage: node tools/hadro-count-header-probe.mjs [--store <dir>]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};

const STORE = path.resolve(flag('--store', path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11')));
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const HADRO = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';

const { decodeUnionPayload } = await import(path.join(ROOT, 'src', 'decode.mjs'));

const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const payloads = [];
for (const tx of sample.transactions ?? []) {
  for (const payload of tx.payloads ?? []) {
    if (payload.program !== HADRO) continue;
    const hex = payload.dataHex;
    if (!hex.startsWith('04') && !hex.startsWith('08')) continue;
    payloads.push({
      hex,
      signature: tx.signature,
      slot: tx.slot,
      accepted: tx.failed === false,
      instruction: hex.startsWith('04') ? 'setCurve' : 'setRiskCurve',
      headerCount: Buffer.from(hex, 'hex')[4],
    });
  }
}

const face = {
  total: payloads.length,
  decoded: 0,
  refused: 0,
  byteExact: 0,
  describedByteExact: 0,
  pointsDecoded: 0,
  emptyPoints: 0,
  pointsMatchHeaderCount: 0,
  pointsMismatchHeaderCount: 0,
  refusalReasons: {},
  refusalInstruction: {},
  trailingBytes: {},
  examples: {},
};

for (const payload of payloads) {
  try {
    const out = await decodeUnionPayload(STORE, HADRO, payload.hex, {});
    face.decoded += 1;
    if (out.roundTripByteExact) face.byteExact += 1;
    if (out.describedRoundTripByteExact) face.describedByteExact += 1;
    const points = out.args?.points;
    const length = Array.isArray(points) ? points.length : -1;
    face.pointsDecoded += Math.max(0, length);
    if (length === 0) face.emptyPoints += 1;
    if (length === payload.headerCount) face.pointsMatchHeaderCount += 1;
    else face.pointsMismatchHeaderCount += 1;
    const trailing = out.trailing?.count ?? 0;
    face.trailingBytes[trailing] = (face.trailingBytes[trailing] ?? 0) + 1;
    if (!face.examples.decoded) {
      face.examples.decoded = {
        signature: payload.signature,
        slot: payload.slot,
        instruction: payload.instruction,
        headerCount: payload.headerCount,
        points: length,
        trailingBytes: trailing,
        roundTripByteExact: out.roundTripByteExact ?? null,
        describedRoundTripByteExact: out.describedRoundTripByteExact ?? null,
      };
    }
  } catch (error) {
    face.refused += 1;
    const message = String(error?.message ?? error);
    const family = /vector length \d+ needs \d+ byte\(s\)/.test(message)
      ? 'vector length <n> needs <n> byte(s)'
      : /no length prefix on the wire/.test(message)
        ? 'no length prefix on the wire'
        : 'other';
    face.refusalReasons[family] = (face.refusalReasons[family] ?? 0) + 1;
    const instruction = /([A-Za-z0-9_]+)\.points:/.exec(message)?.[1]
      ?? /decode refused by the only stored source/.test(message) ? 'unknown' : 'unknown';
    face.refusalInstruction[instruction] = (face.refusalInstruction[instruction] ?? 0) + 1;
    if (!face.examples.refusal) {
      face.examples.refusal = { signature: payload.signature, slot: payload.slot, message };
    }
  }
}

process.stdout.write(JSON.stringify(face, null, 2) + '\n');
