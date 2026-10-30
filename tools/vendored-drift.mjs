// How stale are the vendored IDLs in my own repositories?
//
// sememe's claim is that a checked-in IDL is "a snapshot without provenance, a
// fingerprint, or a freshness check". That claim was an assertion from notes. This
// tool turns it into a number for the IDLs that sit in my OWN repositories:
//
//   node tools/vendored-drift.mjs --repo <dir> [--repo <dir> ...]
//        [--store <sememe-store>] [--harvest <file.json> --program <id>]
//        [--out <file.json>]
//
// For each vendored IDL file it reports:
//   onChainAvailable  whether a verified on-chain IDL exists for that program
//   instructions       how many instructions the vendored copy declares
//   onChainInstructions how many the on-chain copy declares
//   missingOnChain     instructions the on-chain copy has and the vendored one lacks
//   missingVendored    instructions the vendored copy has and the on-chain one lacks
//   renamed            same wire bytes, different name
//   unnamedByVendored  real traffic payloads the vendored copy CANNOT name
//
// The last row is the one that matters: an instruction nobody exercised is a
// curiosity, an instruction that appears in real mainnet traffic and cannot be
// named is a defect in a shipped decoder.
//
// A vendored file is matched to a program by the address it declares (top-level
// `address`, `metadata.address`) or by the file name in idl/multi/<program>/. A
// file that declares no address at all is reported as `unbound` — that is not a
// stale copy, it is a copy bound to nothing, and the two are different defects.
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findStoredIdl } from '../src/decode.mjs';
import { withDerivedDiscriminators } from '../src/discriminators.mjs';
import { EVENT_IX_TAG_HEX } from '../src/codec.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};
const repos = [];
const optionAll = (name) => {
  let index = args.indexOf(name);
  while (index >= 0) {
    repos.push(args[index + 1]);
    args.splice(index, 2);
    index = args.indexOf(name);
  }
};
optionAll('--repo');
const storeDir = option('--store', null);
const harvestPath = option('--harvest', null);
const program = option('--program', null);
const outPath = option('--out', null);
if (!repos.length) {
  console.error('usage: node tools/vendored-drift.mjs --repo <dir> [--repo <dir> ...] [--store <dir>] [--harvest <file.json> --program <id>] [--out <file.json>]');
  process.exit(2);
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** Address a vendored IDL declares, if any. */
function declaredAddress(idl) {
  if (typeof idl.address === 'string' && idl.address) return idl.address;
  if (typeof idl.metadata?.address === 'string' && idl.metadata.address) return idl.metadata.address;
  return null;
}

/** Every .json under a directory (recursively). */
async function jsonFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.json')) out.push(full);
    }
  }
  return out.sort();
}

/**
 * The stored on-chain IDL for a program, with derived discriminators filled in.
 * Returns null when the store holds no verified artifact for it — which is a
 * finding, not an error: the program may be a native (non-Anchor) program that
 * never publishes an on-chain IDL at all.
 */
async function onChainIdl(programId) {
  if (!storeDir) return null;
  try {
    const stored = await findStoredIdl(storeDir, programId);
    if (!stored?.idl) return null;
    return withDerivedDiscriminators(stored.idl).idl;
  } catch {
    return null;
  }
}

/** discriminator hex -> instruction name. */
function instructionTable(idl) {
  const table = new Map();
  for (const instruction of idl?.instructions ?? []) {
    if (!Array.isArray(instruction.discriminator) || instruction.discriminator.length < 8) continue;
    table.set(hex(instruction.discriminator.slice(0, 8)), String(instruction.name));
  }
  return table;
}

/** discriminator hex -> event name. */
function eventTable(idl) {
  const table = new Map();
  for (const event of idl?.events ?? []) {
    if (!Array.isArray(event.discriminator) || event.discriminator.length < 8) continue;
    table.set(hex(event.discriminator.slice(0, 8)), String(event.name));
  }
  return table;
}

const findings = [];

for (const repo of repos) {
  const files = await jsonFiles(path.join(repo, 'idl'));
  for (const file of files) {
    // The sememe store copy inside the repo is the artifact itself, not a
    // vendored copy of somebody else's interface. It is measured elsewhere.
    if (file.includes(`${path.sep}sememe-store${path.sep}`)) continue;
    let idl;
    try {
      idl = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      findings.push({ repo, file, defect: 'unparsable', error: String(error.message).slice(0, 120) });
      continue;
    }
    const instructions = idl.instructions ?? [];
    if (!instructions.length) continue;

    const address = declaredAddress(idl);
    const vendoredTable = instructionTable(idl);
    const vendoredNames = new Set(instructions.map((i) => String(i.name)));

    const finding = {
      repo,
      file: path.relative(repo, file),
      program: address,
      instructions: instructions.length,
      discriminators: vendoredTable.size,
      onChainAvailable: false,
      onChainInstructions: null,
      missingOnChain: [],
      missingVendored: [],
      renamed: [],
      unnamedByVendored: null,
    };

    const chain = address ? await onChainIdl(address) : null;
    const chainTable = chain ? instructionTable(chain) : new Map();
    const chainEventTable = chain ? eventTable(chain) : new Map();
    if (chain) {
      finding.onChainAvailable = true;
      const chainNames = new Set((chain.instructions ?? []).map((i) => String(i.name)));
      finding.onChainInstructions = (chain.instructions ?? []).length;
      for (const [disc, name] of chainTable) {
        if (!vendoredTable.has(disc)) finding.missingOnChain.push(name);
        else if (vendoredTable.get(disc) !== name) {
          finding.renamed.push({ discriminator: disc, vendored: vendoredTable.get(disc), onChain: name });
        }
      }
      for (const name of vendoredNames) if (!chainNames.has(name)) finding.missingVendored.push(name);
      finding.missingOnChain.sort();
      finding.missingVendored.sort();
    } else if (!address) {
      finding.defect = 'unbound';
    }

    // Real traffic: payloads the vendored copy cannot name.
    //
    // The split matters. A payload whose discriminator is an Anchor EVENT
    // self-CPI (emit_cpi!) is not an instruction the vendored copy is missing —
    // a vendored instruction table has no business naming events. Counting
    // those would inflate the defect by an order of magnitude. Only payloads
    // that the ON-CHAIN copy names as an INSTRUCTION are a real gap: real
    // mainnet traffic that the shipped decoder cannot label.
    if (harvestPath && program && address === program) {
      const harvest = JSON.parse(await readFile(harvestPath, 'utf8'));
      let unnamed = 0;
      let payloads = 0;
      const unnamedNames = [];
      const unnamedEventPayloads = [];
      for (const transaction of harvest.transactions ?? []) {
        if (transaction.missing) continue;
        for (const payload of transaction.payloads ?? []) {
          payloads++;
          const dataHex = payload.dataHex ?? '';
          const disc = dataHex.slice(0, 16);
          if (!disc) continue;
          if (!vendoredTable.has(disc)) {
            const chainInstruction = chainTable.get(disc);
            if (chainInstruction) {
              unnamed++;
              if (!unnamedNames.includes(chainInstruction)) unnamedNames.push(chainInstruction);
            } else {
              // Not an instruction the on-chain copy names either: either an
              // event self-CPI or something neither copy knows.
              //
              // An `emit_cpi!` payload is
              //   EVENT_IX_TAG (8) ++ event_discriminator (8) ++ borsh(body)
              // so the discriminator that identifies the event sits at bytes
              // 8..16. Looking up bytes 0..8 — the TAG — always misses: that
              // published all 396 tagged Jupiter payloads as `unknownToBoth`
              // while `eventSelfCpiPayloads` stayed 0, contradicting this
              // repository's own decoder (which names all 396).
              const head = disc;
              const key = head === EVENT_IX_TAG_HEX ? dataHex.slice(16, 32) : head;
              const asEvent = chainEventTable.get(key);
              if (asEvent) unnamedEventPayloads.push(asEvent);
              else unnamedEventPayloads.push(null);
            }
          }
        }
      }
      finding.unnamedByVendored = {
        payloads,
        unnamed,
        namedByOnChain: unnamedNames,
        eventSelfCpiPayloads: unnamedEventPayloads.filter(Boolean).length,
        unknownToBoth: unnamedEventPayloads.filter((n) => n === null).length,
      };
    }

    findings.push(finding);
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  store: storeDir,
  repos,
  files: findings.length,
  withOnChain: findings.filter((f) => f.onChainAvailable).length,
  unbound: findings.filter((f) => f.defect === 'unbound').length,
  stale: findings.filter((f) => f.onChainAvailable && f.missingOnChain.length > 0).length,
  trafficBlind: findings.filter((f) => f.unnamedByVendored?.unnamed > 0).length,
  findings,
};

if (outPath) {
  await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
}
console.log(JSON.stringify({ ...summary, findings: undefined }, null, 2));
for (const finding of findings) {
  // A defect finding (unparsable) carries no instruction inventory at all — guard every
  // field rather than assuming the shape, or a bad file breaks the report it is in.
  if (finding.defect === 'unparsable') {
    console.log(`${finding.repo}/${finding.file}: UNPARSABLE ${finding.error}`);
    continue;
  }
  const missingOnChain = finding.missingOnChain ?? [];
  const missingVendored = finding.missingVendored ?? [];
  const renamed = finding.renamed ?? [];
  const traffic = finding.unnamedByVendored;
  console.log(
    `${finding.repo}/${finding.file}: ${finding.instructions} ix`
    + `${finding.onChainAvailable ? ` | on-chain ${finding.onChainInstructions} ix` : ' | no on-chain IDL'}`
    + `${missingOnChain.length ? ` | MISSING ${missingOnChain.join(',')}` : ''}`
    + `${missingVendored.length ? ` | EXTRA ${missingVendored.join(',')}` : ''}`
    + `${renamed.length ? ` | RENAMED ${renamed.length}` : ''}`
    + `${finding.defect === 'unbound' ? ' | UNBOUND (declares no program address)' : ''}`
    + `${traffic?.unnamed ? ` | TRAFFIC-UNNAMED ${traffic.unnamed}/${traffic.payloads} (${traffic.namedByOnChain.join(',')})` : ''}`,
  );
}
