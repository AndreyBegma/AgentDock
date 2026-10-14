import { describe, expect, test } from 'bun:test';
import { plan, task } from './fixtures';
import { approvableDrafts, briefBeyondTitle } from './header';

describe('briefBeyondTitle', () => {
  test('a one-line brief that is the title is not shown twice', () => {
    expect(
      briefBeyondTitle({ title: 'Fix the queue', brief: 'Fix the queue' }),
    ).toBeNull();
  });

  test('the lines after the title line are the description', () => {
    expect(
      briefBeyondTitle({
        title: 'Fix the queue',
        brief: '\nFix the queue\n\nIt drops labels.\n',
      }),
    ).toBe('It drops labels.');
  });

  test('a title cut with an ellipsis still matches its line', () => {
    expect(
      briefBeyondTitle({
        title: 'A very long first l…',
        brief: 'A very long first line of a brief',
      }),
    ).toBeNull();
  });

  test('a renamed plan keeps the whole brief', () => {
    expect(
      briefBeyondTitle({ title: 'Queue fixes', brief: 'Fix the queue' }),
    ).toBe('Fix the queue');
  });
});

describe('approvableDrafts', () => {
  test('drafts and ready tasks without a blocking question', () => {
    const p = plan({
      tasks: [
        task({ key: 'a', status: 'draft' }),
        task({ key: 'b', status: 'ready' }),
        task({ key: 'c', status: 'draft', blockingOpen: 1 }),
        task({ key: 'd', status: 'approved' }),
        task({ key: 'e', status: 'rejected' }),
        task({ key: 'f', status: 'rewrite_requested' }),
      ],
    });
    expect(approvableDrafts(p).map((t) => t.key)).toEqual(['a', 'b']);
  });
});
