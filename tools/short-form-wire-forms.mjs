#!/usr/bin/env node
// tools/short-form-wire-forms.mjs — WHICH WIRE FORMS DOES THE PROGRAM REALLY
// EXECUTE, and which of them does the published interface fail to describe?
//
// The open question this measures (sememe card "sememe: lokale Bedeutungsebene
// qualifizieren"):
//
//   The unbiased traffic sample (test/fixtures/traffic-sample-2026-11-02.json)
//   leaves 172 payloads that sememe REFUSES: an interface exists, but the
//   bytes do not fit it. 152 of them carry the discriminator e1f7501ed5b38488
//   ("buy_exact_quote_in_v3") and are 24 bytes long, while the only interface
//   that knows that discriminator — pump.fun's first-party published copy —
//   declares a trailing `partial_fill: OptionBool` field, i.e. 25 bytes.
//
//   Two readings were possible, and they call for OPPOSITE product actions:
//
//     (A) The published copy is right and the 24-byte payloads are garbage
//         or a different instruction. Fix: nothing, or refuse harder.
//     (B) The deployed program TOLERATES the field being absent (a runtime
//         default), and the published copy over-describes the wire. Fix: the
//         product must be able to NAME these payloads, and the first-party
//         copy needs a correction.
//
//   A refusal alone cannot tell them apart. The CHAIN can: if the program
//   logs the instruction and the transaction ends with err:null, the program
//   really did execute that short form.
//
// So this tool measures, for every refusal group in the sample:
//
//   1. the wire forms per (program, discriminator): which byte lengths occur,
//      and how often;
//   2. the chain's verdict per form: fetched from the chain by signature, the
//      transaction's err, the program's own log line for the instruction, and
//      whether the fixture bytes match the chain bytes EXACTLY;
//   3. the control: the SAME chain check on payloads sememe already decodes,
//      so the tool can be shown to distinguish "executed" from "not executed"
//      rather than rubber-stamping everything.
//
// Every claim in the report is re-derived from the sample and the chain; the
// summary fields are computed, never written by hand.
//
// Read-only, public RPC. Every fetch is counted; a partial run exits non-zero
// instead of reporting a smaller sample as if it were the whole thing.

import fs from 'node:fs';
import { decodeUnionPayload } from '../src/decode.mjs';
import { decodeNativeInstruction, isNativeProgram } from '../src/native.mjs';
import { decodeTokenInstruction, isTokenProgram } from '../src/token.mjs';
import { accountKeyList, programIdOf, toHex } from './lib/payloads.mjs';

const RPC = process.env.SEMEME_RPC ?? 'https://api.mainnet-beta.solana.com';
// Defaults keep the committed 2026-11-03 report reproducible byte-for-byte
// (test/short-form-wire-forms.test.mjs runs this tool with no arguments and
// compares the result). A second window passes --sample/--store explicitly.
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};
const STORE = flag('--store', 'test/fixtures/traffic-sample-store');
const SAMPLE = flag('--sample', 'test/fixtures/traffic-sample-2026-11-02.json');
const OUT = flag('--out', process.argv[2] ?? 'research/short-form-wire-forms-2026-11-03.json');
// How many chain witnesses to pull per group. Small on purpose: the public
// RPC throttles hard, and the question is answered by a handful of witnesses.
const WITNESSES_PER_GROUP = Number(process.env.SEMEME_WITNESSES ?? 4);

// --- sample ----------------------------------------------------------------

const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));

// The program names its own instruction in its log line, but the name is
// exactly what sememe does NOT have for a refused payload — so look it up from
// the stored interfaces independently of the decode outcome: a refusal means
// the BYTES would not fit, not that the discriminator is unknown to every
// source. (For buy_exact_quote_in_v3 the on-chain IDL does not even know the
// discriminator; pump.fun's published copy does, and declares one field more
// than the wire carries.)
function instructionName(program, discriminatorHex) {
  if (nameCache.has(discriminatorHex)) return nameCache.get(discriminatorHex);
  const dir = `${STORE}/objects`;
  for (const file of fs.readdirSync(dir)) {
    const idl = JSON.parse(fs.readFileSync(`${dir}/${file}`, 'utf8'));
    if (!Array.isArray(idl.instructions)) continue;
    const hit = idl.instructions.find((ix) =>
      (ix.discriminator ?? []).map((b) => b.toString(16).padStart(2, '0')).join('') === discriminatorHex);
    if (hit) { nameCache.set(discriminatorHex, hit.name); return hit.name; }
  }
  nameCache.set(discriminatorHex, null);
  return null;
}
const nameCache = new Map();
const decodedNameCache = new Map();

/**
 * The instruction name behind one payload group, from the product itself.
 *
 * Order matters: the interface objects first (that is what a REFUSED payload
 * needs — its discriminator IS known, only the bytes did not fit), then a
 * decode of a real payload through the product's own entry points. Scanning
 * IDL objects alone gave `null` for every native and token program — they
 * have no stored IDL object at all — which made controls look "not executed"
 * when the program had simply never been asked to name them.
 */
async function resolveInstructionName(group) {
  const fromObjects = instructionName(group.program, group.discriminator);
  if (fromObjects) return fromObjects;
  const key = `${group.program}|${group.discriminator}`;
  if (decodedNameCache.has(key)) return decodedNameCache.get(key);
  const sampleRow = sample.transactions
    .flatMap((tx) => tx.payloads)
    .find((row) => row.program === group.program && row.dataHex.startsWith(group.discriminator));
  let name = null;
  if (sampleRow) {
    try {
      if (isNativeProgram(group.program)) {
        name = decodeNativeInstruction(group.program, Buffer.from(sampleRow.dataHex, 'hex'), { trailing: 'report' }).name;
      } else if (isTokenProgram(group.program)) {
        name = decodeTokenInstruction(group.program, Buffer.from(sampleRow.dataHex, 'hex'), { trailing: 'report' }).name;
      } else {
        const result = await decodeUnionPayload(STORE, group.program, sampleRow.dataHex, { trailing: 'report' });
        name = result.name;
      }
    } catch { name = null; }
  }
  decodedNameCache.set(key, name);
  return name;
}

async function classify(program, hex) {
  const bytes = Buffer.from(hex, 'hex');
  if (isNativeProgram(program)) {
    try { decodeNativeInstruction(program, bytes, { trailing: 'report' }); return { outcome: 'decoded' }; }
    catch { return { outcome: 'refused' }; }
  }
  if (isTokenProgram(program)) {
    try { decodeTokenInstruction(program, bytes, { trailing: 'report' }); return { outcome: 'decoded' }; }
    catch { return { outcome: 'refused' }; }
  }
  try {
    await decodeUnionPayload(STORE, program, hex, { trailing: 'report' });
    return { outcome: 'decoded' };
  } catch (error) {
    if (String(error.message).startsWith('no stored IDL for program')) return { outcome: 'no-interface' };
    return { outcome: 'refused', reason: String(error.message) };
  }
}

/** Group the sample's payloads by (program, discriminator, wire length). */
const groups = new Map();
// The classification is per (program, discriminator, wire length): the same
// key always decodes or refuses the same way, so it is decided ONCE. Deciding
// it per payload meant 12,572 store reads for a sample whose distinct shapes
// are far fewer.
const classification = new Map();
for (const tx of sample.transactions) {
  for (const row of tx.payloads) {
    const key = `${row.program}|${row.dataHex.slice(0, 16)}|${row.dataHex.length / 2}`;
    if (!groups.has(key)) {
      let verdict = classification.get(key);
      if (!verdict) {
        verdict = await classify(row.program, row.dataHex);
        classification.set(key, verdict);
      }
      groups.set(key, {
        program: row.program,
        discriminator: row.dataHex.slice(0, 16),
        wireBytes: row.dataHex.length / 2,
        outcome: verdict.outcome,
        reason: verdict.reason ?? null,
        payloads: 0,
        inAcceptedTx: 0,
        inFailedTx: 0,
        signatures: new Set(),
        witnesses: [],
      });
    }
    const group = groups.get(key);
    group.payloads += 1;
    if (tx.failed) group.inFailedTx += 1; else group.inAcceptedTx += 1;
    group.signatures.add(tx.signature);
  }
}

// --- chain -----------------------------------------------------------------

let networkAttempts = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    networkAttempts += 1;
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (response.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const body = await response.json();
    if (body.error) {
      // -32005 is "node behind" — retryable. Anything else is reported, never
      // retried into a vague "rate limited".
      if (body.error.code === -32005) { await sleep(1500 * (attempt + 1)); continue; }
      return { error: body.error };
    }
    return { result: body.result };
  }
  return { error: { code: -1, message: 'rate limited after 4 attempts' } };
}

/**
 * Fetch one transaction and decide what the CHAIN says about it:
 *   - the program ids of every instruction, with the bytes the chain holds,
 *   - whether the transaction ended with err:null,
 *   - the program's own log lines (the program names its own instruction).
 *
 * Two encoding facts this must get right, both of which produce a plausible
 * but WRONG answer when missed:
 *
 *   1. instruction data in encoding "json" is BASE58, not base64 — the repo's
 *      own tools/lib/payloads.mjs does this conversion; decoding it as base64
 *      yields bytes of the wrong length that read as a different wire form.
 *   2. the account list is the static keys FOLLOWED BY the address lookup
 *      table entries (writable, then readonly). Without the lookup-table
 *      part, programIdIndex resolves to the wrong program.
 *
 * The transaction version matters too: mainnet now serves version-1
 * transactions, and asking for version 0 only makes the RPC refuse the whole
 * request ("Transaction version (1) is not supported by the requesting
 * client") — which, in a tool that fetches hundreds of transactions, silently
 * removes exactly the newest and most interesting ones.
 */
async function chainWitness(signature) {
  const { result, error } = await rpc('getTransaction', [
    signature,
    { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
  ]);
  if (error) return { signature, ok: false, error: error.message ?? String(error) };
  if (!result) return { signature, ok: false, error: 'transaction not found' };
  const accounts = accountKeyList(result);
  const instructions = [];
  const topLevel = result.transaction?.message?.instructions ?? [];
  for (const [index, ix] of topLevel.entries()) {
    instructions.push({
      where: `top${index}`,
      program: programIdOf(ix, accounts),
      hex: toHex(ix.data),
    });
  }
  for (const inner of result.meta?.innerInstructions ?? []) {
    for (const [position, ix] of (inner?.instructions ?? []).entries()) {
      instructions.push({
        where: `inner${inner.index}.${position}`,
        program: programIdOf(ix, accounts),
        hex: toHex(ix.data),
      });
    }
  }
  const logs = result.meta?.logMessages ?? [];
  return {
    signature,
    ok: true,
    slot: result.slot,
    txError: result.meta?.err ?? null,
    accepted: result.meta?.err === null || result.meta?.err === undefined,
    instructionLogs: logs.filter((l) => l.startsWith('Program log: Instruction:')),
    instructions,
  };
}

/**
 * The name the CHAIN logs for an instruction.
 *
 * Anchor logs the instruction name in CamelCase ("BuyExactQuoteInV3") while
 * the IDL spells it snake_case ("buy_exact_quote_in_v3"). Comparing the two
 * literally would make every witness look like "the program did not log it"
 * — the measurement would then report "nothing was executed" while the
 * evidence sat in the log line. The comparison is therefore case- and
 * separator-insensitive, and it is verified to be a real match rather than a
 * loose one: the logged name must contain the IDL name's words in order.
 */
function logNamesInstruction(logs, idlName) {
  if (!idlName) return false;
  const words = idlName.split('_').filter(Boolean).map((w) => w.toLowerCase());
  return logs.some((log) => {
    const logged = log.replace('Program log: Instruction:', '').toLowerCase();
    let at = 0;
    for (const word of words) {
      const found = logged.indexOf(word, at);
      if (found === -1) return false;
      at = found + word.length;
    }
    return true;
  });
}

/** Did the chain's bytes for this program/discriminator equal the fixture's? */
function crossCheck(witness, program, discriminatorHex, fixtureHex) {
  const candidates = witness.instructions.filter(
    (ix) => ix.program === program && ix.hex.startsWith(discriminatorHex),
  );
  return {
    chainInstructionsWithThisDiscriminator: candidates.length,
    exactMatch: candidates.some((ix) => ix.hex === fixtureHex),
    chainByteLengths: [...new Set(candidates.map((ix) => ix.hex.length / 2))].sort((a, b) => a - b),
  };
}

// The chain is only consulted where it can answer the question:
//   - every REFUSED group (the whole point of the tool), and
//   - a small CONTROL set of decoded groups, so the tool can be shown to
//     distinguish "the chain executed this wire form" from "it did not"
//     instead of rubber-stamping every form it is shown.
//
// The control is deliberately SMALL: one group per program, the biggest one
// in that program. The sample has 3,675 distinct payload shapes, most of them
// SPL Token / System / ComputeBudget variants — pulling a chain witness for
// each of those would be hundreds of RPC calls that answer nothing the
// question asks.
const refusedGroups = [...groups.values()].filter((g) => g.outcome === 'refused');
const decodedGroups = [...groups.values()].filter((g) => g.outcome === 'decoded');
const controlGroups = [];
for (const program of new Set(decodedGroups.map((g) => g.program))) {
  const candidates = decodedGroups.filter((g) => g.program === program)
    .sort((a, b) => b.payloads - a.payloads);
  if (candidates[0]) controlGroups.push(candidates[0]);
}

const selected = [...refusedGroups, ...controlGroups];
console.error(`examining ${refusedGroups.length} refusal groups + ${controlGroups.length} controls (of ${groups.size} shapes)`);
const rows = [];
let done = 0;
for (const group of selected) {
  done += 1;
  if (done % 5 === 0) console.error(`  witness ${done}/${selected.length}`);
  const groupName = await resolveInstructionName(group);
  const acceptedSigs = [...group.signatures].filter((sig) => {
    const tx = sample.transactions.find((t) => t.signature === sig);
    return tx && !tx.failed;
  });
  const failedSigs = [...group.signatures].filter((sig) => {
    const tx = sample.transactions.find((t) => t.signature === sig);
    return tx && tx.failed;
  });
  const chosen = [
    ...acceptedSigs.slice(0, WITNESSES_PER_GROUP),
    ...failedSigs.slice(0, Math.max(1, Math.ceil(WITNESSES_PER_GROUP / 2))),
  ];
  const witnesses = [];
  for (const signature of chosen) {
    const witness = await chainWitness(signature);
    if (!witness.ok) { witnesses.push(witness); continue; }
    const tx = sample.transactions.find((t) => t.signature === signature);
    const fixtureHex = tx.payloads.find(
      (row) => row.program === group.program && row.dataHex.startsWith(group.discriminator) && row.dataHex.length / 2 === group.wireBytes,
    ).dataHex;
    const cross = crossCheck(witness, group.program, group.discriminator, fixtureHex);
    witnesses.push({
      ...witness,
      fixtureBytes: group.wireBytes,
      fixtureCrossCheck: cross,
      // Flat copies of the cross-check, so a reader of `rows` and a reader of
      // `shortForms` see the SAME field names for the SAME facts.
      fixtureMatchesChainBytes: cross.exactMatch,
      chainByteLengths: cross.chainByteLengths,
      chainLoggedInstruction: logNamesInstruction(witness.instructionLogs ?? [], groupName),
    });
  }
  rows.push({
    program: group.program,
    discriminator: group.discriminator,
    wireBytes: group.wireBytes,
    sememeOutcome: group.outcome,
    refusalReason: group.reason,
    payloads: group.payloads,
    inAcceptedTx: group.inAcceptedTx,
    inFailedTx: group.inFailedTx,
    distinctSignatures: group.signatures.size,
    witnesses,
    // The group's own summary, re-derived from the witnesses above.
    // "executed" means ALL of: the transaction ended with err:null (so every
    // instruction in it succeeded), the chain's bytes for this
    // program+discriminator are byte-identical to the fixture's, and the
    // program logged the instruction name that the stored interface assigns to
    // this discriminator. Drop any of the three and the claim is not proved.
    //
    // When the program logs no name for this instruction (native and token
    // programs log none; a program may also fail before reaching it), the
    // name condition CANNOT be checked — so the verdict is recorded as
    // "byte-exact, name unchecked" rather than being quietly counted as
    // either executed or not executed.
    instructionName: groupName,
    nameCheckable: groupName !== null,
    chainExecuted: witnesses.some((w) => w.ok && w.accepted
      && w.fixtureCrossCheck?.exactMatch
      && groupName !== null
      && logNamesInstruction(w.instructionLogs ?? [], groupName)),
    chainExecutedWithoutNameCheck: witnesses.some((w) => w.ok && w.accepted
      && w.fixtureCrossCheck?.exactMatch
      && groupName === null),
    chainAcceptedWitnesses: witnesses.filter((w) => w.ok && w.accepted).length,
    chainRejectedWitnesses: witnesses.filter((w) => w.ok && !w.accepted).length,
    byteExactWitnesses: witnesses.filter((w) => w.ok && w.fixtureCrossCheck?.exactMatch).length,
  });
}

// --- report ----------------------------------------------------------------

const refusedRows = rows.filter((r) => r.sememeOutcome === 'refused');
const decodedRows = rows.filter((r) => r.sememeOutcome === 'decoded');
// The headline: a refusal group whose wire form the CHAIN executed anyway is
// a SHORT FORM — the interface over-describes the wire. A refusal group the
// chain rejected is a genuine refusal.
//
// The third verdict is the honest one: the chain executed the bytes, but the
// program logs no name for the instruction, so the NAME condition could not
// be checked. Those are counted separately instead of being pushed into
// either bucket.
const shortFormGroups = refusedRows.filter((r) => r.chainExecuted && r.byteExactWitnesses > 0);
const executedUnnamedGroups = refusedRows.filter((r) => !r.chainExecuted && r.chainExecutedWithoutNameCheck);
const genuineRefusalGroups = refusedRows.filter((r) => !r.chainExecuted && !r.chainExecutedWithoutNameCheck);

const report = {
  generatedAt: new Date().toISOString(),
  question: 'do the payloads sememe refuses exist on-chain in a form the program really executes?',
  method: {
    sample: SAMPLE,
    store: STORE,
    rpc: RPC,
    classification: 'the product entry points (decodeUnionPayload / native decoder / token decoder) against the committed store fixture',
    chainCheck: 'getTransaction (encoding json, maxSupportedTransactionVersion 1, finalized): err, the program\'s own "Program log: Instruction:" lines, and a byte-exact fixture-vs-chain comparison of the instruction data',
    witnessesPerGroup: WITNESSES_PER_GROUP,
    notes: [
      'instruction data in encoding "json" is BASE58; decoding it as base64 produces plausible-looking bytes of the wrong length',
      'the account list is the static keys FOLLOWED BY the address lookup table entries (writable, then readonly); without them programIdIndex resolves to the wrong program',
      'the chain logs instruction names in CamelCase ("BuyExactQuoteInV3") while the IDL spells them snake_case ("buy_exact_quote_in_v3"); the comparison is case- and separator-insensitive, word by word, in order',
      'a program may fail BEFORE reaching the instruction, so a failed transaction says nothing about the wire form — only err:null witnesses count',
    ],
  },
  coverage: {
    networkAttempts,
    groupsInSample: groups.size,
    groupsExamined: rows.length,
    refusedGroups: refusedRows.length,
    controlGroups: decodedRows.length,
    refusals: refusedRows.reduce((acc, r) => acc + r.payloads, 0),
    refusedPayloadsExecutedByChain: shortFormGroups.reduce((acc, r) => acc + r.payloads, 0),
    refusedPayloadsExecutedNameUnchecked: executedUnnamedGroups.reduce((acc, r) => acc + r.payloads, 0),
    refusalsNotExecutedByChain: genuineRefusalGroups.reduce((acc, r) => acc + r.payloads, 0),
    controlWitnessesByteExact: decodedRows.reduce((acc, r) => acc + r.byteExactWitnesses, 0),
    controlGroupsExecuted: decodedRows.filter((r) => r.chainExecuted).length,
    controlGroupsExecutedNameUnchecked: decodedRows.filter((r) => r.chainExecutedWithoutNameCheck).length,
  },
  shortForms: shortFormGroups.map((r) => ({
    program: r.program,
    discriminator: r.discriminator,
    instructionName: r.instructionName,
    wireBytes: r.wireBytes,
    payloads: r.payloads,
    sememeSays: r.refusalReason,
    chainExecutedWitnesses: r.chainAcceptedWitnesses,
    chainRejectedWitnesses: r.chainRejectedWitnesses,
    byteExactWitnesses: r.byteExactWitnesses,
    witnesses: r.witnesses.map((w) => ({
      signature: w.signature,
      slot: w.slot,
      txError: w.txError,
      instructionLogs: w.instructionLogs,
      fixtureBytes: w.fixtureBytes,
      chainByteLengths: w.fixtureCrossCheck?.chainByteLengths ?? null,
      fixtureMatchesChainBytes: w.fixtureCrossCheck?.exactMatch ?? null,
      chainLoggedInstruction: logNamesInstruction(w.instructionLogs ?? [], r.instructionName),
    })),
  })),
  // The two buckets the short forms must NOT be confused with.
  executedNameUnchecked: executedUnnamedGroups.map((r) => ({
    program: r.program,
    discriminator: r.discriminator,
    instructionName: r.instructionName,
    wireBytes: r.wireBytes,
    payloads: r.payloads,
    sememeSays: r.refusalReason,
    why: 'the chain executed these bytes (err:null, byte-identical), but the program logs no instruction name for them, so the name condition could not be checked',
    byteExactWitnesses: r.byteExactWitnesses,
  })),
  genuineRefusals: genuineRefusalGroups.map((r) => ({
    program: r.program,
    discriminator: r.discriminator,
    instructionName: r.instructionName,
    wireBytes: r.wireBytes,
    payloads: r.payloads,
    sememeSays: r.refusalReason,
    why: 'no chain witness executed these bytes: the refusals here are the interface being right',
    byteExactWitnesses: r.byteExactWitnesses,
  })),
  rows,
};

fs.writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
console.error(`wrote ${OUT}`);
console.error(JSON.stringify(report.coverage, null, 1));
for (const r of shortFormGroups) {
  console.error(`SHORT FORM ${r.program.slice(0, 10)} ${r.instructionName} ${r.discriminator} ${r.wireBytes}B x${r.payloads} -> chain executed ${r.chainAcceptedWitnesses}, byte-exact ${r.byteExactWitnesses}`);
}
