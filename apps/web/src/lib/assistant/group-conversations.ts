import type { AssistantConversationView } from '@nautelle/shared';

export type ConversationGroupKey = 'today' | 'yesterday' | 'week' | 'earlier';

export interface ConversationGroup {
  key: ConversationGroupKey;
  label: string;
  conversations: AssistantConversationView[];
}

const ORDER: ConversationGroupKey[] = ['today', 'yesterday', 'week', 'earlier'];

export const GROUP_LABEL: Record<ConversationGroupKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  earlier: 'Earlier',
};

const DAY_MS = 86_400_000;

/** The browser's timezone; `undefined` lets `Intl` fall back to it. */
export const personTimeZone = (): string | undefined =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;

/** The calendar day of an instant in a timezone, as days since 1970-01-01. */
function dayNumber(instant: Date, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);
  const part = (type: string) =>
    Number(parts.find((each) => each.type === type)?.value);
  return Math.round(
    Date.UTC(part('year'), part('month') - 1, part('day')) / DAY_MS,
  );
}

function keyFor(
  updatedAt: string,
  now: Date,
  timeZone: string | undefined,
): ConversationGroupKey {
  const diffDays =
    dayNumber(now, timeZone) - dayNumber(new Date(updatedAt), timeZone);
  // A stamp ahead of this device's clock (the server's leads it) is today.
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 7) return 'week';
  return 'earlier';
}

/**
 * The rail's date groups. Calendar days in the person's timezone, not 24-hour
 * windows: a conversation from 23:50 yesterday is "Yesterday" at 00:10, and
 * one from 00:10 today is "Today" at 23:50. "Previous 7 days" is 2 to 7
 * calendar days back. Groups come back in display order, only the non-empty
 * ones, each keeping the order the API sent (newest first).
 */
export function groupConversations(
  conversations: readonly AssistantConversationView[],
  now: Date = new Date(),
  timeZone: string | undefined = personTimeZone(),
): ConversationGroup[] {
  const byKey = new Map<ConversationGroupKey, AssistantConversationView[]>();
  for (const conversation of conversations) {
    const key = keyFor(conversation.updatedAt, now, timeZone);
    const list = byKey.get(key);
    if (list) list.push(conversation);
    else byKey.set(key, [conversation]);
  }
  return ORDER.flatMap((key) => {
    const list = byKey.get(key);
    return list ? [{ key, label: GROUP_LABEL[key], conversations: list }] : [];
  });
}
