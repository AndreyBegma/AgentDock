import type {
  AiDigestItem,
  AiDigestSections,
  AiDigestView,
} from '@nautelle/shared';
import { oneLine } from '@nautelle/shared';
import type { AiDigest } from '@prisma/client';
import {
  escapeLinkUrl,
  escapeMarkdownV2,
  TELEGRAM_TEXT_MAX,
} from '../telegram/markdown-v2';
import type { AiDigestFacts } from './ai-digest-composer';

/** The model's overview, as one bounded line. */
export const AI_DIGEST_OVERVIEW_MAX = 800;
/** Lines shown per section in Telegram; the rest become "+N more". */
const TELEGRAM_LINES_PER_SECTION = 8;
/** Telegram refuses longer texts; leave headroom for markup. */
const TELEGRAM_BUDGET = TELEGRAM_TEXT_MAX - 200;

const asItems = (value: unknown): AiDigestItem[] =>
  Array.isArray(value) ? (value as AiDigestItem[]) : [];

/** A sent row as `GET …/ai/digest/latest` serves it. */
export const aiDigestView = (row: AiDigest): AiDigestView => {
  const content = (row.content ?? {}) as Partial<AiDigestSections>;
  return {
    id: row.id,
    projectId: row.projectId,
    dueAt: row.dueAt.toISOString(),
    from: row.from.toISOString(),
    to: row.to.toISOString(),
    overview: row.overview ?? '',
    provider: row.provider ?? 'anthropic',
    model: row.model ?? '',
    createdAt: row.createdAt.toISOString(),
    done: asItems(content.done),
    stuck: asItems(content.stuck),
    waiting: asItems(content.waiting),
  };
};

export const AI_DIGEST_SYSTEM = [
  'You write the daily digest of one software project for the people who run it.',
  'You get the facts of the last day as JSON: what got done, what is stuck, what waits for a person, and how the Board moved.',
  'Write two to four plain sentences in English: the gist first, then what most needs a person.',
  'Use only the facts given. Name cards by their label (C-12). No greeting, no headings, no lists, no Markdown.',
  'When nothing happened, say so in one sentence.',
].join('\n');

/** The user message of the overview call: the facts, as JSON. */
export const aiDigestPrompt = (
  projectName: string,
  from: Date,
  to: Date,
  facts: AiDigestFacts,
): string =>
  JSON.stringify({
    project: projectName,
    from: from.toISOString(),
    to: to.toISOString(),
    board: facts.board,
    done: facts.sections.done.map(({ url: _url, ...item }) => item),
    stuck: facts.sections.stuck.map(({ url: _url, ...item }) => item),
    waiting: facts.sections.waiting.map(({ url: _url, ...item }) => item),
  });

/** The overview as stored: one bounded line. */
export const boundedOverview = (text: string): string =>
  oneLine(text, AI_DIGEST_OVERVIEW_MAX);

const line = (entry: AiDigestItem): string => {
  const text = escapeMarkdownV2(
    `${entry.label} · ${entry.title}${entry.reason ? ` — ${entry.reason}` : ''}`,
  );
  return entry.url ? `• [${text}](${escapeLinkUrl(entry.url)})` : `• ${text}`;
};

const section = (title: string, entries: AiDigestItem[]): string[] => {
  if (entries.length === 0) return [];
  const shown = entries.slice(0, TELEGRAM_LINES_PER_SECTION);
  const more = entries.length - shown.length;
  return [
    '',
    `*${escapeMarkdownV2(`${title} (${entries.length})`)}*`,
    ...shown.map(line),
    ...(more > 0 ? [escapeMarkdownV2(`+${more} more`)] : []),
  ];
};

/**
 * The digest as one Telegram MarkdownV2 message: the overview, then done,
 * stuck and waiting with their links. Every character of a stored string is
 * escaped, so nothing in a title or the model's text becomes markup; cut at
 * the section that would overflow the Telegram limit.
 */
export const aiDigestTelegramText = (
  view: AiDigestView,
  projectName: string,
  activityUrl: string | null,
): string => {
  const head = [
    `*${escapeMarkdownV2(oneLine(`Daily digest — ${projectName}`, 200))}*`,
    escapeMarkdownV2(view.overview),
  ];
  const blocks = [
    ...section('Done', view.done),
    ...section('Stuck', view.stuck),
    ...section('Waiting for you', view.waiting),
    ...(activityUrl
      ? [
          '',
          `[${escapeMarkdownV2('Open activity')}](${escapeLinkUrl(activityUrl)})`,
        ]
      : []),
  ];
  let text = head.join('\n');
  for (const block of blocks) {
    if (text.length + block.length + 1 > TELEGRAM_BUDGET) break;
    text += `\n${block}`;
  }
  return text;
};
