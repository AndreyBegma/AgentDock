import { describe, expect, test } from 'bun:test';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanPanel, PlanPanelFooter } from './plan-panel';

describe('New plan sheet close control (#398)', () => {
  test('the footer is a real Close button', () => {
    const html = renderToStaticMarkup(<PlanPanelFooter onClose={() => {}} />);
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('Close');
  });

  test('the sheet is given the footer, and Close closes it', () => {
    const calls: boolean[] = [];
    const root = PlanPanel({
      projectId: 'p1',
      project: undefined,
      open: false,
      planId: undefined,
      initialBrief: '',
      userId: 'u1',
      onOpenChange: (open) => calls.push(open),
      onStarted: () => {},
      onCardsCreated: () => {},
    });
    const content = (root.props as { children: unknown }).children;
    if (!isValidElement<{ footer: unknown }>(content)) {
      throw new Error('SheetContent expected');
    }
    const footer = content.props.footer;
    if (!isValidElement<{ onClose: () => void }>(footer)) {
      throw new Error('footer expected');
    }
    expect(footer.type).toBe(PlanPanelFooter);
    footer.props.onClose();
    expect(calls).toEqual([false]);
  });
});
