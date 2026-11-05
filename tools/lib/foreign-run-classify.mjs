// The classification core of tools/measure-foreign-run.mjs, extracted so the
// falsifiable decision paths can be tested against SYNTHETIC inputs.
//
// Why extracted (measured 2026-11-05): the first version of the probe decided
// everything inline, and the guard "a closed/merged thread must never read as
// a foreign run" was untestable — both live outbound threads happened to be
// OPEN, so the close-path was dead code and a hand-mutation that counted a
// close as a run stayed GREEN. A guard that cannot fail is not a guard. The
// rules now live here as pure functions, driven by fixtures.
//
// The rules themselves are the house conventions (signerd/reeflog, 2026-11-02
// and 2026-11-03):
//   - a foreign-authored signal is user-one evidence;
//   - the OWNER's own threads (and a closed thread) are distribution, never
//     consumption — a close is not a run;
//   - zero foreign signals + delivered channels = distributed-not-consumed;
//   - zero foreign signals + open channels = not-distributed-not-consumed;
//   - an index-hidden remainder is a NAMED LIMIT of the verdict, never a
//     silent drop.

/**
 * Bucket one broad-sweep hit into a named class.
 *
 * @param {object} hit  {body, author, createdAt}
 * @param {object} ctx  {owner, slug, repoCreatedAt}
 * @returns {'selfAuthoredSlug'|'foreignSlugPost'|'foreignSlugPre'|'termCollision'}
 */
export function bucketMention(hit, ctx) {
  const body = hit.body || '';
  const author = hit.author || '?';
  const hasSlug = body.includes(ctx.slug);
  // A hit created before the repo existed cannot be about the repo — it is
  // the pre-existing term (thunlp/OpenHowNet & the linguistics literature).
  const beforeRepo = new Date(hit.createdAt) < new Date(ctx.repoCreatedAt);
  if (hasSlug && beforeRepo) return 'foreignSlugPre';
  if (!hasSlug) return 'termCollision';
  if (author === ctx.owner) return 'selfAuthoredSlug';
  return 'foreignSlugPost';
}

/**
 * Decide the adoption class from measured signals only.
 *
 * @param {object} input
 * @param {string[]} input.foreignSignals  non-owner signals (stars, forks,
 *   external issues/PRs, foreign-authored slug threads, non-owner comments)
 * @param {Array<{ref: string, state: string, nonOwnerComments: object[]}>}
 *   input.outbound  the owner's threads in foreign repos
 * @param {number|null} input.indexHidden  broad-sweep results the index hid
 * @param {number|null} input.broadTotal
 * @returns {{class: string, signals: string[], meaning: string, limits: string[]}}
 */
export function classify(input) {
  const { foreignSignals = [], outbound = [], indexHidden = 0, broadTotal = null } = input;

  const closedDelivered = outbound
    .filter((o) => o.state === 'closed' || o.merged === true)
    .map((o) => `${o.ref} closed/merged`);
  const openDelivered = outbound
    .filter((o) => o.state !== 'closed' && o.merged !== true)
    .map((o) => `${o.ref} open with ${o.nonOwnerComments.length} non-owner comment(s)`);

  const limits = [];
  if (indexHidden > 0 && broadTotal !== null) {
    limits.push(
      `${indexHidden} of ${broadTotal} broad-sweep results are index-hidden (measured stable across orderings) and were not classified`
    );
  }

  if (foreignSignals.length > 0) {
    return {
      class: 'user-one-evidence',
      signals: foreignSignals,
      meaning: 'at least one non-owner account touched sememe or its outbound threads',
      limits,
    };
  }
  if (closedDelivered.length > 0) {
    return {
      class: 'distributed-not-consumed',
      signals: closedDelivered,
      meaning:
        'owner threads were delivered/closed upstream, but zero non-owner signals exist — a close is not a run',
      limits,
    };
  }
  return {
    class: 'not-distributed-not-consumed',
    signals: [...openDelivered, 'zero non-owner stars, forks, issues, PRs'],
    meaning: 'channels open, nothing consumed — no non-owner signal found on any measured channel',
    limits,
  };
}
