import type {
  StewardDigestItem,
  StewardDigestTrigger,
  StewardDigestView,
} from '@nautelle/shared';
import type { StewardDigest } from '@prisma/client';
import {
  escapeLinkUrl,
  escapeMarkdownV2,
  TELEGRAM_TEXT_MAX,
} from '../telegram/markdown-v2';
import type { DigestContent } from './steward-digest-composer';
import { DIGEST_PROSE_MAX, oneLine } from './steward-digest-text';

/** Lines shown per section in a Telegram message; the rest become "+N more". */
const TELEGRAM_LINES_PER_SECTION = 8;
/** Telegram refuses longer texts; leave headroom for markup. */
const TELEGRAM_BUDGET = TELEGRAM_TEXT_MAX - 200;

const asItems = (value: unknown): StewardDigestItem[] =>
  Array.isArray(value) ? (value as StewardDigestItem[]) : [];

/** The stored row as `GET …/steward/digest/latest` serves it. */
export const digestView = (row: StewardDigest): StewardDigestView => {
  const content = (row.content ?? {}) as Partial<DigestContent>;
  return {
    id: row.id,
    projectId: row.projectId,
    trigger: row.trigger,
    createdAt: row.createdAt.toISOString(),
    from: row.from.toISOString(),
    to: row.to.toISOString(),
    prose: row.prose,
    done: asItems(content.done),
    stuck: asItems(content.stuck),
    waiting: asItems(content.waiting),
    spendUsd: typeof content.spendUsd === 'string' ? content.spendUsd : '0.00',
  };
};

/** A prose string that is safe to store: one bounded line, or null. */
export const boundedProse = (
  prose: string | null | undefined,
): string | null => {
  if (!prose) return null;
  const line = oneLine(prose, DIGEST_PROSE_MAX);
  return line === '' ? null : line;
};

const heading = (trigger: StewardDigestTrigger, projectName: string): string =>
  trigger === 'away_off'
    ? `While you were away — ${projectName}`
    : `Daily digest — ${projectName}`;

const line = (entry: StewardDigestItem, withReason: boolean): string => {
  const text = [
    escapeMarkdownV2(`${entry.label} · ${entry.title}`),
    withReason && entry.reason ? escapeMarkdownV2(` — ${entry.reason}`) : '',
  ].join('');
  return entry.url ? `• [${text}](${escapeLinkUrl(entry.url)})` : `• ${text}`;
};

const section = (
  title: string,
  entries: StewardDigestItem[],
  withReason: boolean,
): string[] => {
  if (entries.length === 0) return [];
  const shown = entries.slice(0, TELEGRAM_LINES_PER_SECTION);
  const more = entries.length - shown.length;
  return [
    '',
    `*${escapeMarkdownV2(`${title} (${entries.length})`)}*`,
    ...shown.map((entry) => line(entry, withReason)),
    ...(more > 0 ? [escapeMarkdownV2(`+${more} more`)] : []),
  ];
};

/**
 * The digest as one Telegram MarkdownV2 message (D14). Built only from the
 * stored, bounded strings, every character escaped, so nothing in a title or
 * a reason can become markup; cut at the section that would overflow the
 * Telegram limit.
 */
export const digestTelegramText = (
  view: StewardDigestView,
  projectName: string,
): string => {
  const head = [
    `*${escapeMarkdownV2(oneLine(heading(view.trigger, projectName), 200))}*`,
    ...(view.prose ? [escapeMarkdownV2(view.prose)] : []),
  ];
  const empty =
    view.done.length + view.stuck.length + view.waiting.length === 0;
  const blocks = [
    ...(empty ? ['', escapeMarkdownV2('Nothing to report.')] : []),
    ...section('Done', view.done, false),
    ...section('Stuck', view.stuck, true),
    ...section('Waiting for you', view.waiting, true),
    '',
    escapeMarkdownV2(`Spend: $${view.spendUsd}`),
  ];
  let text = head.join('\n');
  for (const block of blocks) {
    if (text.length + block.length + 1 > TELEGRAM_BUDGET) break;
    text += `\n${block}`;
  }
  return text;
};
