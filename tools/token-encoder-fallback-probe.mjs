#!/usr/bin/env node
// token-encoder-fallback-probe.mjs — run in ANY tree of this repository and
// report, as JSON, whether the token API's encoder can reproduce the names
// its own decoder and name list claim.
//
// Copied byte-identically into both trees by
// tools/measure-token-encoder-fallback.mjs (house pattern, same as the HADRo
// count-from-header probe), so the only thing that differs between the two
// runs is src/ under test.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const METADATA_NAMES = ['Initialize', 'UpdateField', 'RemoveKey', 'UpdateAuthority', 'Emit'];

// The 4 chain-witnessed payloads from research/token-metadata-oracle-2026-11-03.json.
const ORACLE_HEX = [
  'd2e11ea258b84d8d09000000617474656e74696f6e030000006174745000000068747470733a2f2f697066732e696f2f697066732f6261666b726569613273696535346a796e65333371783769767878626e6f68716e683273746b647662706974717867787966347a7a676467673734',
  'd2e11ea258b84d8d0600000043484152434f0600000043484152434f5000000068747470733a2f2f697066732e696f2f697066732f6261666b726569656f343379666d62676866696d6a33346f36737261746b76796f77786e3435346767713270693379717534776d346b35776c3469',
  'd2e11ea258b84d8d0a00000063686172636f2e66756e0600000043484152434f5000000068747470733a2f2f697066732e696f2f697066732f6261666b72656963696a376d76346d6172766d707069746771716e65366b767a63626f72703533736870707a77366b71677a78337a357865656134',
  'd7e4a6e45464567b0000000000000000000000000000000000000000000000000000000000000000',
];

async function main() {
  const t = await import(path.join(ROOT, 'src', 'token.mjs'));
  const m = await import(path.join(ROOT, 'src', 'token-metadata.mjs'));

  const names = t.tokenNames(TOKEN_2022);
  const metadataNames = m.tokenMetadataNames();

  // Face 1: every advertised name, encoded with {} — unknown-variant is the
  // defect; missing-arg is a SHAPE refusal (the name IS known); no throw is
  // a name with all-optional args.
  const encodeOutcomes = {};
  const unknownVariantNames = [];
  for (const name of names) {
    try {
      t.encodeTokenInstruction(TOKEN_2022, name, {});
      encodeOutcomes[name] = 'encoded';
    } catch (error) {
      encodeOutcomes[name] = String(error.reason ?? error.message);
      if (encodeOutcomes[name] === 'unknown-variant') unknownVariantNames.push(name);
    }
  }

  // Face 2: the committed mainnet metadata payloads, decode -> re-encode
  // through the TOKEN API (not the fallback's own encoder).
  const sample = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json'), 'utf8'));
  const fixture = { total: 0, reencoded: 0, refused: {} };
  for (const tx of sample.transactions ?? []) {
    for (const payload of tx.payloads ?? []) {
      if (payload.program !== TOKEN_2022) continue;
      const bytes = Buffer.from(payload.dataHex, 'hex');
      let decoded;
      try {
        decoded = t.decodeTokenInstruction(TOKEN_2022, bytes, { trailing: 'report' });
      } catch { continue; }
      if (decoded.scheme !== 'native-token-metadata') continue;
      fixture.total += 1;
      try {
        const re = t.encodeTokenInstruction(TOKEN_2022, decoded.name, decoded.args);
        if (re.equals(bytes)) fixture.reencoded += 1;
        else fixture.refused['not-byte-exact'] = (fixture.refused['not-byte-exact'] ?? 0) + 1;
      } catch (error) {
        const reason = String(error.reason ?? error.message);
        fixture.refused[reason] = (fixture.refused[reason] ?? 0) + 1;
      }
    }
  }

  // Face 3: the chain-witnessed oracle payloads, same round trip.
  const oracle = { total: ORACLE_HEX.length, reencoded: 0, refused: {} };
  for (const hex of ORACLE_HEX) {
    const bytes = Buffer.from(hex, 'hex');
    const decoded = t.decodeTokenInstruction(TOKEN_2022, bytes, { trailing: 'report' });
    try {
      const re = t.encodeTokenInstruction(TOKEN_2022, decoded.name, decoded.args);
      if (re.equals(bytes)) oracle.reencoded += 1;
      else oracle.refused['not-byte-exact'] = (oracle.refused['not-byte-exact'] ?? 0) + 1;
    } catch (error) {
      const reason = String(error.reason ?? error.message);
      oracle.refused[reason] = (oracle.refused[reason] ?? 0) + 1;
    }
  }

  // Face 4: the refusal voice through the token wrapper — one reason, once.
  let wrappedVoice = null;
  try {
    t.decodeTokenInstruction(
      TOKEN_2022, Buffer.from(`d7e4a6e45464567b${'00'.repeat(32)}00`, 'hex'), { trailing: 'report' });
  } catch (error) {
    wrappedVoice = String(error.message);
  }

  // Guard: legacy SPL Token has no fallback branch.
  const legacy = {};
  for (const name of METADATA_NAMES) {
    try {
      t.encodeTokenInstruction(SPL_TOKEN, name, { name: 'a', symbol: 'b', uri: 'c' });
      legacy[name] = 'encoded';
    } catch (error) {
      legacy[name] = String(error.reason ?? error.message);
    }
  }

  process.stdout.write(JSON.stringify({
    root: 'TREE-RELATIVE',
    namesAdvertised: names.length,
    metadataNamesAdvertised: metadataNames.length,
    unknownVariantNames,
    fixture,
    oracle,
    wrappedVoice,
    reasonDoubled: wrappedVoice === null ? null
      : /^(.+?): \1: /.test(wrappedVoice),
    legacy,
    encodeOutcomes,
  }, null, 2));
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${String(error?.stack ?? error).slice(0, 600)}\n`);
  process.exit(1);
});
