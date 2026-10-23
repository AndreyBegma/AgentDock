import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { card } from '../../lib/board/fixtures';
import { ReviewSection } from './review-section';

type Card = Parameters<typeof ReviewSection>[0]['card'];

const detail = () => ({
  ...card(1, 'in_progress', {
    ciState: 'green',
    review: {
      state: 'fixing' as const,
      stepIndex: 0,
      stepCount: 1,
      fixRound: 1,
      fixLimit: 3,
      steps: [
        {
          id: 's1',
          name: 'Security',
          state: 'blocked' as const,
          blockingCount: 1,
          nitCount: 0,
        },
      ],
    },
  }),
  body: '',
  reviewFindings: [
    {
      stepId: 's1',
      stepName: 'Security',
      severity: 'blocking' as const,
      file: 'src/a.ts',
      line: 12,
      title: 'Unescaped input',
      body: 'Escape it.',
    },
  ],
  rounds: [{ round: 2, trigger: 'review_fix' }],
});

describe('ReviewSection (#891)', () => {
  test('lists CI, each step and Finished with counts, findings and fix rounds', () => {
    const html = renderToStaticMarkup(
      <ReviewSection
        card={detail() as unknown as Card}
        onOpenRound={() => {}}
      />,
    );
    for (const text of [
      'CI',
      'Security',
      'Blocking',
      '1 blocking',
      'Finished',
      'Unescaped input',
      'src/a.ts:12',
      'Fix rounds 1 of 3',
      'Review fix 1 · Round 2',
    ]) {
      expect(html).toContain(text);
    }
  });
  test('renders nothing without review', () => {
    const c = { ...detail(), review: null };
    expect(
      renderToStaticMarkup(
        <ReviewSection card={c as unknown as Card} onOpenRound={() => {}} />,
      ),
    ).toBe('');
  });
});
