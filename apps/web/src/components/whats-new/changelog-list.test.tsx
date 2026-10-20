import { describe, expect, test } from 'bun:test';
import { APP_VERSION, CHANGELOG } from '@agentdock/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  accountMenuLabel,
  releaseDateLabel,
  versionLabel,
} from '../../lib/whats-new/whats-new';
import { ChangelogList } from './changelog-list';

describe('the What’s new page (C-294)', () => {
  test('lists every release newest first, each item with its kind', () => {
    const html = renderToStaticMarkup(
      <ChangelogList
        entries={[
          {
            version: '0.15.0',
            date: '2026-11-02',
            items: [
              { kind: 'new', text: 'Cards can be starred.' },
              { kind: 'fixed', text: 'The Board scrolls on a phone.' },
            ],
          },
          {
            version: '0.14.0',
            date: '2026-10-20',
            items: [{ kind: 'improved', text: 'Navigation is shorter.' }],
          },
        ]}
      />,
    );
    expect(html.indexOf('v0.15.0')).toBeLessThan(html.indexOf('v0.14.0'));
    expect(html).toContain('<time dateTime="2026-11-02"');
    expect(html).toContain('2 November 2026');
    expect(html.indexOf('>New<')).toBeLessThan(
      html.indexOf('Cards can be starred.'),
    );
    expect(html).toContain('>Fixed<');
    expect(html).toContain('>Improved<');
  });

  test('renders the shipped changelog, the current version first', () => {
    const html = renderToStaticMarkup(<ChangelogList entries={CHANGELOG} />);
    expect(html.indexOf(versionLabel(APP_VERSION))).toBeGreaterThan(-1);
    for (const item of CHANGELOG[0]?.items ?? []) {
      expect(html).toContain(item.text);
    }
  });

  test('labels', () => {
    expect(versionLabel('0.14.0')).toBe('v0.14.0');
    expect(releaseDateLabel('2026-10-20')).toBe('20 October 2026');
    expect(accountMenuLabel(true)).toBe('Account menu, what’s new unread');
    expect(accountMenuLabel(false)).toBe('Account menu');
  });
});
