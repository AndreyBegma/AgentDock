'use client';

import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { EmptyState } from 'glass-ui/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
} from 'glass-ui/segmented-control';
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
        <EmptyState
          title="Could not load notifications"
          action={<Button onClick={() => void feed.reload()}>Try again</Button>}
        />
      ) : feed.items.length === 0 ? (
        <EmptyState
          title={feed.loading ? 'Loading…' : 'Nothing here'}
          description={
            feed.loading
              ? undefined
              : tab === 'unread'
                ? 'Everything has been read.'
                : 'Things only a person can clear will show up here.'
          }
        />
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
