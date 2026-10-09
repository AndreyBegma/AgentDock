import type { DeliveryContent } from '../notifications';

/** Telegram refuses longer texts; the rest of the budget is markup headroom. */
export const TELEGRAM_TEXT_MAX = 4096;
const TEXT_BUDGET = 3900;
const TITLE_MAX = 200;
const BODY_MAX = 1000;
const DIGEST_LINE_MAX = 120;

/** Every character MarkdownV2 reserves outside code and links, and `\` itself. */
const SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** `text` as literal MarkdownV2: every reserved character escaped (D10). */
export const escapeMarkdownV2 = (text: string): string =>
  text.replace(SPECIAL, (c) => `\\${c}`);

/** A URL inside `[text](url)`: only `)` and `\` are escaped there. */
export const escapeLinkUrl = (url: string): string =>
  url.replace(/[)\\]/g, (c) => `\\${c}`);

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** `APP_URL` + an app path; null without either, or for anything not a path. */
export const appLink = (
  appUrl: string | null,
  path: string | null,
): string | null => {
  if (!appUrl || !path?.startsWith('/') || path.startsWith('//')) return null;
  return `${appUrl}${path}`;
};

const linkLine = (label: string, url: string | null): string[] =>
  url ? [`[${escapeMarkdownV2(label)}](${escapeLinkUrl(url)})`] : [];

/** "widget · i42-api · #42" — what the item is about. */
const where = (content: DeliveryContent): string =>
  [
    content.projectName,
    content.slot,
    content.issue !== null ? `#${content.issue}` : null,
  ]
    .filter((part): part is string => !!part)
    .join(' · ');

/**
 * One notification as a Telegram message (D10). Built only from the stored
 * title, body and names — never pane text, prompts or code — with every
 * character escaped, so nothing in them can become markup.
 */
export const formatMessage = (
  content: DeliveryContent,
  appUrl: string | null,
): string => {
  const about = where(content);
  const lines = [
    `*${escapeMarkdownV2(clip(content.title, TITLE_MAX))}*`,
    ...(content.body ? [escapeMarkdownV2(clip(content.body, BODY_MAX))] : []),
    ...(about ? [`_${escapeMarkdownV2(about)}_`] : []),
    ...(content.count > 1
      ? [escapeMarkdownV2(`Happened ${content.count} times.`)]
      : []),
    ...linkLine('Open in AgentDock', appLink(appUrl, content.link)),
  ];
  return lines.join('\n');
};

/**
 * The items held back by the rate limit (D6), as one message: a line each
 * while they fit, then a count of the rest.
 */
export const formatDigest = (
  items: DeliveryContent[],
  appUrl: string | null,
): string => {
  const header = `*${escapeMarkdownV2(
    `${items.length} more notification${items.length === 1 ? '' : 's'}`,
  )}*`;
  const footer = linkLine(
    'Open notifications',
    appLink(appUrl, '/account/notifications'),
  );
  const reserve =
    header.length + footer.join('').length + 64; /* "…and N more" + breaks */
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    const about = where(item);
    const count = item.count > 1 ? ` (×${item.count})` : '';
    const line = escapeMarkdownV2(
      `• ${clip(`${item.title}${about ? ` — ${about}` : ''}`, DIGEST_LINE_MAX)}${count}`,
    );
    if (used + line.length + 1 + reserve > TEXT_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  const rest = items.length - lines.length;
  return [
    header,
    ...lines,
    ...(rest > 0 ? [escapeMarkdownV2(`…and ${rest} more.`)] : []),
    ...footer,
  ].join('\n');
};
