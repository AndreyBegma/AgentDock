'use client';

import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, describeError } from '../api';
import { isNotDeployed } from './format';
import type { TelegramLinkStart, TelegramLinkState } from './types';

export type TelegramLinkView =
  | { status: 'loading' }
  | { status: 'not-deployed' }
  | { status: 'error' }
  | { status: 'ready'; state: TelegramLinkState };

/** The caller's own Telegram link: state, start linking, unlink. */
export function useTelegramLink() {
  const [view, setView] = useState<TelegramLinkView>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await api<TelegramLinkState>(
        '/notifications/telegram/link',
      );
      setView({ status: 'ready', state });
    } catch (error) {
      if (error instanceof ApiError && isNotDeployed(error.status)) {
        setView({ status: 'not-deployed' });
      } else {
        setView({ status: 'error' });
        toast.error(describeError(error));
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Asks for a one-time deep link; the caller opens it. Null on failure. */
  const start = useCallback(async (): Promise<TelegramLinkStart | null> => {
    setBusy(true);
    try {
      return await api<TelegramLinkStart>('/notifications/telegram/link', {
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
