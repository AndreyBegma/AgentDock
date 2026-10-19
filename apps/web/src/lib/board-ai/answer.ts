import {
  type BoardAskHit,
  type BoardAskQuery,
  LLM_PROVIDER_INFO,
  type LlmProviderId,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';
import { resetDate } from '../assistant/notice';
import { COLUMN_TITLE } from '../board/format';
import { boardCardHref } from '../board/href';

/** One piece of an answer: text, or a reference turned into a link. */
export type AnswerPart =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string; external: boolean };

/** Where a hit opens: a card's sheet, a PR on GitHub, an activity item's link. */
export const hitHref = (
  hit: BoardAskHit,
): { href: string; external: boolean } | null => {
  switch (hit.type) {
    case 'card':
      return {
        href: boardCardHref(hit.projectId, hit.number),
        external: false,
      };
    case 'pr':
      return { href: hit.url, external: true };
    case 'activity':
      return hit.link
        ? { href: hit.link, external: /^https?:/.test(hit.link) }
        : null;
  }
};

const REFERENCE = /\[(C-\d+|PR #\d+)\]/g;

/**
 * #660: the answer with each `[C-12]` and `[PR #34]` it names linked to the
 * hit it means. A reference to nothing that was found stays plain text, so a
 * made-up number is never a link.
 */
export function answerParts(answer: string, hits: BoardAskHit[]): AnswerPart[] {
  const targets = new Map<string, { href: string; external: boolean }>();
  for (const hit of hits) {
    if (hit.type === 'card') {
      targets.set(
        hit.label,
        hitHref(hit) as { href: string; external: boolean },
      );
      if (hit.prNumber && hit.prUrl && !targets.has(`PR #${hit.prNumber}`)) {
        targets.set(`PR #${hit.prNumber}`, { href: hit.prUrl, external: true });
      }
    } else if (hit.type === 'pr') {
      targets.set(`PR #${hit.number}`, { href: hit.url, external: true });
    }
  }
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const match of answer.matchAll(REFERENCE)) {
    const at = match.index ?? 0;
    const target = targets.get(match[1]);
    if (!target) continue;
    if (at > last) parts.push({ type: 'text', text: answer.slice(last, at) });
    parts.push({ type: 'link', text: match[1], ...target });
    last = at + match[0].length;
  }
  if (last < answer.length) {
    parts.push({ type: 'text', text: answer.slice(last) });
  }
  return parts;
}

/** One filter the question was turned into, shown as a removable chip. */
export interface QueryChip {
  id: string;
  label: string;
}

const SOURCE_TITLE = { cards: 'Cards', prs: 'PRs', activity: 'Activity' };

/**
 * #660 (design 4): the query as chips, so the person can check what the
 * question became. All three sources read as no chip: that narrows nothing.
 */
export function queryChips(query: BoardAskQuery): QueryChip[] {
  const chips: QueryChip[] = [];
  for (const name of query.projects) {
    chips.push({ id: `project:${name}`, label: `Project: ${name}` });
  }
  if (query.text.length > 0) {
    chips.push({ id: 'text', label: `Text: ${query.text.join(' ')}` });
  }
  for (const column of query.columns) {
    chips.push({
      id: `column:${column}`,
      label: `Column: ${COLUMN_TITLE[column]}`,
    });
  }
  if (query.kind) {
    chips.push({
      id: 'kind',
      label: `Kind: ${query.kind === 'bug' ? 'Bug' : 'Feature'}`,
    });
  }
  if (query.prState)
    chips.push({ id: 'prState', label: `PR: ${query.prState}` });
  if (query.checks)
    chips.push({ id: 'checks', label: `Checks: ${query.checks}` });
  if (query.withinDays) {
    chips.push({
      id: 'withinDays',
      label: `Created: last ${query.withinDays} day${query.withinDays === 1 ? '' : 's'}`,
    });
  }
  if (query.sources.length < 3) {
    chips.push({
      id: 'sources',
      label: `In: ${query.sources.map((s) => SOURCE_TITLE[s]).join(', ')}`,
    });
  }
  return chips;
}

/** The query without the chip `id`: removing a chip widens the search. */
export function withoutChip(query: BoardAskQuery, id: string): BoardAskQuery {
  const [key, value] = id.split(/:(.*)/s);
  switch (key) {
    case 'project':
      return { ...query, projects: query.projects.filter((p) => p !== value) };
    case 'column':
      return { ...query, columns: query.columns.filter((c) => c !== value) };
    case 'text':
      return { ...query, text: [] };
    case 'kind':
      return { ...query, kind: null };
    case 'prState':
      return { ...query, prState: null };
    case 'checks':
      return { ...query, checks: null };
    case 'withinDays':
      return { ...query, withinDays: null };
    case 'sources':
      return { ...query, sources: ['cards', 'prs', 'activity'] };
    default:
      return query;
  }
}

export interface AskNotice {
  tone: 'cap' | 'error';
  title: string;
  text: string;
}

/**
 * What the dialog says when a question fails. A reached cap names the
 * provider and the day it resets; anything else is the server's sentence.
 */
export function askNotice(error: unknown, timeZone?: string): AskNotice {
  const body = error instanceof ApiError ? error.body : null;
  if (body?.error === 'llm_cap_reached') {
    const provider =
      typeof body.provider === 'string' && body.provider in LLM_PROVIDER_INFO
        ? LLM_PROVIDER_INFO[body.provider as LlmProviderId].label
        : 'The provider';
    const when =
      typeof body.resetsAt === 'string'
        ? ` It resets on ${resetDate(body.resetsAt, timeZone)}.`
        : '';
    return {
      tone: 'cap',
      title: `${provider} has reached its monthly cap`,
      text: `Ask the Board cannot answer until then.${when}`,
    };
  }
  return {
    tone: 'error',
    title: 'The Board could not answer',
    text:
      error instanceof ApiError && typeof body?.message === 'string'
        ? body.message
        : describeError(error),
  };
}
