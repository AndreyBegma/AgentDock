import { describe, expect, test } from 'bun:test';
import type { PlanCandidateView, PlanDetail } from '@agentdock/shared';
import { ApiError } from '../api';
import { plan } from '../planner/fixtures';
import {
  acceptAllLabel,
  acceptAllRequest,
  acceptedText,
  acceptStackRequest,
  attachmentNotes,
  attachmentsText,
  candidateContext,
  candidateDecidedOf,
  candidateTitleProblem,
  dependsOnText,
  excerptOf,
  groupMetaText,
  isCandidateStale,
  moveRow,
  setRowStage,
  stackGetsDesign,
  stackPreview,
  stackRowsOf,
  waitingText,
} from './candidates';

const candidate = (
  id: string,
  over: Partial<PlanCandidateView> = {},
): PlanCandidateView => ({
  id,
  planId: 'plan-1',
  position: 0,
  title: `Card ${id}`,
  kind: 'feature',
  body: '## What to do\n\nDo it.',
  stage: null,
  status: 'pending',
  version: 1,
  card: null,
  attachments: 0,
  ...over,
});

const review = (
  candidates: PlanCandidateView[],
  over: Partial<PlanDetail> = {},
  intake: Partial<NonNullable<PlanDetail['intake']>> = {},
): PlanDetail =>
  plan({
    id: candidates[0]?.planId ?? 'plan-1',
    mode: 'card',
    status: 'reviewing',
    title: 'Cost dashboard per project',
    tasks: [],
    intake: { roundsAsked: 1, maxRounds: 4, candidates, ...intake },
    ...over,
  });

const STACK = {
  title: 'Cost dashboard per project',
  body: '',
  design: true,
  stages: ['Data', 'API', 'Page'],
};

const stacked = () =>
  review(
    [
      candidate('a', { stage: 0, title: 'Store rollups' }),
      candidate('b', { stage: 1, position: 1, title: 'Expose the API' }),
      candidate('c', { stage: 2, position: 2, title: 'Dashboard page' }),
    ],
    {},
    { candidateStack: STACK, attachments: 2 },
  );

describe('New work candidates in Drafts (#592)', () => {
  test('a group says what was proposed and how much is decided', () => {
    expect(groupMetaText(review([candidate('a')]))).toBe('1 card to review');
    expect(groupMetaText(stacked())).toBe('Proposed stack · 3 stages');
    const split = review([
      candidate('a', { status: 'accepted' }),
      candidate('b', { status: 'rejected' }),
      candidate('c'),
    ]);
    expect(groupMetaText(split)).toBe('Proposed split · 2 of 3 decided');
    expect(acceptAllLabel(split)).toBe('Accept rest');
    expect(acceptAllLabel(stacked())).toBe('Accept all');
    expect(acceptAllLabel(review([candidate('a')]))).toBeNull();
    expect(waitingText([split, stacked()])).toBe('4 candidates waiting');
    expect(waitingText([])).toBeNull();
  });

  test('Accept all takes a stack in its stages, and what is left of a split as cards', () => {
    expect(acceptAllRequest(stacked())).toEqual({
      as: 'stack',
      candidates: [
        { id: 'a', version: 1, stage: 0 },
        { id: 'b', version: 1, stage: 1 },
        { id: 'c', version: 1, stage: 2 },
      ],
    });
    const one = review(
      [
        candidate('a', { stage: 0, status: 'rejected' }),
        candidate('b', { stage: 1 }),
      ],
      {},
      { candidateStack: STACK },
    );
    expect(acceptAllRequest(one)).toEqual({
      as: 'cards',
      candidates: [{ id: 'b', version: 1 }],
    });
  });

  test('a row reads the body’s prose, not its headings or list marks', () => {
    expect(
      excerptOf(
        '## Summary\nExpose daily rollups.\n\n## API\n- [ ] scoped\n1. one',
      ),
    ).toBe('Expose daily rollups. scoped one');
  });

  test('the sheet says where the candidate sits, what it depends on and where the files go', () => {
    const p = stacked();
    const [, b] = p.intake?.candidates ?? [];
    expect(candidateContext(p, b)).toBe(
      'Cost dashboard per project · stage 2 of 3',
    );
    expect(dependsOnText(p, b)).toBe('Stage 1 · Store rollups');
    expect(attachmentsText(p, b)).toBe(
      '2 — go to the first card you accept from this intake',
    );
    const single = review([candidate('a')], {}, { attachments: 1 });
    expect(attachmentsText(single, candidate('a'))).toBe(
      '1 — goes to this card on accept',
    );
  });

  test('an edited title is English: a non-ASCII letter is refused, as split titles are', () => {
    expect(candidateTitleProblem('Rate-limit the check')).toBeNull();
    expect(candidateTitleProblem('Ограничить проверку пароля')).toBe(
      'The title has non-ASCII letters. Write it in English. Card titles become branch names.',
    );
    expect(candidateTitleProblem('  ')).toBe('A card needs a title.');
  });

  test('the stack dialog keeps a proposed stack’s stages, and orders anything else one per stage', () => {
    const p = stacked();
    const all = (p.intake?.candidates ?? []).map((c) => ({
      candidate: c,
      plan: p,
    }));
    expect(stackRowsOf(all).map((r) => r.stage)).toEqual([0, 1, 2]);
    const other = review([candidate('x', { planId: 'plan-2' })], {
      id: 'plan-2',
    });
    const mixed = stackRowsOf([
      { candidate: candidate('x', { planId: 'plan-2' }), plan: other },
      all[0],
    ]);
    expect(mixed.map((r) => [r.candidate.id, r.stage])).toEqual([
      ['x', 0],
      ['a', 1],
    ]);
    expect(stackGetsDesign(mixed)).toBe(true);
    expect(stackGetsDesign(mixed.slice(0, 1))).toBe(false);
  });

  test('stages are chosen with the select or moved up and down, and close up', () => {
    const p = stacked();
    const rows = stackRowsOf(
      (p.intake?.candidates ?? []).map((c) => ({ candidate: c, plan: p })),
    );
    const parallel = setRowStage(rows, 2, 0);
    expect(parallel.map((r) => [r.candidate.id, r.stage])).toEqual([
      ['a', 0],
      ['c', 0],
      ['b', 1],
    ]);
    const up = moveRow(rows, 1, -1);
    expect(up.map((r) => [r.candidate.id, r.stage])).toEqual([
      ['b', 0],
      ['a', 1],
      ['c', 2],
    ]);
    expect(moveRow(rows, 0, -1)).toEqual(rows);
    expect(stackPreview(parallel)).toEqual([
      {
        stage: 1,
        titles: ['Store rollups', 'Dashboard page'],
        dependsOn: null,
      },
      { stage: 2, titles: ['Expose the API'], dependsOn: 1 },
    ]);
    expect(acceptStackRequest(parallel).candidates).toEqual([
      { id: 'a', version: 1, stage: 0 },
      { id: 'c', version: 1, stage: 0 },
      { id: 'b', version: 1, stage: 1 },
    ]);
  });

  test('says where the attachments go, and where they went', () => {
    const p = stacked();
    const rows = (p.intake?.candidates ?? []).map((c) => ({
      candidate: c,
      plan: p,
    }));
    expect(attachmentNotes(rows, 'stage 1')).toEqual([
      "The intake's 2 attachments go to stage 1.",
    ]);
    const gave = review(
      [
        candidate('a', {
          status: 'accepted',
          attachments: 1,
          card: { number: 241, label: 'C-241' },
        }),
        candidate('b'),
      ],
      { title: 'Webhook reliability' },
    );
    expect(
      attachmentNotes([{ candidate: candidate('b'), plan: gave }], 'it'),
    ).toEqual(['Webhook reliability already gave its attachments to C-241.']);
  });

  test('reads the refusals and the result', () => {
    const decided = new ApiError(
      409,
      undefined,
      'accepted already',
      undefined,
      {
        error: 'candidate_decided',
        candidateId: 'a',
        status: 'accepted',
        card: { number: 241, label: 'C-241' },
      },
    );
    expect(candidateDecidedOf(decided)).toEqual({
      candidateId: 'a',
      status: 'accepted',
      card: { number: 241, label: 'C-241' },
    });
    expect(candidateDecidedOf(new Error('x'))).toBeNull();
    expect(
      isCandidateStale(
        new ApiError(409, undefined, 'stale', undefined, {
          error: 'candidate_stale',
        }),
      ),
    ).toBe(true);
    expect(
      acceptedText({
        cards: [{ candidateId: 'a', number: 12, label: 'C-12' }],
        stack: null,
      }),
    ).toBe('C-12 is in Todo.');
    expect(
      acceptedText({
        cards: [
          { candidateId: 'a', number: 12, label: 'C-12' },
          { candidateId: 'b', number: 13, label: 'C-13' },
        ],
        stack: { number: 2, label: 'S-2' },
      }),
    ).toBe('Stack S-2 is in Todo with 2 cards.');
  });
});
