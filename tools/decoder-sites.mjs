// Make the venture's central planning number measurable: how many decoder
// sites do my own repositories actually contain, and which of them could be
// replaced by a stored, verified on-chain IDL today?
//
// The card and workspace notes say "~99 own decoder sites" and "41 to
// replace". Until now those numbers were estimates from notes, not computed
// facts. This script computes them, and it is allowed to disagree with the
// notes: a repo counts a site when a concrete decoder artefact is found in
// that repo, classified by how the bytes are actually decoded.
//
//   node tools/decoder-sites.mjs [--repos <dir>] [--store <sememe-store>]
//        [--out <file.json>] [--program <program-id> ...]
//
// Site classes (per file, per class; a file can hold several classes):
//   generated-codec   imports Codama-generated instruction codecs
//   own-codec         builds its own codec (getStructDecoder, getU64Decoder, ...)
//   raw-discriminator  hardcoded 8-byte instruction discriminators
//   vendored-idl      a JSON IDL file checked into the repo
//   decode-call       calls a decoder (decodeArgs, decodeInstructionData, ...)
//   account-layout    declares account layouts (borsh, pack, zero_copy, ...)
//   event-decode      decodes program events/logs
//
// Replaceability today is decided by the sememe store: a decoder site that
// handles program P is replaceable when P's verified IDL is in the store.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};
const reposDir = option('--repos', path.join(os.homedir(), 'github_repos'));
const store = option('--store', path.join(os.tmpdir(), 'sememe-user-zero'));
const outFile = option('--out', null);
const programs = args.filter((value) => !value.startsWith('--'));
const maxFileBytes = 1_500_000;

const CLASSES = {
  'generated-codec': /from\s+['"][^'"]*generated[/\\]instructions[/\\][^'"]*['"]|_DISCRIMINATOR\b/,
  'own-codec': /\bget(?:Struct|U8|U16|U32|U64|U128|I64|I128|Boolean|Option|Bytes|Address|Enum|Raw)Decoder\b/,
  'raw-discriminator': /['"`][0-9a-fA-F]{16}['"`]|0x[0-9a-fA-F]{16}\b/,
  'vendored-idl': null, // handled by file name + content
  'decode-call': /\bdecodeArgs\s*\(|\bdecodeInstructionData\s*\(|\bdecode[A-Z]\w*Instruction\b|\.decode\s*\(\s*bytes?\b/,
  'account-layout': /\b(?:borsh|zero_copy|solana_zk|bytemuckunsafe|repr\s*\(\s*C\s*\))/,
  'event-decode': /\bdecodeEvent\b|\bEventDecoder\b|\bparseEvent\b/,
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', '__pycache__']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.go', '.py', '.json']);
const IDL_NAME = /(?:^|[/\\])(idl|types?|interfaces?)[/\\]/i;
const IDL_FILE = /idl/i;

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(full, out); }
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function listRepos(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const repos = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    try {
      const info = await stat(path.join(full, '.git'));
      if (info.isDirectory() || info.isFile()) repos.push(full);
    } catch { /* not a git checkout */ }
  }
  return repos.sort();
}

const storedPrograms = new Set();
try {
  const receipts = await readdir(path.join(store, 'receipts'));
  for (const name of receipts) {
    const receipt = JSON.parse(await readFile(path.join(store, 'receipts', name), 'utf8'));
    if (receipt?.program) storedPrograms.add(receipt.program);
  }
} catch { /* no store: nothing is replaceable yet */ }

// A checkout is "own" when its origin remote is under an owner I control.
// Third-party checkouts on the same disk (forks, upstream clones used as
// reference) are counted separately: they are not my decoder sites, and
// counting them would inflate the number the venture plan depends on.
const OWN_OWNERS = new Set(['auroraxo', 'sprintberlin']);
async function remotes(repo) {
  try {
    const { stdout } = await run('git', ['-C', repo, 'remote', '-v'], { timeout: 5000 });
    const map = new Map();
    for (const line of stdout.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
      if (match && !map.has(match[1])) map.set(match[1], match[2]);
    }
    return map;
  } catch { return new Map(); }
}
function ownerOf(remote) {
  if (!remote) return null;
  const match = /github\.com[/:]([^/]+)\//i.exec(remote);
  return match ? match[1] : null;
}
// A checkout is a fork of someone else's code when it also has a remote owned
// by a different account. Decoder artefacts inside such a checkout are not my
// code and must not be counted as my own decoder sites.
async function classifyOwnership(repo) {
  const map = await remotes(repo);
  const origin = map.get('origin') ?? null;
  const owner = ownerOf(origin);
  const foreign = [...map.values()].map(ownerOf).filter((candidate) => candidate && candidate !== owner);
  const forkOf = foreign.length ? ownerOf([...map.values()].find((remote) => ownerOf(remote) !== owner)) : null;
  return { origin, owner, forkOf, isFork: Boolean(forkOf) };
}

const perRepo = [];
// Two distinct units are reported so the number can be checked rather than
// taken on trust: `siteFiles` counts files containing at least one decoder
// artefact, `siteClassPairs` counts (file, class) pairs — the unit the notes
// use when they say "~99 decoder sites". They are not interchangeable.
let totals = { filesScanned: 0, siteFiles: 0, siteClassPairs: 0 };
const classTotals = {};
for (const key of Object.keys(CLASSES)) classTotals[key] = 0;
const ownClassTotals = {};
for (const key of Object.keys(CLASSES)) ownClassTotals[key] = 0;
let ownSiteFiles = 0;
let ownSiteClassPairs = 0;

for (const repo of await listRepos(reposDir)) {
  const name = path.basename(repo);
  const { origin: remote, owner, forkOf, isFork } = await classifyOwnership(repo);
  const own = Boolean(owner && OWN_OWNERS.has(owner)) && !isFork;
  const files = await walk(repo);
  const sites = [];
  let programHits = new Set();
  for (const file of files) {
    const extension = path.extname(file);
    if (!CODE_EXTENSIONS.has(extension)) continue;
    let info;
    try { info = await stat(file); } catch { continue; }
    if (info.size > maxFileBytes) continue;
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    totals.filesScanned++;
    const relative = path.relative(repo, file);
    const classes = [];
    for (const [className, pattern] of Object.entries(CLASSES)) {
      if (!pattern) continue;
      if (pattern.test(text)) classes.push(className);
    }
    if (extension === '.json' && (IDL_NAME.test(relative) || IDL_FILE.test(relative))) {
      let idl = null;
      try { idl = JSON.parse(text); } catch { idl = null; }
      const isIdl = idl && (Array.isArray(idl.instructions) || Array.isArray(idl.types)
        || (idl.metadata && idl.instructions));
      if (isIdl) classes.push('vendored-idl');
    }
    if (!classes.length) continue;
    // Which program ids does this file mention? A site is replaceable today
    // when it handles a program whose verified IDL is in the store.
    for (const match of text.matchAll(/['"]([1-9A-HJ-NP-Za-km-z]{32,44})['"]/g)) {
      if (storedPrograms.has(match[1])) programHits.add(match[1]);
    }
    for (const className of classes) {
      classTotals[className]++;
      if (own) ownClassTotals[className]++;
    }
    sites.push({ file: relative, classes });
  }
  totals.siteFiles += sites.length;
  totals.siteClassPairs += sites.reduce((sum, site) => sum + site.classes.length, 0);
  if (own) {
    ownSiteFiles += sites.length;
    ownSiteClassPairs += sites.reduce((sum, site) => sum + site.classes.length, 0);
  }
  perRepo.push({
    repo: name,
    own,
    origin: remote,
    owner,
    forkOf,
    siteFiles: sites.length,
    siteClassPairs: sites.reduce((sum, site) => sum + site.classes.length, 0),
    byClass: Object.fromEntries(Object.entries(CLASSES).map(([className]) =>
      [className, sites.filter((site) => site.classes.includes(className)).length])),
    programsWithStoredIdl: [...programHits],
    files: sites,
  });
}

perRepo.sort((a, b) => b.siteClassPairs - a.siteClassPairs);
const ownRepos = perRepo.filter((repo) => repo.own);
const forkRepos = perRepo.filter((repo) => repo.own === false && repo.owner && OWN_OWNERS.has(repo.owner) && repo.forkOf);
const thirdPartyRepos = perRepo.filter((repo) => !repo.own && !forkRepos.includes(repo) && repo.siteClassPairs > 0);
const report = {
  generatedAt: new Date().toISOString(),
  reposScanned: perRepo.length,
  filesScanned: totals.filesScanned,
  siteFiles: totals.siteFiles,
  siteClassPairs: totals.siteClassPairs,
  byClass: classTotals,
  own: {
    repos: ownRepos.length,
    siteFiles: ownSiteFiles,
    siteClassPairs: ownSiteClassPairs,
    byClass: ownClassTotals,
    perRepo: ownRepos.map((repo) => ({
      repo: repo.repo, siteFiles: repo.siteFiles, siteClassPairs: repo.siteClassPairs,
      byClass: repo.byClass, programsWithStoredIdl: repo.programsWithStoredIdl,
    })),
  },  thirdParty: {
    repos: thirdPartyRepos.length,
    siteFiles: thirdPartyRepos.reduce((sum, repo) => sum + repo.siteFiles, 0),
    siteClassPairs: thirdPartyRepos.reduce((sum, repo) => sum + repo.siteClassPairs, 0),
    note: 'checkouts of other people\'s code on this disk; not my decoder sites',
    perRepo: thirdPartyRepos.map((repo) => ({ repo: repo.repo, owner: repo.owner, siteClassPairs: repo.siteClassPairs })),
  },
  ownForks: {
    repos: forkRepos.length,
    siteFiles: forkRepos.reduce((sum, repo) => sum + repo.siteFiles, 0),
    siteClassPairs: forkRepos.reduce((sum, repo) => sum + repo.siteClassPairs, 0),
    note: 'my GitHub account, but the code is a fork of someone else\'s repository',
    perRepo: forkRepos.map((repo) => ({ repo: repo.repo, forkOf: repo.forkOf, siteClassPairs: repo.siteClassPairs })),
  },
  reposWithDecoderSites: perRepo.filter((repo) => repo.siteClassPairs > 0).length,
  store: { path: store, programs: [...storedPrograms] },
  notes: [
    'Two units are reported: `siteFiles` counts files holding at least one decoder artefact, `siteClassPairs` counts (file, class) pairs — the unit the workspace notes mean by "~99 decoder sites".',
    'A class is counted when the file contains a concrete decoder artefact of that class; one file can hold several classes, so siteClassPairs >= siteFiles.',
    'Counts are computed from the repositories on disk at scan time; they are not a claim about the whole ecosystem.',
    'Only repos whose origin is under auroraxo/ or sprintberlin/ AND that are not forks of another account count as own sites.',
    'Fork checkouts under my account (generated codecs of someone else\'s project) are reported separately as ownForks.',
    'Replaceability today requires the program\'s verified on-chain IDL to be present in the sememe store.',
    'The workspace notes estimate "~99 decoder sites" and "41 to replace"; this report is the computed counterpart and may disagree.',
  ],
  repos: perRepo,
};

if (outFile) {
  await writeFile(outFile, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`wrote ${outFile}`);
}
console.log(JSON.stringify({
  reposScanned: report.reposScanned,
  filesScanned: report.filesScanned,
  siteFilesAllCheckouts: report.siteFiles,
  siteClassPairsAllCheckouts: report.siteClassPairs,
  own: {
    repos: report.own.repos, siteFiles: report.own.siteFiles,
    siteClassPairs: report.own.siteClassPairs, byClass: report.own.byClass,
  },
  ownForks: { repos: report.ownForks.repos, siteClassPairs: report.ownForks.siteClassPairs, perRepo: report.ownForks.perRepo },
  thirdParty: { repos: report.thirdParty.repos, siteClassPairs: report.thirdParty.siteClassPairs },
  ownTopRepos: report.own.perRepo.slice(0, 12),
  programsWithStoredIdl: report.store.programs,
}, null, 1));
if (programs.length) {
  const known = new Set(programs);
  const mentioned = perRepo.filter((repo) => repo.programsWithStoredIdl.some((id) => known.has(id)));
  console.log(JSON.stringify({ reposMentioningGivenPrograms: mentioned.map((repo) => repo.repo) }, null, 1));
}
