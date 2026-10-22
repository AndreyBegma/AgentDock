import { describe, expect, test } from 'bun:test';
import type { PlanTaskIssueView } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { IssueLinks } from './issue-links';

const ISSUE: PlanTaskIssueView = {
  number: 7,
  url: 'https://github.com/o/r/issues/7',
  liveStatus: null,
  prNumber: 9,
  prUrl: 'https://github.com/o/r/pull/9',
};

const render = (issue: Partial<PlanTaskIssueView>) =>
  renderToStaticMarkup(<IssueLinks issue={{ ...ISSUE, ...issue }} />);

describe('IssueLinks (spec 164)', () => {
  test('GitHub links are followed', () => {
    const html = render({});
    expect(html).toContain('href="https://github.com/o/r/issues/7"');
    expect(html).toContain('href="https://github.com/o/r/pull/9"');
  });

  test('a script or look-alike URL is shown as text, never linked', () => {
    const html = render({
      url: 'javascript:alert(1)',
      prUrl: 'https://github.com.evil.example/o/r/pull/9',
    });
    expect(html).not.toContain('href');
    expect(html).toContain('Issue #7');
    expect(html).toContain('PR #9');
  });
});
