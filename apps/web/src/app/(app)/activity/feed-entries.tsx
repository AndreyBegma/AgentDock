'use client';

import {
  ACTIVITY_ITEM_LIVE_EVENT,
  type ActivityCategory,
  type ActivityItem,
  type ActivitySeverity,
  type LiveTopic,
} from '@agentdock/shared';
import { Chip } from '@andrewbehma/glass-ui/chip';
import type { TimelineItem } from '@andrewbehma/glass-ui/timeline';
import { Bot, GitPullRequest, Server, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  activityHref,
  actorName,
  CATEGORY_LABEL,
  type FeedRow,
  itemTitle,
  parseLiveItem,
  prLink,
  severityTone,
  typeLabel,
} from '../../../lib/activity/format';
import { pluralize } from '../../../lib/format';
import { useLive } from '../../../lib/live/use-live';

const CATEGORY_ICON: Record<ActivityCategory, ReactNode> = {
  fleet: <Bot size={14} strokeWidth={2} />,
  runner: <Server size={14} strokeWidth={2} />,
  audit: <ShieldCheck size={14} strokeWidth={2} />,
};

const SEVERITY_RANK: Record<ActivitySeverity, number> = {
  info: 0,
  ok: 1,
  warn: 2,
  danger: 3,
};

/** `useLive` takes one topic; a feed may follow several, so one invisible subscriber each. */
export function TopicListener({
  topic,
  onItem,
}: {
  topic: LiveTopic;
  onItem: (item: ActivityItem) => void;
}) {
  useLive(topic, (message) => {
    if (message.event !== ACTIVITY_ITEM_LIVE_EVENT) return;
    const item = parseLiveItem(message.data);
    if (item) onItem(item);
  });
  return null;
}

/**
 * A pull request as a `#205` chip (#213). With a URL it is a real link, and
 * rides in `TimelineItem.actions` beside the row — outside its anchor, so no
 * link nests in a link; tab order is the row, then the PR.
 */
function PrChip({ prNumber, href }: { prNumber: number; href?: string }) {
  const chip = (
    <Chip size="sm" className="gap-1 text-[11px]">
      <GitPullRequest aria-hidden="true" className="size-3" />
      <span className="sr-only">Pull request </span>#{prNumber}
    </Chip>
  );
  if (!href) return chip;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {chip}
    </a>
  );
}

function prActions(item: ActivityItem): ReactNode {
  const { prNumber } = itemTitle(item);
  const href = prLink(item);
  if (prNumber === null || !href) return undefined;
  return <PrChip prNumber={prNumber} href={href} />;
}

/**
 * What an item is about, as tinted chips; the event code only in the
 * tooltip (R2). A pull request is a `#205` chip, never a raw URL (#213); one
 * with a URL is shown by `prActions` instead, so it appears once.
 */
function ItemMeta({
  item,
  projectName,
  extra,
}: {
  item: ActivityItem;
  projectName: string | null;
  extra?: ReactNode;
}) {
  const { prNumber } = itemTitle(item);
  return (
    <span
      className="mt-0.5 flex flex-wrap items-center gap-1.5"
      title={item.type}
    >
      <span>{CATEGORY_LABEL[item.category] ?? typeLabel(item.category)}</span>
      {projectName ? (
        <span className="max-w-48 truncate">· {projectName}</span>
      ) : null}
      {item.slot ? (
        <Chip size="sm" className="text-[11px]">
          {item.slot}
        </Chip>
      ) : null}
      {item.issue !== null ? (
        <Chip size="sm" className="text-[11px]">
          #{item.issue}
        </Chip>
      ) : null}
      {prNumber !== null && !prLink(item) ? (
        <PrChip prNumber={prNumber} />
      ) : null}
      {extra}
    </span>
  );
}

/** A title that wraps anywhere: a long slot or plan name must not widen the row (R4). */
const Title = ({ item }: { item: ActivityItem }) => (
  <span className="[overflow-wrap:anywhere]">{itemTitle(item).title}</span>
);

export interface Names {
  projects: ReadonlyMap<string, string>;
  runners: ReadonlyMap<string, string>;
}

function projectNameOf(item: ActivityItem, names: Names, fixed: boolean) {
  if (fixed) return null;
  if (!item.projectId) return 'no project';
  return names.projects.get(item.projectId) ?? null;
}

function toEntry(item: ActivityItem, names: Names, fixed: boolean) {
  const name = actorName(item, names.runners);
  return {
    id: item.id,
    at: item.ts,
    tone: severityTone(item.severity),
    icon: CATEGORY_ICON[item.category],
    actor: name ? { name } : undefined,
    title: <Title item={item} />,
    meta: (
      <ItemMeta item={item} projectName={projectNameOf(item, names, fixed)} />
    ),
    href: activityHref(item),
    actions: prActions(item),
  } satisfies TimelineItem;
}

/**
 * Feed rows as Timeline items. A collapsed group is its newest item with
 * "N earlier" and opens in place; an open group is a header that closes it,
 * then every item.
 */
export function toEntries(
  rows: FeedRow[],
  open: ReadonlySet<string>,
  toggle: (id: string) => void,
  names: Names,
  fixed: boolean,
): TimelineItem[] {
  const entries: TimelineItem[] = [];
  for (const row of rows) {
    if (row.kind === 'item') {
      entries.push(toEntry(row.item, names, fixed));
      continue;
    }
    const [newest] = row.items;
    const worst = row.items.reduce((a, b) =>
      SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a,
    );
    if (open.has(row.id)) {
      entries.push({
        id: row.id,
        at: newest.ts,
        tone: severityTone(worst.severity),
        icon: CATEGORY_ICON[newest.category],
        title: `${row.label}: ${pluralize(row.items.length, 'update')}`,
        meta: 'Hide the updates',
        onSelect: () => toggle(row.id),
      });
      for (const item of row.items) entries.push(toEntry(item, names, fixed));
      continue;
    }
    const earlier = row.items.length - 1;
    const name = actorName(newest, names.runners);
    entries.push({
      id: row.id,
      at: newest.ts,
      tone: severityTone(worst.severity),
      icon: CATEGORY_ICON[newest.category],
      actor: name ? { name } : undefined,
      title: <Title item={newest} />,
      meta: (
        <ItemMeta
          item={newest}
          projectName={projectNameOf(newest, names, fixed)}
          extra={
            <span className="font-medium text-ink-2">
              · {pluralize(earlier, 'earlier update')}, show
            </span>
          }
        />
      ),
      actions: prActions(newest),
      onSelect: () => toggle(row.id),
    });
  }
  return entries;
}
