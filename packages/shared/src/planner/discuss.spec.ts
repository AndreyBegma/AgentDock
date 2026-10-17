import { describe, expect, it } from 'bun:test';
import {
  CARD_DRAFT_TITLE_MAX,
  DISCUSS_PROPOSALS_MAX,
  discussOutputSchema,
  PLAN_MODES,
  PLAN_TURN_ACTIONS,
  PLANNER_DISCUSS_CONTRACT,
  parsePlannerOutput,
  plannerOutputSchemas,
} from '../index';

/** #590 (ADR-0055): the discussion's contract. */

const fence = (json: unknown): string =>
  `Here is what I found.\n\n\`\`\`agentdock-plan\n${JSON.stringify(json, null, 2)}\n\`\`\``;

const proposal = (n: number) => ({
  title: `Fix thing ${n}`,
  brief: `Do the fix number ${n}.`,
});

describe('discuss mode', () => {
  it('is a plan mode and a turn action', () => {
    expect(PLAN_MODES).toContain('discuss');
    expect(PLAN_TURN_ACTIONS).toContain('discuss');
  });

  it('takes a reply alone', () => {
    const result = parsePlannerOutput(
      fence({ action: 'discuss', reply: '## Answer\n\nThe guard hashes.' }),
      'discuss',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.reply).toContain('guard');
  });

  it('takes a title and proposals in any language', () => {
    const result = parsePlannerOutput(
      fence({
        action: 'discuss',
        title: 'Безопасность токенов',
        reply: 'Три проблемы.',
        proposals: [{ title: 'Сравнивать хеши', brief: 'Постоянное время.' }],
      }),
      'discuss',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.proposals).toHaveLength(1);
  });

  it('refuses a proposal without a brief', () => {
    const result = parsePlannerOutput(
      fence({
        action: 'discuss',
        reply: 'One thing.',
        proposals: [{ title: 'Fix it' }],
      }),
      'discuss',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_shape');
  });

  it('refuses no reply, an unknown key, too many proposals and a long title', () => {
    const bad = [
      { action: 'discuss' },
      { action: 'discuss', reply: 'x', cardDraft: {} },
      {
        action: 'discuss',
        reply: 'x',
        proposals: Array.from({ length: DISCUSS_PROPOSALS_MAX + 1 }, (_, i) =>
          proposal(i),
        ),
      },
      {
        action: 'discuss',
        reply: 'x',
        proposals: [
          { title: 'x'.repeat(CARD_DRAFT_TITLE_MAX + 1), brief: 'Do it.' },
        ],
      },
      {
        action: 'discuss',
        reply: 'x',
        proposals: [{ title: 'Two\nlines', brief: 'Do it.' }],
      },
    ];
    for (const json of bad) {
      expect(parsePlannerOutput(fence(json), 'discuss').ok).toBe(false);
    }
  });

  it('refuses another action and a missing block', () => {
    const other = parsePlannerOutput(
      fence({ action: 'intake', questions: [] }),
      'discuss',
    );
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.reason).toBe('action_mismatch');
    const none = parsePlannerOutput('Just words.', 'discuss');
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.reason).toBe('no_block');
  });

  it('reads a stored output back', () => {
    expect(
      plannerOutputSchemas.discuss.safeParse({
        action: 'discuss',
        reply: 'ok',
        proposals: [proposal(1)],
      }).success,
    ).toBe(true);
    expect(discussOutputSchema.safeParse({ action: 'discuss' }).success).toBe(
      false,
    );
  });

  it('states the shape and the limits in its contract text', () => {
    expect(PLANNER_DISCUSS_CONTRACT).toContain('"action": "discuss"');
    expect(PLANNER_DISCUSS_CONTRACT).toContain(
      `at most ${DISCUSS_PROPOSALS_MAX} cards`,
    );
  });
});
