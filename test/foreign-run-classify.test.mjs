// Synthetic-fixture tests for tools/lib/foreign-run-classify.mjs — the pure
// classification core, extracted precisely so these rules can be tested
// WITHOUT depending on live thread states.
//
// Why this file exists (measured 2026-11-05): in the probe's first version
// the classification was inline, and a hand-mutation that counted a CLOSED
// thread as a foreign run stayed GREEN — both live outbound threads were
// open, so the close-branch was dead code on that day's data. A guard that
// cannot fail is not a guard. These fixtures make every branch fire:
//
//   T1  a foreign star is user-one evidence;
//   T2  the OWNER closing a thread is distribution, never a run
//       (mutation "close = run" must fail here);
//   T3  a non-owner comment on an open thread IS user-one evidence
//       (the complement of T2: the close rule must not swallow real replies);
//   T4  zero signals + open channels = not-distributed-not-consumed;
//   T5  an index-hidden remainder is carried as a NAMED LIMIT, never a
//       silent drop — and never upgrades the class;
//   G   bucketMention: slug+owner = own distribution; slug+foreign =
//       stranger; no-slug = term collision; pre-repo date = not about this
//       repo regardless of author.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketMention, classify } from '../tools/lib/foreign-run-classify.mjs';

const OPEN = { ref: 'step-finance-oss/step-ingestooor#1', state: 'open', nonOwnerComments: [] };

test('T1: a foreign star is user-one evidence', () => {
  const v = classify({ foreignSignals: ['star by someone'], outbound: [OPEN] });
  assert.equal(v.class, 'user-one-evidence');
  assert.ok(v.signals.includes('star by someone'));
});

test('T2: the owner closing a thread is distribution, never a run', () => {
  const v = classify({
    foreignSignals: [],
    outbound: [{ ref: 'step-finance-oss/step-ingestooor#1', state: 'closed', nonOwnerComments: [] }],
  });
  assert.equal(v.class, 'distributed-not-consumed');
  assert.ok(
    v.meaning.includes('a close is not a run'),
    'the verdict must say what a close is NOT'
  );
  // and the signal names the close as delivery, not as a stranger
  assert.ok(v.signals.every((s) => s.includes('closed/merged')));
});

test('T3: a non-owner comment on an open thread IS user-one evidence', () => {
  const v = classify({
    foreignSignals: ['non-owner comment (somebody) on outbound step-finance-oss/step-ingestooor#1'],
    outbound: [
      { ref: 'step-finance-oss/step-ingestooor#1', state: 'open', nonOwnerComments: [{ user: 'somebody' }] },
    ],
  });
  assert.equal(v.class, 'user-one-evidence');
});

test('T4: zero signals + open channels = not-distributed-not-consumed', () => {
  const v = classify({ foreignSignals: [], outbound: [OPEN] });
  assert.equal(v.class, 'not-distributed-not-consumed');
  assert.ok(v.signals.some((s) => s.includes('step-finance-oss/step-ingestooor#1')));
});

test('T5: an index-hidden remainder is a named limit, never a silent drop', () => {
  const v = classify({ foreignSignals: [], outbound: [OPEN], indexHidden: 1, broadTotal: 93 });
  assert.equal(v.class, 'not-distributed-not-consumed');
  assert.equal(v.limits.length, 1, 'the hidden result must be named');
  assert.match(v.limits[0], /1 of 93/);
  assert.match(v.limits[0], /not classified/);
  // and zero signals must NOT be upgraded by the hidden count
  assert.notEqual(v.class, 'user-one-evidence');
});

test('G: bucketMention — slug+owner is own distribution, not a stranger', () => {
  const ctx = { owner: 'auroraxo', slug: 'auroraxo/sememe', repoCreatedAt: '2026-10-26T09:24:02Z' };
  assert.equal(
    bucketMention({ body: 'see https://github.com/auroraxo/sememe', author: 'auroraxo', createdAt: '2026-11-04' }, ctx),
    'selfAuthoredSlug'
  );
  assert.equal(
    bucketMention({ body: 'see https://github.com/auroraxo/sememe', author: 'someone', createdAt: '2026-11-04' }, ctx),
    'foreignSlugPost'
  );
  assert.equal(
    bucketMention({ body: 'HowNet sememe', author: 'thunlp', createdAt: '2023-04-24' }, ctx),
    'termCollision'
  );
  // slug present but dated before the repo existed: not about this repo
  assert.equal(
    bucketMention({ body: 'auroraxo/sememe', author: 'someone', createdAt: '2026-01-01' }, ctx),
    'foreignSlugPre'
  );
});
