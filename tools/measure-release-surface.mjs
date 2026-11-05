#!/usr/bin/env node
// measure-release-surface — what a stranger meets BEFORE installing sememe,
// and whether every claim on that surface is true.
//
// WHY (measured 2026-11-05, this repo, pre-fix tree 8cb2e13):
//   sememe deliberately does NOT publish to the npm registry — the README
//   says so in as many words ("no registry name squatting is part of the
//   plan; the git tag is the release artifact"). That makes the git tag the
//   ONLY install channel, and it makes two surfaces load-bearing:
//
//     1. the GitHub Releases page — where a stranger reads what a version
//        is and how to install it;
//     2. the README's install command and the claims printed around it —
//        what a stranger is told the installed package does.
//
//   Three defects were measured on those surfaces:
//
//     C1  five tags (v0.1.1..v0.3.0) and ZERO release pages. /releases is
//         empty: a stranger who opens the releases tab finds nothing.
//
//     C4  the README documents `sememe gap` (a bash block) and
//         `sememe/raydium` (the exports sentence) while pinning
//         `npm install github:auroraxo/sememe#v0.3.0`. That tree is 25
//         commits behind main and has NEITHER: its CLI has no `gap`
//         command and its exports map has no `raydium`. The copy-paste
//         install therefore yields a package the README around it does not
//         describe — the tag and the page disagree, exactly the class
//         signerd measured and fixed on 2026-11-05.
//
//     C5  the README asserts P and not-P about the same product: the status
//         line claims "Anchor event self-CPIs and account state, all
//         runnable" (and account decoding IS shipped — decodeStoredAccount
//         exists and is tested), while the pull-section Limit still says
//         "Account and event decoding ... remain proposals; only
//         instruction data is decoded today". A stranger reading top to
//         bottom meets both.
//
// WHAT IS MEASURED:
//   C1  the newest semver tag has a release page
//      -> defect missing-release-for-newest-tag
//   C2  the release GitHub marks "Latest" is the newest tag
//      -> defect stale-latest-release
//   C3  the tag the README PINS delivers everything the README documents:
//       every documented CLI command exists in that tree's CLI, and every
//       documented export subpath exists in that tree's exports map
//      -> defects readme-install-tag-missing-command:<cmd>,
//                  readme-install-tag-missing-export:<subpath>
//   C4  the README does not assert P and not-P about decode scope
//      -> defect readme-contradiction-decode-scope
//   C5  the release BODY makes no false claim where it is checkable: it
//       names an install command for a tag that exists, does not advertise
//       a cargo install (this repo has no Cargo.toml), imports only names
//       the entry really exports, and states at least one limit
//      -> defects body-no-install-command, body-install-tag-missing,
//                  body-advertises-cargo-install, body-nonexistent-api,
//                  body-no-limits
//
// FALSIFICATION RULES (the crates.io-403 lesson, generalized):
//   * A NETWORK failure is never an absence. If the release list cannot be
//     fetched authoritatively, the run is NO VERDICT (exit 3) — never "no
//     releases" and never "the surface is fine".
//   * A tree that cannot be read is NOT a clean tree: it is unmeasurable.
//   * Commands are read from FENCED CODE BLOCKS only. Prose that mentions
//     `sememe gap` is not a documented command.
//   * The contradiction rule applies to the LIVE README, never to a
//     historical tag tree: a published tag is immutable, so scoring it
//     would make the verdict permanently defective over a fact that can no
//     longer change.
//   * Every verdict is derived by a PURE function (derive) so the rules can
//     be pinned offline, without network.
//
// Usage: node tools/measure-release-surface.mjs [--out <file>]
//   Exit 0 = measured (clean or defective), 3 = no verdict.
'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.SEMEME_RELEASE_REPO || 'auroraxo/sememe';
const INSTALL_RE = /npm install github:auroraxo\/sememe#(v\d+(?:\.\d+){0,2})/g;
const BODY_INSTALL_RE = /npm install github:auroraxo\/sememe#(v[\d.]+)/i;

// ---------------------------------------------------------------- pure rules

export function semverOf(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function newestSemverTag(tags) {
  let best = null;
  let bestKey = null;
  for (const t of tags || []) {
    const k = semverOf(t);
    if (!k) continue;
    if (!bestKey || k[0] > bestKey[0] ||
        (k[0] === bestKey[0] && (k[1] > bestKey[1] ||
        (k[1] === bestKey[1] && k[2] > bestKey[2])))) {
      best = t;
      bestKey = k;
    }
  }
  return best;
}

// GitHub marks "Latest" on the most recently PUBLISHED, non-draft,
// non-prerelease release — NOT the highest semver. Both facts are needed:
// they disagree exactly when an older tag is published later, and that is
// still a stale surface for a reader.
export function latestReleaseOf(releases) {
  const published = (releases || []).filter((r) => r && !r.draft && !r.prerelease);
  if (!published.length) return null;
  const stamp = (r) => Date.parse(r.publishedAt || r.createdAt || '') || 0;
  return published.slice().sort((a, b) => stamp(b) - stamp(a))[0];
}

/** Fenced code blocks only — prose is not a claim. */
export function codeBlocks(markdown) {
  const out = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(markdown || '')))) out.push(m[1]);
  return out;
}

/**
 * The README's own claims, read from the document.
 *
 *  installTags          the tags the install command pins
 *  documentedCommands   CLI commands shown in a FENCED bash block
 *  documentedExports    `sememe/<subpath>` subpaths the README names
 *  shippedAccountEvent  the status line claims account+event decoding ships
 *  proposalInstructionOnly  a stale sentence claims only instruction data decodes
 *  hasQuickstart        a "## Quickstart" section exists
 */
export function parseReadme(markdown) {
  const md = String(markdown || '');

  const installTags = [];
  INSTALL_RE.lastIndex = 0;
  let m;
  while ((m = INSTALL_RE.exec(md))) if (!installTags.includes(m[1])) installTags.push(m[1]);

  // Commands are read from FENCED BASH BLOCKS only, and only when the
  // command sits at the start of a line. Two false positives were measured
  // on 2026-11-05 before this shape: (a) scanning all fenced blocks let a
  // ```json output block's "next": "sememe pull ..." count as documentation;
  // (b) an unanchored match let the quickstart's own
  // "git clone .../sememe && cd sememe" line, followed by
  // "node tools/stranger-decode.mjs", produce a command named "node".
  // Prose and JSON that MENTIONS a command are not documentation.
  const documentedCommands = [];
  const fenceRe = /```([A-Za-z]*)\n([\s\S]*?)```/g;
  let f;
  while ((f = fenceRe.exec(md))) {
    if (!/^(bash|sh|shell|zsh)$/i.test(f[1])) continue;
    const lineRe = /^(?:\s*\$\s+|\s+)?(?:node\s+bin\/sememe\.mjs|sememe)\s+([a-z][a-z0-9-]*)/gm;
    let c;
    while ((c = lineRe.exec(f[2]))) if (!documentedCommands.includes(c[1])) documentedCommands.push(c[1]);
  }

  // Export subpaths are named in backticks in the exports sentence. The
  // package name itself ("sememe") and CLI mentions ("sememe gap") are not
  // subpaths, so the pattern requires the slash.
  const documentedExports = [];
  const ex = /`sememe\/([a-z0-9][a-z0-9-]*)`/g;
  let e;
  while ((e = ex.exec(md))) if (!documentedExports.includes(e[1])) documentedExports.push(e[1]);

  return {
    installTags,
    documentedCommands,
    documentedExports,
    shippedAccountEvent: /Anchor event self-CPIs and account state/.test(md),
    proposalInstructionOnly: /only instruction data is decoded today/.test(md) ||
      /Account and event decoding[^.]*remain proposals/.test(md),
    hasQuickstart: /^##\s+Quickstart/m.test(md),
  };
}

export function bodyHasLimitStatement(body) {
  const s = String(body || '').toLowerCase();
  return (
    s.includes('no external user') ||
    s.includes('no outside user') ||
    s.includes('not an audit') ||
    s.includes('no audit') ||
    s.includes('user zero') ||
    s.includes('own-host measurement')
  );
}

/** Named imports from 'sememe' in the body's code blocks. */
export function bodyImportNames(body) {
  const found = [];
  for (const block of codeBlocks(body)) {
    const re = /import\s*\{([^}]*)\}\s*from\s*['"]sememe['"]/g;
    let m;
    while ((m = re.exec(block))) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) found.push(name);
      }
    }
  }
  return found;
}

/**
 * The release-body defects, for one release.
 * tree: { manifest, binCommands, exports, entryExports }
 */
export function bodyDefects(tag, tree, body) {
  const defects = [];
  if (typeof body !== 'string') return ['body-unreadable'];

  const m = BODY_INSTALL_RE.exec(body);
  if (!m) defects.push('body-no-install-command');
  if (body.includes('cargo install')) defects.push('body-advertises-cargo-install');

  const entryExports = tree && Array.isArray(tree.entryExports) ? tree.entryExports : null;
  if (entryExports) {
    for (const name of bodyImportNames(body)) {
      if (!entryExports.includes(name)) defects.push('body-nonexistent-api');
    }
  }
  if (!bodyHasLimitStatement(body)) defects.push('body-no-limits');
  return defects;
}

/**
 * The whole verdict, derived from measured surfaces.
 *
 * releases: [{ tag, body, draft, prerelease, publishedAt }]
 * tags:    [string]           every tag in the repo
 * readme:  parseReadme(...)   the LIVE README
 * trees:   { [tag]: { manifest, binCommands, exports, entryExports, readme } }
 */
export function derive({ releases, tags, readme, trees }) {
  const out = { verdict: 'clean', defects: [], perRelease: {}, noVerdict: false, reason: null };
  const fail = (reason) => { out.noVerdict = true; out.reason = reason; out.verdict = 'no-verdict'; return out; };

  if (!Array.isArray(releases)) return fail('release-list-unavailable');
  if (!Array.isArray(tags)) return fail('tags-unavailable');
  if (!readme || typeof readme !== 'object') return fail('readme-unreadable');

  const newest = newestSemverTag(tags);
  out.newestTag = newest;

  const byTag = new Map();
  for (const r of releases) {
    if (!r || r.draft) continue;
    byTag.set(r.tag, r);
  }

  // --- C1: the newest tag must have a release page
  if (newest && !byTag.has(newest)) out.defects.push('missing-release-for-newest-tag');

  // --- C2: the "Latest" badge must point at the newest tag
  const latest = latestReleaseOf(releases);
  out.latestTag = latest ? latest.tag : null;
  if (latest && newest && latest.tag !== newest) out.defects.push('stale-latest-release');

  // --- C3: the tag the README pins must deliver what the README documents
  const pinned = readme.installTags || [];
  out.pinnedTags = pinned;
  if (pinned.length) {
    for (const tag of pinned) {
      const tree = (trees || {})[tag];
      if (!tree) return fail('install-tag-tree-unreadable');
      const bin = Array.isArray(tree.binCommands) ? tree.binCommands : null;
      // The npm exports map is keyed "./native"; a README names "native".
      // Normalization happens HERE, inside the pure rules, so the verdict
      // cannot depend on how the caller shaped the tree (the live run
      // flagged every export as missing before this — measured).
      const exps = Array.isArray(tree.exports) ? normalizeExportsKeys(tree.exports) : null;
      if (!bin || !exps) return fail('install-tag-tree-unreadable');
      for (const cmd of readme.documentedCommands || []) {
        if (!bin.includes(cmd)) out.defects.push(`readme-install-tag-missing-command:${cmd}`);
      }
      for (const sub of readme.documentedExports || []) {
        if (!exps.includes(sub)) out.defects.push(`readme-install-tag-missing-export:${sub}`);
      }
    }
  }

  // --- C4: the LIVE README must not assert P and not-P about decode scope.
  // (Historical tag trees are immutable and are never scored here.)
  if (readme.shippedAccountEvent && readme.proposalInstructionOnly) {
    out.defects.push('readme-contradiction-decode-scope');
  }

  // --- C5: the release bodies
  for (const r of byTag.values()) {
    const tree = (trees || {})[r.tag];
    if (!tree) return fail('release-tree-unreadable');
    const defects = bodyDefects(r.tag, tree, r.body);
    out.perRelease[r.tag] = { defects };
    for (const d of defects) out.defects.push(`${r.tag}:${d}`);
    const m = BODY_INSTALL_RE.exec(String(r.body || ''));
    if (m && !tags.includes(m[1])) out.defects.push(`${r.tag}:body-install-tag-missing`);
  }

  if (out.defects.length) out.verdict = `defective:${out.defects.join('+')}`;
  return out;
}

// ------------------------------------------------------------- live measure

function ghApi(pathname) {
  return JSON.parse(execFileSync('gh', ['api', pathname], { encoding: 'utf8', timeout: 60000 }));
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function gitQuiet(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/**
 * The npm exports map is keyed with a leading "./" ("./native"), while a
 * README names the subpath without it ("sememe/native"). The live run
 * flagged EVERY documented export as missing before this normalization
 * (measured 2026-11-05) — the comparison must happen on the same shape.
 */
export function normalizeExportsKeys(exportsMap) {
  if (Array.isArray(exportsMap)) return exportsMap.map((k) => String(k).replace(/^\.\//, ''));
  return Object.keys(exportsMap || {}).map((k) => k.replace(/^\.\//, ''));
}

/** Names the entry really exports (parsed from the tag's index.mjs). */
export function entryExportsOf(source) {
  const names = new Set();
  const src = String(source || '');
  const blockRe = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = blockRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  const declRe = /export\s+(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(src))) names.add(m[1]);
  return [...names].sort();
}

/** CLI commands the tree's bin really implements. */
export function binCommandsOf(source) {
  const out = new Set();
  const re = /command\s*===\s*'([a-z][a-z0-9-]*)'/g;
  let m;
  while ((m = re.exec(String(source || '')))) out.add(m[1]);
  return [...out].sort();
}

function readTree(tag) {
  const manifestRaw = gitQuiet(['show', `${tag}:package.json`]);
  const binRaw = gitQuiet(['show', `${tag}:bin/sememe.mjs`]);
  const indexRaw = gitQuiet(['show', `${tag}:index.mjs`]);
  const readmeRaw = gitQuiet(['show', `${tag}:README.md`]);
  if (manifestRaw === null || binRaw === null || indexRaw === null) return null;
  let manifest = null;
  try { manifest = JSON.parse(manifestRaw); } catch { manifest = null; }
  if (!manifest) return null;
  return {
    manifest: { version: manifest.version, private: manifest.private === true },
    binCommands: binCommandsOf(binRaw),
    // "./native" -> "native", so a documented subpath and an exports-map
    // key can be compared directly (the live run flagged every export as
    // missing before this normalization — measured, fixed).
    exports: normalizeExportsKeys(manifest.exports),
    entryExports: entryExportsOf(indexRaw),
    readme: readmeRaw === null ? null : parseReadme(readmeRaw),
  };
}

export function measure(outPath) {
  const report = { measuredAt: new Date().toISOString(), repo: REPO, surfaces: {} };

  // 1. the release list — authoritative or nothing
  let releases;
  try {
    releases = ghApi(`repos/${REPO}/releases?per_page=100`);
  } catch (err) {
    const msg = `gh api repos/${REPO}/releases failed: ${String(err.message).split('\n')[0]}`;
    report.noVerdict = true;
    report.reason = 'release-list-unavailable';
    report.error = msg;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(`FATAL ${msg}\n`);
    return 3;
  }

  const norm = (releases || []).map((r) => ({
    tag: r.tag_name,
    body: typeof r.body === 'string' ? r.body : null,
    draft: Boolean(r.draft),
    prerelease: Boolean(r.prerelease),
    publishedAt: r.published_at || r.created_at,
    createdAt: r.created_at,
  }));
  // The full normalized list is stored (bodies included) so the committed
  // artifact re-derives the verdict offline — a hand-edited verdict goes red.
  report.surfaces.releases = norm;

  // 2. every tag in the repo (offline, from the local object store)
  const tags = String(git(['tag', '-l']) || '').split('\n').map((t) => t.trim()).filter(Boolean);
  report.surfaces.tags = tags;

  // 3. the LIVE README (at HEAD, so the measurement is reproducible from a commit)
  const readmeRaw = gitQuiet(['show', 'HEAD:README.md']);
  if (readmeRaw === null) {
    report.noVerdict = true;
    report.reason = 'readme-unreadable';
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    process.stderr.write('FATAL readme unreadable at HEAD\n');
    return 3;
  }
  const readme = parseReadme(readmeRaw);
  report.surfaces.readme = readme;

  // 4. the tree behind every release and behind every pinned install tag
  const trees = {};
  const wanted = new Set([...norm.map((r) => r.tag), ...readme.installTags]);
  for (const tag of wanted) {
    const tree = readTree(tag);
    if (tree) trees[tag] = tree;
  }
  report.surfaces.trees = trees;

  const verdict = derive({ releases: norm, tags, readme, trees });
  report.verdict = {
    verdict: verdict.verdict,
    defects: verdict.defects,
    newestTag: verdict.newestTag,
    latestTag: verdict.latestTag,
    pinnedTags: verdict.pinnedTags,
  };
  report.perRelease = verdict.perRelease;
  report.noVerdict = verdict.noVerdict;
  report.reason = verdict.reason;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report.verdict) + `\nartifact: ${outPath}\n`);
  return verdict.noVerdict ? 3 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const out = i >= 0 && argv[i + 1]
    ? argv[i + 1]
    : path.join(ROOT, 'research', `release-surface-${new Date().toISOString().slice(0, 10)}.json`);
  process.exit(measure(out));
}
