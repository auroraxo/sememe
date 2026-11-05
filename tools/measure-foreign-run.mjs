// Measure whether anyone OUTSIDE the owner has run, referenced, or installed
// sememe — the card's stated adoption gate ("ein fremder Lauf"), previously
// asserted in prose (e.g. "0 Fremdnutzer", "adoption 0") instead of measured.
//
// Sibling of signerd's tools/measure-adoption.mjs, with sememe's own channels
// and the false-positive lessons from the 2026-11-03 signerd sweep baked in:
//
//   1. Repo metadata + owner-only contributor census.
//   2. Star/fork census with the owner excluded (a star by auroraxo is not
//      adoption).
//   3. Issue/PR census on the repo itself with the owner and bots excluded —
//      an outsider opening an issue is the cheapest form of run evidence.
//   4. Outbound threads the owner opened in FOREIGN repos (step-ingestooor#1,
//      jup-ag/rfq-webhook-toolkit#96): merged/closed is distribution, a
//      non-owner comment is the first real run signal. Never read as
//      adoption by itself.
//   5. The BROAD mention sweep ("sememe" in:body) that finds threads the
//      exact-slug literal misses (measured 2026-11-05: GitHub's index does
//      not tokenize the URL literal — step-ingestooor#1 contains the URL but
//      only answers a repo-scoped or term query). Precision comes from LOCAL
//      verification of each hit, not from the query:
//        a. must contain the literal slug "auroraxo/sememe" in the body;
//        b. must postdate the repo's creation date (pre-creation hits are
//           the linguistics term: thunlp/OpenHowNet et al.);
//        c. author classification: the owner's own threads are distribution,
//           a non-owner author (or non-owner comment on the owner's thread)
//           is the stranger signal.
//      A hit that fails (a) or (b) is counted in its own named bucket —
//      collision noise is measured, not silently dropped.
//   6. Registry consumption: the bare name `sememe` measured live on npm,
//      crates.io and PyPI. npm is the only install path documented today
//      (git tag), so `not-found` means no install channel exists yet —
//      recorded as channel-absent, NOT as no-consumption (a 404 cannot
//      witness how many people cloned the git tag). crates.io/PyPI absence
//      is an aliasing check. Network failure on any registry = NO VERDICT
//      (the crates.io-403 lesson: a client defect must never be recorded as
//      measured absence).
//   7. GitHub code index for the slug, guarded by a SELF-REFERENCE positive
//      control: the sweep must find the slug in the owner's own indexed repo
//      (sprintberlin/openclaw-citizen) or the index is treated as blind and
//      no absence claim is made from it (the 2026-11-03 lesson).
//   8. Traffic (views/clones/referrers) as context. Clone counts are
//      CI-inflated (own CI pulls the repo every push) and never count as
//      consumption.
//
// Classification, derived only from complete measurements:
//   user-one-evidence        : any non-owner signal from checks 2/3/5
//                              (or a non-owner comment on an outbound thread)
//   distributed-not-consumed : owner threads delivered/merged, zero
//                              non-owner signals
//   not-distributed-not-consumed : nothing delivered, zero non-owner signals
//
// Exit codes: 0 = measurement complete (any verdict), 3 = a data source
// failed or was partial — no verdict is issued on partial evidence.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import { bucketMention, classify } from './lib/foreign-run-classify.mjs';

const REPO = process.env.ADOPTION_REPO || 'auroraxo/sememe';
const OWNER = process.env.ADOPTION_OWNER || REPO.split('/')[0];
const OUTBOUND = (process.env.ADOPTION_OUTBOUND || 'step-finance-oss/step-ingestooor#1,jup-ag/rfq-webhook-toolkit#96')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SELF_REF_REPO = process.env.ADOPTION_SELF_REF_REPO || 'sprintberlin/openclaw-citizen';
const BROAD_QUERY = process.env.ADOPTION_BROAD_QUERY || 'sememe in:body';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : null;
const USER_AGENT = 'auroraxo-sememe-adoption-probe';

const startedAt = new Date().toISOString();
const failures = [];
const warnings = [];

function gh(args, optional = false) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout: 60000 })
    );
  } catch (err) {
    const msg = `gh api ${args.join(' ')} failed: ${String(err.message).split('\n')[0]}`;
    if (optional) {
      failures.push(msg);
      return null;
    }
    console.error('FATAL ' + msg);
    process.exit(3);
  }
}

// Network fetch with a User-Agent (crates.io refuses UA-less requests with a
// 403 — that was once misread as "absence measured"). DNS/socket failures and
// non-JSON bodies are client/network defects, never evidence of absence.
function fetchJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { host: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} from ${u.host}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`non-JSON body from ${u.host}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.setHeader('User-Agent', USER_AGENT);
    req.setHeader('Accept', 'application/json');
    req.end();
  });
}

// ---- 1. repo metadata + contributor census ---------------------------------
const repo = gh([`repos/${REPO}`]);
const createdAt = repo.created_at; // ISO — the pre-creation boundary
const contributors = gh([`repos/${REPO}/contributors?per_page=100`]) || [];
const nonOwnerContributors = contributors.filter((c) => c.login && c.login !== OWNER);
const checks = {
  repoMetadata: {
    public: !repo.private,
    license: repo.license && repo.license.spdx_id,
    createdAt,
    ok: !repo.private,
  },
};

// ---- 2/3. stars, forks, own-repo issues/PRs, owner + bots excluded --------
const stargazers = gh([`repos/${REPO}/stargazers?per_page=100`], true) || [];
const forks = gh([`repos/${REPO}/forks?per_page=100`], true) || [];
const nonOwnerStars = (stargazers || []).filter((s) => s.login && s.login !== OWNER);
const nonOwnerForks = (forks || []).filter((f) => f.owner && f.owner.login !== OWNER);
const ownIssues = gh([`repos/${REPO}/issues?state=all&per_page=100`]) || [];
const externalIssues = (ownIssues || []).filter(
  (i) => i.user && i.user.login !== OWNER && !i.user.login.endsWith('[bot]')
);
checks.starForkCensus = {
  starsTotal: repo.stargazers_count,
  forksTotal: repo.forks_count,
  nonOwnerStars: nonOwnerStars.map((s) => s.login),
  nonOwnerForks: nonOwnerForks.map((f) => f.owner.login),
  ok: true,
};
checks.ownIssueCensus = {
  total: (ownIssues || []).length,
  external: externalIssues.map((i) => ({
    n: i.number,
    author: i.user.login,
    isPR: Boolean(i.pull_request),
    title: i.title,
  })),
  ok: true,
};

// ---- 4. outbound threads in foreign repos ---------------------------------
const outbound = [];
for (const ref of OUTBOUND) {
  const m = ref.match(/^(.+)#(\d+)$/);
  if (!m) {
    failures.push(`unparseable outbound ref: ${ref}`);
    continue;
  }
  const [orepo, onum] = [m[1], m[2]];
  const issue = gh([`repos/${orepo}/issues/${onum}`], true);
  if (!issue) continue; // failure already recorded by gh()
  const comments = gh([`repos/${orepo}/issues/${onum}/comments?per_page=100`], true) || [];
  if (comments === null) continue;
  const nonOwnerComments = (comments || []).filter(
    (c) => c.user && c.user.login !== OWNER && !c.user.login.endsWith('[bot]')
  );
  outbound.push({
    ref,
    state: issue.state,
    mergedOrClosed: issue.state === 'closed',
    commentsTotal: (comments || []).length,
    nonOwnerComments: nonOwnerComments.map((c) => ({
      user: c.user.login,
      createdAt: c.created_at,
    })),
  });
}

// ---- 5. broad mention sweep with LOCAL verification ------------------------
// The exact-slug literal is unreliable in BOTH directions: it misses real
// threads (step-ingestooor#1, measured 2026-11-05) and the bare term drags
// in linguistics collisions. So: broad query for recall, local checks for
// precision, every hit lands in a named bucket.
const sweep = gh(
  [`search/issues?q=${encodeURIComponent(BROAD_QUERY)}&per_page=100&sort=created&order=desc`],
  true
);
let broadTotal = null;
let broadFetched = 0;
let sweepItems = [];
let remainder = null; // measured index-hidden results across orderings
const buckets = {
  selfAuthoredSlug: [], // owner's own outbound threads (distribution, not adoption)
  foreignSlugPost: [], // non-owner author, contains slug, after creation
  foreignSlugPre: [], // slug present but created BEFORE the repo — stale index
  termCollision: [], // no slug in body — the linguistics term / other sememes
};
if (sweep) {
  broadTotal = sweep.total_count;
  sweepItems = [...(sweep.items || [])];
  // GitHub's search total_count can include results it never returns in ANY
  // ordering (measured 2026-11-05: total 93, fetched 92 on created/comments/
  // updated alike). Paginate the primary ordering, then MEASURE the remainder
  // across two more orderings: a stable remainder is the index quirk (named
  // limit, verdict carries it); a flaky one is a fetch defect -> NO VERDICT.
  for (let page = 2; page <= 10 && sweepItems.length < (broadTotal ?? 0); page++) {
    const next = gh(
      [`search/issues?q=${encodeURIComponent(BROAD_QUERY)}&per_page=100&page=${page}&sort=created&order=desc`],
      true
    );
    if (!next || !next.items || next.items.length === 0) break;
    sweepItems.push(...next.items);
  }
  if (broadTotal !== null && sweepItems.length < broadTotal && broadTotal <= 100) {
    const seen = new Set(sweepItems.map((i) => i.id));
    const perOrderCounts = [];
    for (const order of ['comments', 'updated']) {
      const alt = gh(
        [`search/issues?q=${encodeURIComponent(BROAD_QUERY)}&per_page=100&sort=${order}&order=desc`],
        true
      );
      if (alt && alt.items) {
        perOrderCounts.push(alt.items.length);
        for (const it of alt.items) {
          if (!seen.has(it.id)) {
            seen.add(it.id);
            sweepItems.push(it);
          }
        }
      }
    }
    remainder = {
      total: broadTotal,
      unionFetched: seen.size,
      hidden: broadTotal - seen.size,
      perOrderFetched: perOrderCounts,
      // stable = every ordering returned the same near-total count; a wider
      // spread means the fetch itself is unreliable, not the index
      stable: perOrderCounts.length === 2 && new Set(perOrderCounts).size === 1,
    };
  }
  broadFetched = sweepItems.length;
  for (const it of sweepItems) {
    const body = it.body || '';
    const repoFull = String(it.repository_url || '').replace('https://api.github.com/repos/', '');
    const author = it.user ? it.user.login : '?';
    const label = `${repoFull}#${it.number} by ${author} (${it.created_at.slice(0, 10)})`;
    const bucket = bucketMention(
      { body, author, createdAt: it.created_at },
      { owner: OWNER, slug: `${OWNER}/${REPO.split('/')[1]}`, repoCreatedAt: createdAt }
    );
    buckets[bucket].push(label);
  }
  if (broadTotal !== null && broadFetched < broadTotal) {
    // A measured-stable remainder (identical near-total fetches across
    // orderings, <=2 hidden in 100) is GitHub's own index quirk, recorded as
    // a NAMED LIMIT — the verdict below carries `indexHidden`. Anything else
    // is an unreliable fetch and kills the verdict.
    const okRemainder =
      remainder &&
      remainder.stable &&
      remainder.hidden <= 2 &&
      remainder.unionFetched >= broadTotal - 2;
    if (!okRemainder) {
      failures.push(
        `broad sweep partial: fetched ${broadFetched} of ${broadTotal}` +
          (remainder
            ? ` (union ${remainder.unionFetched} across orderings, stable=${remainder.stable})`
            : ' (no cross-ordering measurement)')
      );
    } else {
      warnings.push(
        `index remainder: ${remainder.hidden} of ${broadTotal} results hidden by GitHub search in every measured ordering — sweep covers ${remainder.unionFetched}/${broadTotal}; the hidden item(s) are NOT classified`
      );
    }
  }
}

// ---- 7. code index with self-reference positive control --------------------
const codeSelf = gh(
  [`search/code?q=${encodeURIComponent(`${OWNER}/${REPO.split('/')[1]} repo:${SELF_REF_REPO}`)}&per_page=10`],
  true
);
let codeIndexSweep = null;
if (codeSelf !== null && (codeSelf.total_count ?? 0) > 0) {
  const codeAll = gh(
    [`search/code?q=${encodeURIComponent(`${OWNER}/${REPO.split('/')[1]}`)}&per_page=100`],
    true
  );
  if (codeAll !== null) {
    const items = (codeAll.items || []).map((i) => ({
      repo: i.repository.full_name,
      path: i.path,
      own: i.repository.full_name === REPO || i.repository.full_name === SELF_REF_REPO,
    }));
    codeIndexSweep = {
      selfControlHits: codeSelf.total_count,
      total: codeAll.total_count ?? null,
      fetched: items.length,
      foreign: items.filter((i) => !i.own),
      ok: true,
    };
  }
} else if (codeSelf !== null) {
  codeIndexSweep = {
    selfControlHits: 0,
    ok: false,
    note: 'self-reference control found nothing in an indexed own repo — index treated as blind, no absence claim from code search',
  };
  warnings.push('code index self-control 0/0: absence from code search NOT recorded');
}

// ---- 6. registries (async block) -------------------------------------------
const registries = { npm: null, cratesIo: null, pypi: null };
let registryFailure = null;
try {
  const [npmExact, cratesExact, pypiExact, npmControl, cratesControl] = await Promise.all([
    fetchJson('https://registry.npmjs.org/sememe').then(
      () => 'found',
      () => 'not-found'
    ),
    fetchJson('https://crates.io/api/v1/crates/sememe').then(
      () => 'found',
      () => 'not-found'
    ),
    fetchJson('https://pypi.org/pypi/sememe/json').then(
      () => 'found',
      () => 'not-found'
    ),
    // positive controls: these names MUST resolve, or this host's egress is
    // broken and every not-found above is worthless
    fetchJson('https://registry.npmjs.org/express').then(
      () => 'ok',
      (e) => 'control-failed: ' + e.message
    ),
    fetchJson('https://crates.io/api/v1/crates/serde').then(
      () => 'ok',
      (e) => 'control-failed: ' + e.message
    ),
  ]);
  registries.npm = npmExact;
  registries.cratesIo = cratesExact;
  registries.pypi = pypiExact;
  registries.controls = { npm: npmControl, cratesIo: cratesControl };
  for (const [name, v] of Object.entries(registries.controls)) {
    if (v !== 'ok') {
      registryFailure = `registry positive control ${name}: ${v}`;
    }
  }
} catch (e) {
  registryFailure = `registry probe failed: ${e.message}`;
}
if (registryFailure) failures.push(registryFailure);

// ---- 8. traffic (context only) ---------------------------------------------
const views = gh([`repos/${REPO}/traffic/views`], true);
const clones = gh([`repos/${REPO}/traffic/clones`], true);
const referrers = gh([`repos/${REPO}/traffic/popular/referrers`], true) || [];
const externalReferrers = (referrers || []).filter(
  (r) => r.referrer && !/(^|\.)github\.com$/i.test(r.referrer)
);
checks.traffic = {
  window: 'last 14 days, GitHub-fixed buckets',
  views: views ? { count: views.count, uniques: views.uniques } : null,
  clones: clones ? { count: clones.count, uniques: clones.uniques } : null,
  caveat:
    'clone count includes every CI checkout of this repo (own CI pulls it per push); never a consumption signal',
  externalReferrers: externalReferrers.map((r) => r.referrer),
  ok: Boolean(views && clones),
};

// ---- classification ---------------------------------------------------------
const signals = [
  ...nonOwnerStars.map((l) => `star by ${l}`),
  ...nonOwnerForks.map((l) => `fork by ${l}`),
  ...externalIssues.map((i) => `${i.pull_request ? 'PR' : 'issue'} #${i.number} by ${i.user.login}`),
  ...buckets.foreignSlugPost.map((l) => `foreign authored thread containing the slug: ${l}`),
  ...outbound.flatMap((o) =>
    o.nonOwnerComments.map((c) => `non-owner comment (${c.user}) on outbound ${o.ref}`)
  ),
];
const indexHidden = remainder && remainder.stable ? remainder.hidden : 0;
const verdict = classify({
  foreignSignals: signals,
  outbound,
  indexHidden,
  broadTotal,
});

// ---- report -----------------------------------------------------------------
const failedSources = failures.length;
const report = {
  measuredAt: startedAt,
  repo: REPO,
  checks,
  outbound,
  mentionSweep: {
    query: BROAD_QUERY,
    total: broadTotal,
    fetched: broadFetched,
    remainder,
    buckets: {
      selfAuthoredSlug: buckets.selfAuthoredSlug.length,
      foreignSlugPost: buckets.foreignSlugPost.length,
      foreignSlugPre: buckets.foreignSlugPre.length,
      termCollision: buckets.termCollision.length,
      samples: {
        selfAuthoredSlug: buckets.selfAuthoredSlug.slice(0, 10),
        foreignSlugPost: buckets.foreignSlugPost.slice(0, 10),
        foreignSlugPre: buckets.foreignSlugPre.slice(0, 10),
      },
    },
  },
  codeIndex: codeIndexSweep,
  registries,
  traffic: checks.traffic,
  // D9 lesson (signerd 2026-11-03): a partial measurement still writes its
  // report, but the verdict field must read no-verdict — an absence-looking
  // classification on partial data is exactly what must never be recorded.
  verdict: failedSources > 0 ? { class: 'no-verdict', reasons: failures } : verdict,
  provisionalVerdict: failedSources > 0 ? verdict : undefined,
  warnings,
  dataSourcesFailed: failedSources,
  complete:
    failedSources === 0 &&
    checks.repoMetadata.ok &&
    checks.traffic.ok &&
    sweep !== null &&
    registryFailure === null,
};

const lines = [];
lines.push(`foreign-run measurement ${REPO} @ ${startedAt}`);
lines.push(`  repo: public=${checks.repoMetadata.public} license=${checks.repoMetadata.license} created=${createdAt}`);
lines.push(
  `  stars=${checks.starForkCensus.starsTotal} (non-owner ${checks.starForkCensus.nonOwnerStars.length}) forks=${checks.starForkCensus.forksTotal} (non-owner ${checks.starForkCensus.nonOwnerForks.length}) external own-repo issues=${checks.ownIssueCensus.external.length}`
);
lines.push(
  `  outbound: ${outbound.map((o) => `${o.ref}=${o.state} foreignComments=${o.nonOwnerComments.length}`).join(' | ')}`
);
lines.push(
  `  sweep "${BROAD_QUERY}": total=${broadTotal} fetched=${broadFetched} -> selfSlug=${buckets.selfAuthoredSlug.length} foreignSlug=${buckets.foreignSlugPost.length} preCreation=${buckets.foreignSlugPre.length} collisions=${buckets.termCollision.length}`
);
lines.push(
  `  code index: ${codeIndexSweep ? (codeIndexSweep.ok ? `selfControl=${codeIndexSweep.selfControlHits} foreign=${codeIndexSweep.foreign.length}` : 'self-control 0 -> index blind, no claim') : 'UNMEASURED'}`
);
lines.push(
  `  registries: npm=${registries.npm} crates.io=${registries.cratesIo} pypi=${registries.pypi} (absence = channel not published, NOT no-consumption)`
);
lines.push(
  `  traffic 14d: views=${views ? views.count : '?'} clones=${clones ? clones.count : '?'} (CI-inflated) externalReferrers=${externalReferrers.length}`
);
if (warnings.length) for (const w of warnings) lines.push(`  warning: ${w}`);
if (failedSources > 0) {
  lines.push(`  NO VERDICT - ${failedSources} data source(s) failed:`);
  for (const f of failures) lines.push(`    - ${f}`);
} else {
  lines.push(`  VERDICT: ${verdict.class} - ${verdict.meaning}`);
  for (const s of verdict.signals) lines.push(`    - ${s}`);
}
const text = lines.join('\n');
console.log(text);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.error(`wrote ${OUT}`);
}

// A partial measurement gets NO verdict: an incomplete source is not evidence
// of absence (crates.io-403 lesson), and the exit code says so.
if (failedSources > 0 || !checks.traffic.ok || sweep === null || registryFailure !== null)
  process.exit(3);
