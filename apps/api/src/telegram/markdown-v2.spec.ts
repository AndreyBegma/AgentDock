import type { DeliveryContent } from '../notifications';
import {
  appLink,
  escapeLinkUrl,
  escapeMarkdownV2,
  formatDigest,
  formatMessage,
  TELEGRAM_TEXT_MAX,
} from './markdown-v2';

const content = (over: Partial<DeliveryContent> = {}): DeliveryContent => ({
  kind: 'pane.prompt',
  title: 'Dialog waiting',
  body: 'A launch dialog waits for a person.',
  link: '/projects/p1/fleet',
  projectName: 'widget',
  slot: 'i42-api',
  issue: 42,
  count: 1,
  ...over,
});

describe('escapeMarkdownV2', () => {
  it('escapes every character MarkdownV2 reserves, and the backslash', () => {
    const specials = '_*[]()~`>#+-=|{}.!\\';
    expect(escapeMarkdownV2(specials)).toBe(
      specials
        .split('')
        .map((c) => `\\${c}`)
        .join(''),
    );
    for (const c of specials) expect(escapeMarkdownV2(c)).toBe(`\\${c}`);
  });

  it('leaves ordinary text alone', () => {
    expect(escapeMarkdownV2('Hello world 42 · é — ok')).toBe(
      'Hello world 42 · é — ok',
    );
  });

  it('turns would-be markup into literal text', () => {
    expect(escapeMarkdownV2('[click](https://evil.example)')).toBe(
      '\\[click\\]\\(https://evil\\.example\\)',
    );
  });
});

describe('escapeLinkUrl', () => {
  it('escapes only ) and \\ inside a link target', () => {
    expect(escapeLinkUrl('https://x.example/a_b(c)\\d')).toBe(
      'https://x.example/a_b(c\\)\\\\d',
    );
  });
});

describe('appLink', () => {
  it('joins APP_URL and an app path', () => {
    expect(appLink('https://dock.example.com', '/a')).toBe(
      'https://dock.example.com/a',
    );
  });

  it('gives no link without APP_URL, or for anything not a path', () => {
    expect(appLink(null, '/a')).toBeNull();
    expect(appLink('https://dock.example.com', null)).toBeNull();
    expect(
      appLink('https://dock.example.com', 'https://evil.example'),
    ).toBeNull();
    expect(appLink('https://dock.example.com', '//evil.example')).toBeNull();
  });
});

describe('formatMessage (D10)', () => {
  it('names what it is about and links to the app', () => {
    expect(formatMessage(content(), 'https://dock.example.com')).toBe(
      [
        '*Dialog waiting*',
        'A launch dialog waits for a person\\.',
        '_widget · i42\\-api · \\#42_',
        '[Open in AgentDock](https://dock.example.com/projects/p1/fleet)',
      ].join('\n'),
    );
  });

  it('says how often a folded item happened, and drops the link without APP_URL', () => {
    const text = formatMessage(
      content({ count: 5, projectName: null, slot: null, issue: null }),
      null,
    );
    expect(text).toBe(
      [
        '*Dialog waiting*',
        'A launch dialog waits for a person\\.',
        'Happened 5 times\\.',
      ].join('\n'),
    );
  });

  it('stays under the Telegram limit for any title and body', () => {
    const text = formatMessage(
      content({ title: '.'.repeat(5000), body: '!'.repeat(10_000) }),
      'https://dock.example.com',
    );
    expect(text.length).toBeLessThan(TELEGRAM_TEXT_MAX);
  });
});

describe('formatDigest (D6)', () => {
  it('lists the items and links to the notification centre', () => {
    const text = formatDigest(
      [content({ title: 'a' }), content({ title: 'b', count: 3 })],
      'https://dock.example.com',
    );
    expect(text).toBe(
      [
        '*2 more notifications*',
        '• a — widget · i42\\-api · \\#42',
        '• b — widget · i42\\-api · \\#42 \\(×3\\)',
        '[Open notifications](https://dock.example.com/account/notifications)',
      ].join('\n'),
    );
  });

  it('counts what does not fit instead of exceeding the limit', () => {
    const items = Array.from({ length: 500 }, (_, i) =>
      content({ title: `${'_'.repeat(100)}${i}` }),
    );
    const text = formatDigest(items, 'https://dock.example.com');
    expect(text.length).toBeLessThan(TELEGRAM_TEXT_MAX);
    expect(text.startsWith('*500 more notifications*')).toBe(true);
    expect(text).toMatch(/…and \d+ more\\\./);
  });
});
