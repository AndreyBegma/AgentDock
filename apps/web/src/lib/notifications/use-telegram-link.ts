'use client';

import type { TelegramLinkCode, TelegramLinkStatus } from '@agentdock/shared';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../api';

export type TelegramLinkView =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; state: TelegramLinkStatus };

/** The caller's own Telegram link: state, start linking, unlink. */
export function useTelegramLink() {
  const [view, setView] = useState<TelegramLinkView>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await api<TelegramLinkStatus>(
        '/notifications/telegram/link',
      );
      setView({ status: 'ready', state });
    } catch (error) {
      setView({ status: 'error' });
      toast.error(describeError(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Asks for a one-time deep link; the caller opens it. Null on failure. */
  const start = useCallback(async (): Promise<TelegramLinkCode | null> => {
    setBusy(true);
    try {
      return await api<TelegramLinkCode>('/notifications/telegram/link', {
        method: 'POST',
      });
    } catch (error) {
      toast.error(describeError(error));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const unlink = useCallback(async () => {
    setBusy(true);
    try {
      await api('/notifications/telegram/link', { method: 'DELETE' });
      await load();
      toast.success('Telegram unlinked.');
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [load]);

  return { view, busy, reload: load, start, unlink };
}
