import type { StewardDigestView } from '@agentdock/shared';
import { TELEGRAM_TEXT_MAX } from '../telegram/markdown-v2';
import { boundedProse, digestTelegramText } from './steward-digest-format';

const view = (over: Partial<StewardDigestView> = {}): StewardDigestView => ({
  id: 'd1',
  projectId: 'p1',
  trigger: 'daily',
  createdAt: '2026-10-16T09:00:00.000Z',
  from: '2026-10-15T09:00:00.000Z',
  to: '2026-10-16T09:00:00.000Z',
  prose: null,
  done: [],
  stuck: [],
  waiting: [],
  spendUsd: '12.50',
  ...over,
});

describe('digestTelegramText', () => {
  it('says there is nothing to report and still shows the spend', () => {
    const text = digestTelegramText(view(), 'widget');
    expect(text).toContain('*Daily digest — widget*');
    expect(text).toContain('Nothing to report\\.');
    expect(text).toContain('Spend: $12\\.50');
  });

  it('titles an away-off digest "While you were away"', () => {
    const text = digestTelegramText(view({ trigger: 'away_off' }), 'widget');
    expect(text).toContain('*While you were away — widget*');
  });

  it('lists done, stuck with the reason, and waiting with counts', () => {
    const text = digestTelegramText(
      view({
        done: [
          {
            label: 'C-1',
            title: 'Add login',
            reason: 'merged',
            url: 'https://github.com/acme/widget/pull/9',
          },
        ],
        stuck: [
          {
            label: 'C-2',
            title: 'Fix build',
            reason: 'API error: connection lost',
            url: null,
          },
        ],
        waiting: [
          { label: 'C-3', title: 'Pick', reason: 'waiting for you', url: null },
        ],
      }),
      'widget',
    );
    expect(text).toContain('*Done \\(1\\)*');
    expect(text).toContain(
      '• [C\\-1 · Add login](https://github.com/acme/widget/pull/9)',
    );
    expect(text).toContain('*Stuck \\(1\\)*');
    expect(text).toContain('• C\\-2 · Fix build — API error: connection lost');
    expect(text).toContain('*Waiting for you \\(1\\)*');
  });

  it('escapes MarkdownV2 in titles and reasons', () => {
    const text = digestTelegramText(
      view({
        stuck: [
          {
            label: 'C-1',
            title: '*bold* _it_ [x](y)',
            reason: '`code` ~strike~',
            url: null,
          },
        ],
      }),
      'a_b',
    );
    expect(text).toContain('\\*bold\\* \\_it\\_ \\[x\\]\\(y\\)');
    expect(text).toContain('\\`code\\` \\~strike\\~');
    expect(text).toContain('*Daily digest — a\\_b*');
  });

  it('shows the first lines of a long section and counts the rest', () => {
    const stuck = Array.from({ length: 12 }, (_, i) => ({
      label: `C-${i}`,
      title: 'Task',
      reason: 'silent',
      url: null,
    }));
    const text = digestTelegramText(view({ stuck }), 'widget');
    expect(text).toContain('*Stuck \\(12\\)*');
    expect(text).toContain('\\+4 more');
    expect(text).not.toContain('C\\-8 ');
  });

  it('stays under the Telegram limit', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      label: `C-${i}`,
      title: 'T'.repeat(120),
      reason: 'R'.repeat(200),
      url: null,
    }));
    const text = digestTelegramText(
      view({ done: big, stuck: big, waiting: big }),
      'widget',
    );
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
  });

  it('puts prose under the heading when there is one', () => {
    const text = digestTelegramText(view({ prose: 'A quiet night.' }), 'w');
    expect(text.split('\n')[1]).toBe('A quiet night\\.');
  });
});

describe('boundedProse', () => {
  it('is null for nothing and for text of nothing but breaks', () => {
    expect(boundedProse(null)).toBeNull();
    expect(boundedProse('')).toBeNull();
    expect(boundedProse('\n\t')).toBeNull();
  });

  it('is one line of at most 600 characters', () => {
    const out = boundedProse(`first\nsecond ${'x'.repeat(900)}`);
    expect(out).not.toContain('\n');
    expect(Array.from(out ?? '')).toHaveLength(600);
  });
});
