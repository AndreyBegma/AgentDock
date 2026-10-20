'use client';

import { toast } from '@andrewbehma/glass-ui/toast';
import type { TelegramLinkCode, TelegramLinkStatus } from '@nautelle/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, describeErrorHint } from '../api';
import { useErrorToast } from '../section/use-error-toast';

export type TelegramLinkView =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; state: TelegramLinkStatus };

/** The caller's own Telegram link: state, start linking, unlink. */
export function useTelegramLink() {
  const [view, setView] = useState<TelegramLinkView>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const load = useCallback(async () => {
    try {
      const state = await api<TelegramLinkStatus>(
        '/notifications/telegram/link',
      );
      setView({ status: 'ready', state });
    } catch {
      // The card shows the failure with a Try again; a toast would only repeat it.
      setView({ status: 'error' });
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
      showError(describeErrorHint(error));
      return null;
    } finally {
      setBusy(false);
    }
  }, [showError]);

  const unlink = useCallback(async () => {
    setBusy(true);
    try {
      await api('/notifications/telegram/link', { method: 'DELETE' });
      await load();
      toast.success('Telegram unlinked.');
    } catch (error) {
      showError(describeErrorHint(error));
    } finally {
      setBusy(false);
    }
  }, [load, showError]);

  return { view, busy, reload: load, start, unlink };
}
