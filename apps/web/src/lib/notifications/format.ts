import {
  NOTIFICATION_KIND_SPECS,
  NOTIFICATION_NEW_EVENT,
  NOTIFICATION_READ_EVENT,
  type NotificationChannel,
  type NotificationKind,
  type NotificationNewLive,
  type NotificationReadLive,
  type NotificationRuleView,
  type NotificationView,
} from '@nautelle/shared';
import { formatRelative } from '../format';
import { internalHref } from '../url';

export const BELL_LIMIT = 20;

/** Past two digits a count is a glance, not a readout: 100 reads as "99+". */
export function unreadCountText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** The bell carries a dot, not a number, so its name says how many. */
export function bellLabel(unreadCount: number): string {
  return unreadCount > 0
    ? `Notifications, ${unreadCountText(unreadCount)} unread`
    : 'Notifications';
}

export const KIND_LABEL: Record<NotificationKind, string> = {
  'person.needed': 'A person is needed',
  'slot.blocked': 'Slot blocked',
  'pane.prompt': 'Pane is waiting for input',
  'quota.hit': 'Quota reached',
  'queue.dry': 'Queue is empty',
  'pr.awaiting_approval': 'Pull request awaiting approval',
  'runner.offline': 'Runner offline',
  'runner.online': 'Runner back online',
  'runner.connection_replaced': 'Runner connection replaced',
  'budget.exceeded': 'Budget exceeded',
  'budget.threshold': 'Budget threshold reached',
  'schedule.disabled': 'Schedule disabled',
  'action.requested': 'Action requested',
  'card.finished': 'Board card finished',
  'card.waiting': 'Card worker is waiting for you',
  'card.background_stalled': 'Card worker stuck on its own background task',
  'card.demo': 'Demo video of a card ready or failed',
  'cards.suggested': 'Cards suggested from your sessions',
  'steward.incident': 'Steward needs you on stuck work',
  'account.throttled': 'Sign-in attempts throttled',
  'telegram.link_pending': 'Telegram chat waits for your confirmation',
};

/** What a notification of the kind reads like, under the rule's name. */
export const KIND_EXAMPLE: Record<NotificationKind, string> = {
  'person.needed': 'The orchestrator asks “which base branch?”',
  'slot.blocked': 'Slot i19 · luna-watch is blocked',
  'pane.prompt': 'Slot i19 is waiting for a yes or no',
  'quota.hit': 'Slot i19 hit its usage limit',
  'queue.dry': 'luna-watch has no issue left to dispatch',
  'pr.awaiting_approval': 'PR #157 is ready and waits for your approval',
  'runner.offline': 'Runner build-box went offline',
  'runner.online': 'Runner build-box is back online',
  'runner.connection_replaced':
    'Another connection took over runner build-box — re-pair if it was not you',
  'budget.exceeded': 'luna-watch spent its whole monthly budget',
  'budget.threshold': 'luna-watch reached 80 % of its monthly budget',
  'schedule.disabled': 'The nightly review schedule was turned off',
  'action.requested': 'A session asks to start the orchestrator',
  'card.finished': 'Card C-12 · luna-watch is finished, PR #160 opened',
  'card.waiting': 'The worker of card C-12 waits for your answer',
  'card.background_stalled':
    'C-39 has been waiting on its own background task for 30 min',
  'card.demo': 'C-12 demo · PR #160 · CI green, with Merge and Feedback',
  'cards.suggested': '3 cards suggested in the luna-watch Inbox',
  'steward.incident':
    'C-12 needs you: API error persisted after 2 nudges — open the terminal',
  'account.throttled':
    'Ana Diaz’s account had 5 wrong passwords from 203.0.113.7',
  'telegram.link_pending':
    '@anatg used your link code — confirm it if that chat is yours',
};

export type RuleGroup =
  | 'fleet'
  | 'runners'
  | 'budgets'
  | 'schedules'
  | 'security';

export const RULE_GROUP_LABEL: Record<RuleGroup, string> = {
  fleet: 'Orchestrator and slots',
  runners: 'Runners',
  budgets: 'Budgets',
  schedules: 'Schedules',
  security: 'Security',
};

const KIND_GROUP: Record<NotificationKind, RuleGroup> = {
  'person.needed': 'fleet',
  'slot.blocked': 'fleet',
  'pane.prompt': 'fleet',
  'quota.hit': 'fleet',
  'queue.dry': 'fleet',
  'pr.awaiting_approval': 'fleet',
  'runner.offline': 'runners',
  'runner.online': 'runners',
  'runner.connection_replaced': 'runners',
  'budget.exceeded': 'budgets',
  'budget.threshold': 'budgets',
  'schedule.disabled': 'schedules',
  'action.requested': 'fleet',
  'card.finished': 'fleet',
  'card.waiting': 'fleet',
  'card.background_stalled': 'fleet',
  'card.demo': 'fleet',
  'cards.suggested': 'fleet',
  'steward.incident': 'fleet',
  'account.throttled': 'security',
  'telegram.link_pending': 'security',
};

export type KindTone = 'ok' | 'warn' | 'danger' | 'neutral';

export const KIND_TONE: Record<NotificationKind, KindTone> = {
  'person.needed': 'warn',
  'slot.blocked': 'danger',
  'pane.prompt': 'warn',
  'quota.hit': 'danger',
  'queue.dry': 'neutral',
  'pr.awaiting_approval': 'warn',
  'runner.offline': 'danger',
  'runner.online': 'ok',
  'runner.connection_replaced': 'danger',
  'budget.exceeded': 'danger',
  'budget.threshold': 'warn',
  'schedule.disabled': 'danger',
  'action.requested': 'warn',
  'card.finished': 'ok',
  'card.waiting': 'warn',
  'card.background_stalled': 'warn',
  'card.demo': 'ok',
  'cards.suggested': 'neutral',
  'steward.incident': 'warn',
  'account.throttled': 'danger',
  'telegram.link_pending': 'warn',
};

export interface FeedState {
  items: NotificationView[];
  unreadCount: number;
}

export const EMPTY_FEED: FeedState = { items: [], unreadCount: 0 };

/** Whether a row belongs in the Unread tab: unread, and not a muted arrival. */
export const isUnread = (item: NotificationView): boolean =>
  item.readAt === null && !item.muted;

/**
 * `notification.new`: a new row goes first; a fold replaces the row it folded
 * into and moves it up, because its `lastAt` is now the newest. `limit` caps
 * a list that does not page (the bell).
 */
export function applyNew(
  state: FeedState,
  live: NotificationNewLive,
  options: { unreadOnly?: boolean; limit?: number } = {},
): FeedState {
  const { notification, unreadCount } = live;
  const rest = state.items.filter((item) => item.id !== notification.id);
  const include = !options.unreadOnly || isUnread(notification);
  const items = include ? [notification, ...rest] : rest;
  return {
    items: options.limit ? items.slice(0, options.limit) : items,
    unreadCount,
  };
}

/** `notification.read`: `ids` null marks everything read. */
export function applyRead(
  state: FeedState,
  live: NotificationReadLive,
  readAt: string,
  options: { unreadOnly?: boolean } = {},
): FeedState {
  const ids = live.ids === null ? null : new Set(live.ids);
  const touched = (item: NotificationView) => ids === null || ids.has(item.id);
  const items = options.unreadOnly
    ? state.items.filter((item) => !touched(item))
    : state.items.map((item) =>
        touched(item) && item.readAt === null ? { ...item, readAt } : item,
      );
  return { items, unreadCount: live.unreadCount };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The payload of a `notification.new` frame, or null when it is not one. */
export function parseNewLive(
  event: string,
  data: unknown,
): NotificationNewLive | null {
  if (event !== NOTIFICATION_NEW_EVENT || !isRecord(data)) return null;
  const { notification, unreadCount } = data;
  if (
    !isRecord(notification) ||
    typeof notification.id !== 'string' ||
    typeof notification.kind !== 'string' ||
    typeof unreadCount !== 'number'
  ) {
    return null;
  }
  return data as unknown as NotificationNewLive;
}

/** The payload of a `notification.read` frame, or null when it is not one. */
export function parseReadLive(
  event: string,
  data: unknown,
): NotificationReadLive | null {
  if (event !== NOTIFICATION_READ_EVENT || !isRecord(data)) return null;
  const { ids, unreadCount } = data;
  if (typeof unreadCount !== 'number') return null;
  if (
    ids !== null &&
    !(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))
  ) {
    return null;
  }
  return data as unknown as NotificationReadLive;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date — the app's one formatter (R3). */
export const relativeTime = (iso: string, now: number = Date.now()): string =>
  formatRelative(iso, now);

/** A link from the API is a path in this app; anything else is not followed. */
export const safeLink = (link: string | null): string | null =>
  link?.startsWith('/') ? (internalHref(link) ?? null) : null;

/** `YYYY-MM-DD` of a local date, for `<input type="date">`. */
export function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The end of the chosen local day as an ISO instant — "until 12 Oct" mutes
 * through the 12th. Null for an empty or unreadable value (mute until removed).
 */
export function fromDateInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const end = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    23,
    59,
    59,
    0,
  );
  return Number.isNaN(end.getTime()) ? null : end.toISOString();
}

/** Whether a chosen day (see `fromDateInput`) is still ahead of `now`. */
export function isFutureDay(value: string, now: number = Date.now()): boolean {
  const iso = fromDateInput(value);
  return iso !== null && new Date(iso).getTime() > now;
}

export interface RuleRow {
  kind: NotificationKind;
  label: string;
  /** A sample of what arrives, in words. */
  example: string;
  /** The events behind it: for a tooltip only, never the visible text (R2). */
  source: string;
  inApp: boolean;
  telegram: boolean;
  /** Which switches can be turned on at all, and why not. */
  inAppDisabled: boolean;
  telegramDisabled: boolean;
  telegramNote: 'unlinked' | 'in-app only' | null;
}

/**
 * The Rules table: one row per kind the API returned (it already leaves out
 * what the caller cannot receive). The Telegram switch is disabled until the
 * caller has linked a chat, and for a kind that has no Telegram channel.
 */
export function ruleRows(
  rules: NotificationRuleView[],
  telegramLinked: boolean,
): RuleRow[] {
  return rules.map((rule) => {
    const channels: readonly NotificationChannel[] =
      rule.channels ?? NOTIFICATION_KIND_SPECS[rule.kind].channels;
    const hasTelegram = channels.includes('telegram');
    return {
      kind: rule.kind,
      label: KIND_LABEL[rule.kind],
      example: KIND_EXAMPLE[rule.kind],
      source: NOTIFICATION_KIND_SPECS[rule.kind].source,
      inApp: rule.inApp,
      telegram: hasTelegram && rule.telegram,
      inAppDisabled: !channels.includes('inApp'),
      telegramDisabled: !hasTelegram || !telegramLinked,
      telegramNote: !hasTelegram
        ? 'in-app only'
        : telegramLinked
          ? null
          : 'unlinked',
    };
  });
}

export interface RuleSection {
  group: RuleGroup;
  label: string;
  rows: RuleRow[];
}

/** The rules by area, in a fixed order; an area with no rule is left out. */
export function ruleSections(rows: readonly RuleRow[]): RuleSection[] {
  return (Object.keys(RULE_GROUP_LABEL) as RuleGroup[])
    .map((group) => ({
      group,
      label: RULE_GROUP_LABEL[group],
      rows: rows.filter((row) => KIND_GROUP[row.kind] === group),
    }))
    .filter((section) => section.rows.length > 0);
}

/** Flip one channel of one kind; the body of the `PUT /notifications/rules`. */
export function ruleUpdate(
  row: Pick<RuleRow, 'kind' | 'inApp' | 'telegram'>,
  channel: NotificationChannel,
  value: boolean,
) {
  return {
    rules: [
      {
        kind: row.kind,
        inApp: row.inApp,
        telegram: row.telegram,
        [channel]: value,
      },
    ],
  };
}
