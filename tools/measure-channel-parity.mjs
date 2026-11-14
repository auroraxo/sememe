#!/usr/bin/env node
// tools/measure-channel-parity.mjs — DO THE TWO RELEASE CHANNELS DELIVER THE SAME BYTES?
//
// MEASURED 2026-11-14, on the sememe tree at main 8475e52:
//
// The README claims (README.md, install section):
//   "`npm install sememe` and `npm install github:auroraxo/sememe#v0.4.27` deliver
//    the same product files from the same code"
// and the release-surface contract (tools/measure-release-surface.mjs) checks the
// newest tag against the README. NOTHING checks the OTHER direction: whether the
// bytes the npm registry actually serves for a published version are the bytes the
// git tag of the same name carries.
//
// This tool measures exactly that gap, per published version, and it is the gap
// that found the defect recorded in research/channel-parity-2026-11-14.json:
//
//   * sememe@0.4.21 (npm) ships src/rawle.mjs. The tag v0.4.21 does NOT contain
//     that file — the registry tarball was published from commit 05e6643, which
//     is a DESCENDANT of the tag commit a0cfd70 (05e6643 adds the raw-LE
//     engine; 3401f9f, the later commit that wires it into the product, is not
//     in the registry tarball either). A stranger pinning "0.4.21" therefore
//     gets DIFFERENT bytes depending on the channel they pick, and the registry
//     copy carries a product file the tag copy does not have.
//   * sememe@0.4.22 (npm) was published from 40204fd, one commit AFTER the tag
//     commit 725d946: only README.md differs (the release-record block). The
//     product files are byte-identical — a doc divergence, not a code one.
//   * sememe@0.4.23 … 0.4.27: the registry tarball and the tag deliver the same
//     files with the same bytes, and npm's own `gitHead` equals the tag commit.
//   * sememe@0.0.0-stage is a PLACEHOLDER (package.json: "stub": true,
//     "Temporary package placeholder for staged publishing") with only
//     package.json + README.md in it and NO git tag of that name.
//
// The first two divergences are IMMUTABLE: npm versions and git tags cannot be
// rewritten. So the honest remedy is not a fix but a NAMED, MEASURED record plus
// a gate that keeps the NEXT release honest — this tool, and its pin
// (test/channel-parity.test.mjs), are that gate.
//
// METHOD (per published version):
//   1. registry side: `npm pack sememe@<version>` -> the exact tarball the
//      registry serves -> per-file sha256.
//   2. tag side: `git archive v<version>` into a temp tree -> `npm pack` of THAT
//      tree -> the exact bytes a `github:auroraxo/sememe#v<version>` install
//      gets -> per-file sha256.
//   3. compare the two file sets, file by file, byte for byte.
//   4. compare npm's own `gitHead` with the tag commit and classify the
//      relation (same / descendant / ancestor / unrelated) with git itself.
//
// CLASSIFICATION (per version):
//   parity             every shipped file identical
//   product-divergence a product file (index.mjs, src/, interface/, vendor/,
//                     bin/, LICENSE, package.json) differs or is missing on one
//                     side — a consumer installing from the two channels gets
//                     different code
//   doc-divergence     ONLY README.md differs — the code is the same, the
//                     release record is not
//   stage-placeholder   a published version that is a deliberate stub
//   no-tag             a published version with no git tag of that name
//
// EXIT CODES: 0 = measured (the artifact is written), 2 = bad usage,
//             3 = NO VERDICT (network/registry failure — never "parity").
//
// USAGE:
//   node tools/measure-channel-parity.mjs --out research/channel-parity-2026-11-14.json
//   node tools/measure-channel-parity.mjs --verify research/channel-parity-2026-11-14.json
//
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_DEFAULT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let ROOT = ROOT_DEFAULT;

// Files the package actually ships to a consumer. A divergence in one of these
// is a divergence in the CODE a consumer runs.
const PRODUCT_PREFIXES = ['index.mjs', 'src/', 'interface/', 'vendor/', 'bin/'];
const PRODUCT_EXACT = new Set(['package.json', 'LICENSE']);

function isProductFile(rel) {
  if (PRODUCT_EXACT.has(rel)) return true;
  return PRODUCT_PREFIXES.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

function parseArgs(argv) {
  const out = { outPath: null, verifyPath: null, only: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.outPath = argv[++i];
    else if (a === '--verify') out.verifyPath = argv[++i];
    else if (a === '--only') out.only = argv[++i];
    // The mutation ladder runs a MUTATED copy of this file from outside the
    // repository; --root keeps every `git`/path lookup pointed at the real
    // tree so only the mutated logic differs.
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function die(msg, code) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Every file under `dir`, keyed by its path relative to `dir`. */
function fileMap(dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) fileMap(full, base, out);
    else if (entry.isFile()) out.set(rel, sha256(full));
  }
  return out;
}

/** Unpack a .tgz into a fresh dir and return the path of the `package/` root. */
function unpack(tgz, workDir) {
  run('tar', ['xzf', tgz, '-C', workDir]);
  const root = path.join(workDir, 'package');
  if (!existsSync(root)) throw new Error(`tarball ${path.basename(tgz)} has no package/ root`);
  return root;
}

/** The registry side: the exact tarball the npm registry serves. */
function registryTarball(version, workDir) {
  run('npm', ['pack', `sememe@${version}`, '--silent', '--pack-destination', workDir]);
  const tgz = readdirSync(workDir).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tarball for sememe@${version}`);
  return path.join(workDir, tgz);
}

/** The tag side: the exact bytes a `github:auroraxo/sememe#v<version>` install gets. */
function tagTarball(version, workDir) {
  const tag = `v${version}`;
  // A missing tag is a MEASURED FACT, not an error: `git rev-parse --verify`
  // exits non-zero, so the probe is allowed to fail and its (empty) output
  // decides.
  let probe = '';
  try {
    probe = run('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]);
  } catch {
    probe = '';
  }
  if (!probe.trim()) return { tag, commit: null, tarball: null };
  const tree = mkdtempSync(path.join(workDir, 'tree-'));
  run('bash', ['-c', `git archive ${tag} | tar x -C ${tree}`]);
  run('npm', ['pack', '--silent', '--pack-destination', workDir], { cwd: tree });
  const tgz = readdirSync(workDir).find((f) => f.endsWith('.tgz') && f.includes('sememe'));
  if (!tgz) throw new Error(`npm pack of tag ${tag} produced no tarball`);
  return { tag, commit: probe.trim(), tarball: path.join(workDir, tgz) };
}

/** How does npm's gitHead relate to the tag commit? */
function classifyCommitRelation(gitHead, tagCommit) {
  if (!gitHead || !tagCommit) return 'unknown';
  if (gitHead === tagCommit) return 'same';
  const isAncestor = (a, b) => {
    try {
      run('git', ['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  };
  if (isAncestor(tagCommit, gitHead)) return 'gitHead-is-descendant-of-tag';
  if (isAncestor(gitHead, tagCommit)) return 'gitHead-is-ancestor-of-tag';
  return 'unrelated';
}

function npmField(version, field) {
  try {
    const out = run('npm', ['view', `sememe@${version}`, field, '--json']);
    const parsed = JSON.parse(out);
    return typeof parsed === 'string' ? parsed : (parsed === null ? null : parsed);
  } catch {
    return null;
  }
}

function publishedVersions() {
  const out = run('npm', ['view', 'sememe', 'versions', '--json']);
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed)) throw new Error('npm view sememe versions did not return a list');
  // A positive control: if a known package does not resolve, this host's
  // registry egress is broken and every verdict below would be worthless.
  try {
    run('npm', ['view', 'express', 'version', '--json']);
  } catch {
    throw new Error('registry positive control failed (express does not resolve) — no verdict');
  }
  return parsed;
}

function compare(registryRoot, tagRoot) {
  const reg = fileMap(registryRoot);
  const tag = fileMap(tagRoot);
  const keys = [...new Set([...reg.keys(), ...tag.keys()])].sort();
  const onlyRegistry = [];
  const onlyTag = [];
  const differing = [];
  for (const k of keys) {
    const r = reg.get(k);
    const t = tag.get(k);
    if (r && !t) onlyRegistry.push(k);
    else if (!r && t) onlyTag.push(k);
    else if (r !== t) differing.push(k);
  }
  return { registryFiles: reg.size, tagFiles: tag.size, onlyRegistry, onlyTag, differing };
}

function classifyVersion(version, cmp, meta) {
  if (meta.stub) return 'stage-placeholder';
  if (!meta.tagCommit) return 'no-tag';
  if (!cmp) return 'no-tag';
  const productDiff = [...cmp.onlyRegistry, ...cmp.onlyTag, ...cmp.differing].filter(isProductFile);
  if (productDiff.length) return 'product-divergence';
  const docDiff = [...cmp.onlyRegistry, ...cmp.onlyTag, ...cmp.differing].filter((k) => !isProductFile(k));
  if (docDiff.length) return 'doc-divergence';
  return 'parity';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(0, 45).join('\n'));
    return;
  }
  if (!args.outPath && !args.verifyPath) die('usage: --out <file> | --verify <file> [--root <repo>] [--only <version>]', 2);
  if (args.root) ROOT = path.resolve(args.root);

  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'sememe-channel-parity-'));
  let versions;
  try {
    versions = publishedVersions();
  } catch (err) {
    rmSync(workRoot, { recursive: true, force: true });
    die(`NO VERDICT: ${err.message}`, 3);
  }
  if (args.only) versions = versions.filter((v) => v === args.only);

  const results = [];
  for (const version of versions) {
    const regWork = mkdtempSync(path.join(workRoot, 'reg-'));
    const tagWork = mkdtempSync(path.join(workRoot, 'tag-'));
    let entry;
    try {
      const regTgz = registryTarball(version, regWork);
      const regRoot = unpack(regTgz, regWork);
      const pkg = JSON.parse(readFileSync(path.join(regRoot, 'package.json'), 'utf8'));
      const tag = tagTarball(version, tagWork);
      const tagRoot = tag.tarball ? unpack(tag.tarball, tagWork) : null;
      const cmp = tagRoot ? compare(regRoot, tagRoot) : null;
      const gitHead = npmField(version, 'gitHead');
      const meta = {
        stub: pkg.stub === true,
        tagCommit: tag.commit,
        gitHead: gitHead || null,
      };
      entry = {
        version,
        publishedAt: null,
        npmGitHead: meta.gitHead,
        tag: tag.tag,
        tagCommit: meta.tagCommit,
        commitRelation: classifyCommitRelation(meta.gitHead, meta.tagCommit),
        classification: classifyVersion(version, cmp, meta),
        registryFiles: cmp ? cmp.registryFiles : null,
        tagFiles: cmp ? cmp.tagFiles : null,
        onlyInRegistry: cmp ? cmp.onlyRegistry : null,
        onlyInTag: cmp ? cmp.onlyTag : null,
        differingBytes: cmp ? cmp.differing : null,
        productFilesAffected: cmp
          ? [...cmp.onlyRegistry, ...cmp.onlyTag, ...cmp.differing].filter(isProductFile)
          : null,
        docFilesAffected: cmp
          ? [...cmp.onlyRegistry, ...cmp.onlyTag, ...cmp.differing].filter((k) => !isProductFile(k))
          : null,
        note: meta.stub
          ? 'published placeholder: package.json carries "stub": true and a temporary-description; it ships no product code'
          : null,
      };
    } catch (err) {
      rmSync(workRoot, { recursive: true, force: true });
      die(`NO VERDICT: registry side failed for sememe@${version}: ${err.message}`, 3);
    }
    rmSync(regWork, { recursive: true, force: true });
    rmSync(tagWork, { recursive: true, force: true });
    results.push(entry);
  }

  const summary = {
    measured: results.length,
    parity: results.filter((r) => r.classification === 'parity').length,
    productDivergence: results.filter((r) => r.classification === 'product-divergence').length,
    docDivergence: results.filter((r) => r.classification === 'doc-divergence').length,
    stagePlaceholder: results.filter((r) => r.classification === 'stage-placeholder').length,
    noTag: results.filter((r) => r.classification === 'no-tag').length,
  };

  const artifact = {
    tool: 'tools/measure-channel-parity.mjs',
    measuredAt: new Date().toISOString(),
    tree: run('git', ['rev-parse', 'HEAD']).trim(),
    package: 'sememe',
    question: 'do the npm registry tarball and the git tag of the same version deliver the same bytes?',
    summary,
    versions: results,
    verdict: summary.productDivergence > 0
      ? 'channel-parity-broken'
      : (summary.docDivergence > 0 ? 'channel-parity-doc-only' : 'channel-parity-clean'),
    limits: [
      'Both sides are measured through npm pack: the registry side is the tarball the registry serves, the tag side is the tarball npm builds from the exported tag tree — which is what `npm install github:auroraxo/sememe#v<version>` installs.',
      'A divergence that npm already published is immutable: npm versions and git tags cannot be rewritten. This measurement NAMES the divergence and gates the next release; it does not repair the past.',
      'Only the file CONTENT of the shipped package is compared. Runtime behaviour of the two channels is compared separately (the registry user-zero probe).',
    ],
  };

  if (args.outPath) {
    const outPath = path.resolve(ROOT, args.outPath);
    writeFileSync(outPath, JSON.stringify(artifact, null, 1) + '\n');
    process.stdout.write(JSON.stringify(artifact.verdict) + '\n');
    process.stdout.write(`artifact: ${outPath}\n`);
    for (const r of results) {
      process.stdout.write(
        `  ${r.version.padEnd(10)} ${r.classification.padEnd(20)}`
        + ` gitHead=${(r.npmGitHead || '-').slice(0, 8)} tag=${(r.tagCommit || '-').slice(0, 8)}`
        + ` ${r.commitRelation}`
        + `${r.productFilesAffected && r.productFilesAffected.length ? ` product=[${r.productFilesAffected.join(', ')}]` : ''}`
        + `${r.docFilesAffected && r.docFilesAffected.length ? ` doc=[${r.docFilesAffected.join(', ')}]` : ''}\n`,
      );
    }
  }

  if (args.verifyPath) {
    const expected = JSON.parse(readFileSync(path.resolve(ROOT, args.verifyPath), 'utf8'));
    const sameVerdict = expected.verdict === artifact.verdict;
    const sameSummary = JSON.stringify(expected.summary) === JSON.stringify(artifact.summary);
    const sameVersions = JSON.stringify(
      expected.versions.map((v) => [v.version, v.classification, v.npmGitHead, v.tagCommit]),
    ) === JSON.stringify(
      artifact.versions.map((v) => [v.version, v.classification, v.npmGitHead, v.tagCommit]),
    );
    if (!sameVerdict || !sameSummary || !sameVersions) {
      process.stderr.write(
        `VERIFY FAILED: verdict ${sameVerdict} summary ${sameSummary} versions ${sameVersions}\n`,
      );
      rmSync(workRoot, { recursive: true, force: true });
      process.exit(3);
    }
    process.stdout.write('VERIFY OK: the live registry reproduces the committed artifact\n');
  }

  rmSync(workRoot, { recursive: true, force: true });
}

main();
