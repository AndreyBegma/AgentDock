import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { task } from '../../lib/planner/fixtures';
import { SendTaskItem } from './send-dialog';

const written = task({
  key: 't1',
  title: 'Planner contract',
  document: '# Planner contract\n\n## Acceptance criteria\n\n- [ ] parses',
});
const summaryOnly = task({
  key: 't3',
  title: 'Planner page',
  summary: 'The page that lists plans.',
  document: null,
});

describe('Send to fleet: issue bodies (C-177)', () => {
  test('each body starts collapsed and is offered to expand', () => {
    for (const t of [written, summaryOnly]) {
      const html = renderToStaticMarkup(
        <SendTaskItem task={t} open={false} onOpenChange={() => {}} />,
      );
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain('grid-template-rows:0fr');
      expect(html).toContain('show body');
      expect(html).toContain(t.title);
    }
  });

  test('an expanded body shows the document, else the summary', () => {
    const doc = renderToStaticMarkup(
      <SendTaskItem task={written} open onOpenChange={() => {}} />,
    );
    expect(doc).toContain('aria-expanded="true"');
    expect(doc).toContain('grid-template-rows:1fr');
    expect(doc).toContain('## Acceptance criteria');
    expect(doc).toContain('hide body');

    const summary = renderToStaticMarkup(
      <SendTaskItem task={summaryOnly} open onOpenChange={() => {}} />,
    );
    expect(summary).toContain('The page that lists plans.');
  });

  test('the toggle asks to expand each body on its own', () => {
    const asked: string[] = [];
    for (const t of [written, summaryOnly]) {
      const item = SendTaskItem({
        task: t,
        open: false,
        onOpenChange: (open) => asked.push(`${t.key}:${open}`),
      });
      const disclosure = item.props.children as ReactElement<{
        onOpenChange: (open: boolean) => void;
      }>;
      disclosure.props.onOpenChange(true);
    }
    expect(asked).toEqual(['t1:true', 't3:true']);
  });
});
