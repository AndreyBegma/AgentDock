import { describe, expect, test } from 'bun:test';
import type { BoardColumn } from '@agentdock/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { card as fixtureCard } from '../../lib/board/fixtures';
import { CardFace } from './card-face';

const COLUMNS: BoardColumn[] = ['todo', 'in_progress', 'finished', 'completed'];

const render = (column: BoardColumn, extra = {}) =>
  renderToStaticMarkup(
    <CardFace
      projectId="p1"
      canOperate
      onOpen={() => undefined}
      card={fixtureCard(7, column, {
        prNumber: 7,
        prUrl: 'https://github.com/o/r/pull/7',
        prState: 'open',
        ...extra,
      })}
    />,
  );

describe('CardFace pull request link (#329 D6)', () => {
  for (const column of COLUMNS) {
    test(`shows PR #7 with its state in ${column}`, () => {
      const html = render(column);
      expect(html).toContain('PR #7 · Open');
      expect(html).toContain('href="https://github.com/o/r/pull/7"');
    });
  }

  test('shows the merged state, and a bare number while the state is unknown', () => {
    expect(render('completed', { prState: 'merged' })).toContain(
      'PR #7 · Merged',
    );
    const unknown = render('in_progress', { prState: null });
    expect(unknown).toContain('PR #7<');
    expect(unknown).not.toContain('·');
  });

  test('a card without a PR shows the issue link only', () => {
    const html = render('finished', {
      prNumber: null,
      prUrl: null,
      prState: null,
      issueNumber: 3,
      issueUrl: 'https://github.com/o/r/issues/3',
    });
    expect(html).not.toContain('PR #');
    expect(html).toContain('Issue #3');
  });
});
