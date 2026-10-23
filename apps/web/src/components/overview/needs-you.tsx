'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  CircleCheck,
  CircleX,
  GitPullRequest,
  MessageSquareWarning,
  OctagonAlert,
  Settings2,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { Time } from '../../lib/format/time';
import type { NeedsYouItem } from '../../lib/overview/dashboard';
import type { TerminalSetupNeed } from '../../lib/setup/format';
import { notAnswering, Retry } from './shared';
import type { useDashboard } from './use-dashboard';

/** How many waiting items the glance shows before "Show more". */
const NEEDS_YOU_SHOWN = 5;

const NEEDS_ICON: Record<NeedsYouItem['kind'], ReactNode> = {
  profile: <Settings2 aria-hidden="true" className="size-4 text-warn" />,
  failed: <CircleX aria-hidden="true" className="size-4 text-danger" />,
  blocked: <OctagonAlert aria-hidden="true" className="size-4 text-danger" />,
  prompt: (
    <MessageSquareWarning aria-hidden="true" className="size-4 text-warn" />
  ),
  approval: <GitPullRequest aria-hidden="true" className="size-4 text-ink-2" />,
};

function NeedsYouList({
  items,
  setup,
}: {
  items: NeedsYouItem[];
  setup: TerminalSetupNeed[];
}) {
  if (items.length === 0 && setup.length === 0) {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-ink-2">
        <CircleCheck aria-hidden="true" className="size-4 text-ok" />
        Nothing is waiting on you.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {setup.map((need) => (
        <li key={need.key}>
          <Link
            href={need.href}
            className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-hover"
          >
            <span className="mt-0.5 shrink-0">{NEEDS_ICON.profile}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{need.title}</span>
              <span className="truncate text-xs text-ink-3">
                {need.projectName} · {need.reason}
              </span>
            </span>
          </Link>
        </li>
      ))}
      {items.map((item) => (
        <li key={item.key}>
          <Link
            href={item.href}
            className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-hover"
          >
            <span className="mt-0.5 shrink-0">{NEEDS_ICON[item.kind]}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{item.title}</span>
              <span className="truncate text-xs text-ink-3">
                {item.projectName} · {item.reason}
              </span>
            </span>
            {item.since ? (
              <Time
                value={item.since}
                className="shrink-0 text-xs whitespace-nowrap text-ink-3"
              />
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** What waits on the person across every project, oldest first. */
export function NeedsYou({
  facts,
  waiting,
  setup,
}: {
  facts: ReturnType<typeof useDashboard>['facts'];
  waiting: NeedsYouItem[] | undefined;
  setup: TerminalSetupNeed[];
}) {
  const [showAll, setShowAll] = useState(false);
  const shown =
    waiting && !showAll ? waiting.slice(0, NEEDS_YOU_SHOWN) : waiting;
  const hidden = (waiting?.length ?? 0) - (shown?.length ?? 0);

  return (
    <Section
      title="Needs you"
      description="Across every project, oldest first."
      pad="none"
      bodyClassName="px-2 py-1"
    >
      {shown ? (
        <>
          {facts.data && facts.data.failed.length > 0 ? (
            <p className="px-2 pt-2 text-xs text-warn">
              {notAnswering(facts.data.failed)}; what it waits on is not listed.
            </p>
          ) : null}
          <NeedsYouList items={shown} setup={setup} />
          {hidden > 0 ? (
            <div className="px-2 pb-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(true)}
              >
                Show {hidden} more
              </Button>
            </div>
          ) : null}
        </>
      ) : facts.error !== null ? (
        <Retry title="Could not check what waits on you" section={facts} />
      ) : (
        <Skeleton className="m-2 h-24" />
      )}
    </Section>
  );
}
