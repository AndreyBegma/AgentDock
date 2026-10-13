'use client';

import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { EmptyState } from 'glass-ui/empty-state';
import { SectionUnavailable } from 'glass-ui/section-unavailable';
import {
  SegmentedControl,
  SegmentedControlItem,
} from 'glass-ui/segmented-control';
import { Skeleton } from 'glass-ui/skeleton';
import { useState } from 'react';
import { NotificationItem } from '../../../components/shell/notification-item';
import { useCurrentUser } from '../../../components/shell/user-context';
import { useNotifications } from '../../../lib/notifications/use-notifications';

type Tab = 'all' | 'unread';

export function FeedSection() {
  const user = useCurrentUser();
  const [tab, setTab] = useState<Tab>('all');
  const feed = useNotifications(user.id, {
    unreadOnly: tab === 'unread',
    limit: 20,
  });

  return (
    <Card pad="lg">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Notifications</h2>
        <div className="flex items-center gap-3">
          <SegmentedControl role="group" aria-label="Filter notifications">
            {(['all', 'unread'] as const).map((value) => (
              <SegmentedControlItem
                key={value}
                active={tab === value}
                layoutId="notification-tab"
              >
                <button
                  type="button"
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                  className="relative w-full px-3 py-1 text-sm"
                >
                  {value === 'all'
                    ? 'All'
                    : `Unread${feed.unreadCount > 0 ? ` (${feed.unreadCount})` : ''}`}
                </button>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <Button
            size="sm"
            disabled={feed.unreadCount === 0}
            onClick={() => void feed.markAllRead()}
          >
            Mark all read
          </Button>
        </div>
      </div>
      {feed.failed ? (
        <div className="mb-3">
          <SectionUnavailable
            title="Notifications are not answering"
            stillWorks={
              feed.items.length > 0
                ? 'The rows below may be out of date.'
                : 'Your rules and mutes below still work.'
            }
            action={
              <Button
                variant="glass"
                size="sm"
                disabled={feed.loading}
                onClick={() => void feed.reload()}
              >
                Try again
              </Button>
            }
          />
        </div>
      ) : null}
      {feed.items.length === 0 ? (
        feed.failed ? null : feed.loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <EmptyState
            title={
              tab === 'unread' ? 'Everything has been read' : 'Nothing here yet'
            }
            description={
              tab === 'unread'
                ? 'New notifications that need you will show up here.'
                : 'You are told here when a slot is blocked, a runner drops, a budget is hit or a pull request waits for you. Choose which kinds below.'
            }
          />
        )
      ) : (
        <ul className="divide-line divide-y">
          {feed.items.map((item) => (
            <NotificationItem
              key={item.id}
              item={item}
              onRead={(id) => void feed.markRead(id)}
            />
          ))}
        </ul>
      )}
      {feed.hasMore ? (
        <div className="mt-4 text-center">
          <Button onClick={() => void feed.loadMore()}>Load more</Button>
        </div>
      ) : null}
    </Card>
  );
}
