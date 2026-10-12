'use client';

import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { PopoverContent, PopoverRoot, PopoverTrigger } from 'glass-ui/popover';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BELL_LIMIT } from '../../lib/notifications/format';
import { useNotifications } from '../../lib/notifications/use-notifications';
import { NotificationItem } from './notification-item';
import { useCurrentUser } from './user-context';

/**
 * The top bar's bell. It also holds the `user:<id>` subscription that keeps
 * the shell's live socket (and its status dot) alive.
 */
export function NotificationBell() {
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const feed = useNotifications(user.id, { limit: BELL_LIMIT, capped: true });

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          icon
          className="relative"
          aria-label={
            feed.unreadCount > 0
              ? `Notifications, ${feed.unreadCount} unread`
              : 'Notifications'
          }
        >
          <Bell size={16} aria-hidden="true" />
          {feed.unreadCount > 0 ? (
            <Badge
              tone="danger"
              count={feed.unreadCount}
              className="absolute -top-1 -right-1"
              data-testid="bell-count"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        title="Notifications"
        align="end"
        className="w-[min(26rem,calc(100vw-2rem))]"
        headerAction={
          <Button
            variant="ghost"
            size="sm"
            disabled={feed.unreadCount === 0}
            onClick={() => void feed.markAllRead()}
          >
            Mark all read
          </Button>
        }
        footer={
          <Link
            href="/account/notifications"
            onClick={() => setOpen(false)}
            className="text-sm hover:underline"
          >
            See all
          </Link>
        }
      >
        {feed.failed ? (
          <p className="text-ink-2 px-4 py-6 text-center text-sm">
            Could not load notifications.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => void feed.reload()}
            >
              Try again
            </button>
          </p>
        ) : feed.items.length === 0 ? (
          <p className="text-ink-2 px-4 py-6 text-center text-sm">
            {feed.loading ? 'Loading…' : 'Nothing needs you right now.'}
          </p>
        ) : (
          <ul className="divide-line divide-y">
            {feed.items.map((item) => (
              <NotificationItem
                key={item.id}
                item={item}
                onRead={(id) => void feed.markRead(id)}
                onNavigate={() => setOpen(false)}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}
