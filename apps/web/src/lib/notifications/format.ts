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
} from '@agentdock/shared';

export const BELL_LIMIT = 20;

export const KIND_LABEL: Record<NotificationKind, string> = {
  'person.needed': 'A person is needed',
  'slot.blocked': 'Slot blocked',
  'pane.prompt': 'Pane is waiting for input',
  'quota.hit': 'Quota reached',
  'queue.dry': 'Queue is empty',
  'pr.awaiting_approval': 'Pull request awaiting approval',
  'runner.offline': 'Runner offline',
  'runner.online': 'Runner back online',
  'budget.exceeded': 'Budget exceeded',
  'budget.threshold': 'Budget threshold reached',
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
  'budget.exceeded': 'danger',
  'budget.threshold': 'warn',
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const age = Math.max(0, now - then);
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)} d ago`;
  return new Date(then).toLocaleDateString();
}

/** A link from the API is a path in this app; anything else is not followed. */
export const safeLink = (link: string | null): string | null =>
  link?.startsWith('/') && !link.startsWith('//') ? link : null;

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

/** Whether the Telegram routes answered "not deployed" rather than failed. */
export const isNotDeployed = (status: number): boolean =>
  status === 404 || status === 503;
