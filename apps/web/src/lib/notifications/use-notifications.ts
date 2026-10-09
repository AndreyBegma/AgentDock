'use client';

import type {
  NotificationPage,
  NotificationReadResult,
} from '@agentdock/shared';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from '../api';
import { useLive } from '../live/use-live';
import {
  applyNew,
  applyRead,
  EMPTY_FEED,
  type FeedState,
  parseNewLive,
  parseReadLive,
} from './format';

interface Options {
  /** Only unread, not-muted rows (the Unread tab). */
  unreadOnly?: boolean;
  /** Rows per request; the bell asks for 20. */
  limit?: number;
  /** Keep only the newest `limit` rows as live ones arrive (the bell). */
  capped?: boolean;
}

export interface NotificationFeed extends FeedState {
  loading: boolean;
  failed: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  reload: () => Promise<void>;
}

const query = (options: Options, cursor?: string) => {
  const params = new URLSearchParams();
  if (options.unreadOnly) params.set('unread', 'true');
  if (options.limit) params.set('limit', String(options.limit));
  if (cursor) params.set('cursor', cursor);
  const text = params.toString();
  return `/notifications${text ? `?${text}` : ''}`;
};

/**
 * The caller's notifications, kept current by `notification.new` and
 * `notification.read` on `user:<id>` (spec 22 D11). Read state changes are
 * applied from the server's answer and from the live frame alike; both carry
 * the authoritative unread count.
 */
export function useNotifications(
  userId: string,
  options: Options = {},
): NotificationFeed {
  const { unreadOnly = false, limit, capped = false } = options;
  const [feed, setFeed] = useState<FeedState>(EMPTY_FEED);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const page = await api<NotificationPage>(query({ unreadOnly, limit }));
      if (mine !== generation.current) return;
      setFeed({ items: page.items, unreadCount: page.unreadCount });
      setCursor(page.nextCursor);
      setFailed(false);
    } catch (error) {
      if (mine !== generation.current) return;
      setFailed(true);
      toast.error(describeError(error));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [unreadOnly, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  useLive(`user:${userId}`, (message) => {
    const created = parseNewLive(message.event, message.data);
    if (created) {
      setFeed((state) =>
        applyNew(state, created, {
          unreadOnly,
          limit: capped ? limit : undefined,
        }),
      );
      return;
    }
    const read = parseReadLive(message.event, message.data);
    if (read) {
      setFeed((state) =>
        applyRead(state, read, new Date().toISOString(), { unreadOnly }),
      );
    }
  });

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    try {
      const page = await api<NotificationPage>(
        query({ unreadOnly, limit }, cursor),
      );
      setFeed((state) => {
        const known = new Set(state.items.map((item) => item.id));
        return {
          items: [
            ...state.items,
            ...page.items.filter((item) => !known.has(item.id)),
          ],
          unreadCount: page.unreadCount,
        };
      });
      setCursor(page.nextCursor);
    } catch (error) {
      toast.error(describeError(error));
    }
  }, [cursor, unreadOnly, limit]);

  const markRead = useCallback(
    async (id: string) => {
      try {
        const result = await api<NotificationReadResult>(
          `/notifications/${encodeURIComponent(id)}/read`,
          { method: 'POST' },
        );
        setFeed((state) =>
          applyRead(
            state,
            { ids: [id], unreadCount: result.unreadCount },
            new Date().toISOString(),
            { unreadOnly },
          ),
        );
      } catch (error) {
        toast.error(describeError(error));
      }
    },
    [unreadOnly],
  );

  const markAllRead = useCallback(async () => {
    try {
      const result = await api<NotificationReadResult>(
        '/notifications/read-all',
        { method: 'POST' },
      );
      setFeed((state) =>
        applyRead(
          state,
          { ids: null, unreadCount: result.unreadCount },
          new Date().toISOString(),
          { unreadOnly },
        ),
      );
    } catch (error) {
      toast.error(describeError(error));
    }
  }, [unreadOnly]);

  return {
    ...feed,
    loading,
    failed,
    hasMore: cursor !== null,
    loadMore,
    markRead,
    markAllRead,
    reload: load,
  };
}
