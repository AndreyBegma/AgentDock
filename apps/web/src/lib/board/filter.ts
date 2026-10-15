import {
  BOARD_CARD_KINDS,
  type BoardCardKind,
  type BoardCardView,
} from '@agentdock/shared';
import type { FilterCodec } from '../filters/url-filters';
import { roundPill } from './format';
import { isPlanItem, type WorkBoardItem } from './plan-tasks';

/** The states the toolbar can filter by: what is running, waiting on the person, or broken. */
export const STATE_FILTERS = ['running', 'waiting', 'error'] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export const STATE_FILTER_LABEL: Record<StateFilter, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  error: 'Needs attention',
};

export interface BoardFilter {
  text: string;
  kind: BoardCardKind | '';
  state: StateFilter | '';
}

export const NO_FILTER: BoardFilter = { text: '', kind: '', state: '' };

export const isFiltering = (filter: BoardFilter): boolean =>
  filter.text.trim() !== '' || filter.kind !== '' || filter.state !== '';

/** The filterable state of a card; `null` when its round is idle, finished or absent. */
export function stateOf(card: BoardCardView): StateFilter | null {
  const status = roundPill(card.round)?.status;
  return status === 'running' || status === 'waiting' || status === 'error'
    ? status
    : null;
}

/** Title, `C-12`, `#12` or a bare `12` — an issue or a PR number. */
function matchesText(card: BoardCardView, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [
    card.label,
    card.title,
    card.issueNumber !== null ? `#${card.issueNumber}` : '',
    card.prNumber !== null ? `#${card.prNumber} pr ${card.prNumber}` : '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * A plan task has no kind and no round, so only the text reaches it; a kind or
 * state filter hides it.
 */
export function matchesFilter(
  item: WorkBoardItem,
  filter: BoardFilter,
): boolean {
  if (isPlanItem(item)) {
    if (filter.kind !== '' || filter.state !== '') return false;
    return item.label.toLowerCase().includes(filter.text.trim().toLowerCase());
  }
  const { card } = item;
  if (filter.kind !== '' && card.kind !== filter.kind) return false;
  if (filter.state !== '' && stateOf(card) !== filter.state) return false;
  return matchesText(card, filter.text);
}

/** Cards running, and cards waiting on the person, among `items`. */
export function boardMeta(items: readonly WorkBoardItem[]): {
  running: number;
  waiting: number;
} {
  let running = 0;
  let waiting = 0;
  for (const item of items) {
    if (isPlanItem(item)) continue;
    const state = stateOf(item.card);
    if (state === 'running') running++;
    else if (state === 'waiting') waiting++;
  }
  return { running, waiting };
}

/** A column's count: `3`, or `1/3` while a filter hides some of it. */
export const countLabel = (shown: number, total: number): string =>
  shown === total ? String(total) : `${shown}/${total}`;

const isKind = (value: string): value is BoardCardKind =>
  (BOARD_CARD_KINDS as readonly string[]).includes(value);
const isState = (value: string): value is StateFilter =>
  (STATE_FILTERS as readonly string[]).includes(value);

/** The board's filters in the URL (`?q=&kind=&state=`); an unknown value reads as unset. */
export const boardFilterCodec: FilterCodec<BoardFilter> = {
  keys: ['q', 'kind', 'state'],
  parse: (params) => {
    const kind = params.get('kind') ?? '';
    const state = params.get('state') ?? '';
    return {
      text: (params.get('q') ?? '').trim(),
      kind: isKind(kind) ? kind : '',
      state: isState(state) ? state : '',
    };
  },
  search: (filters) => {
    const params = new URLSearchParams();
    if (filters.text.trim()) params.set('q', filters.text.trim());
    if (filters.kind) params.set('kind', filters.kind);
    if (filters.state) params.set('state', filters.state);
    const text = params.toString();
    return text ? `?${text}` : '';
  },
};

/**
 * A drop's index counted among the cards a filter shows, as an index among all
 * of the column's cards. Both lists exclude the moved card. The card lands
 * before the visible card it was dropped on; at the end of the visible list, or
 * on something the column does not hold (a plan task), it goes to the end.
 */
export function unfilteredIndex(
  allIds: readonly string[],
  visibleIds: readonly string[],
  index: number,
): number {
  const before = visibleIds[index];
  if (before === undefined) return allIds.length;
  const at = allIds.indexOf(before);
  return at === -1 ? allIds.length : at;
}
