import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatDate } from '../../lib/format';
import { QuotaWaitLine, quotaWaitText } from './quota-wait-line';

const RESETS = '2026-10-21T15:00:00.000Z';

describe('quotaWaitText (#741)', () => {
  test('names the time the limit resets, in the viewer’s zone', () => {
    expect(quotaWaitText({ limit: 'session', resetsAt: RESETS })).toBe(
      `Waiting for the limit until ${formatDate(RESETS, 'datetime')}`,
    );
  });

  test('says only that the limit was reached when the banner has no time', () => {
    expect(quotaWaitText({ limit: 'weekly', resetsAt: null })).toBe(
      'Limit reached',
    );
  });
});

describe('QuotaWaitLine', () => {
  test('renders the line', () => {
    const html = renderToStaticMarkup(
      <QuotaWaitLine wait={{ limit: 'session', resetsAt: RESETS }} />,
    );
    expect(html).toContain('Waiting for the limit until');
  });
});
