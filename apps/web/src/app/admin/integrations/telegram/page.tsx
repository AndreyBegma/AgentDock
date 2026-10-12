'use client';

import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { Field, Input } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, describeError } from '../../../../lib/api';
import { isNotDeployed } from '../../../../lib/notifications/format';
import type {
  TelegramAdminStatus,
  TelegramBotTokenUpdate,
} from '../../../../lib/notifications/types';

const PATH = '/admin/integrations/telegram';

/** A sentence for the Telegram routes' own error codes; the generic one otherwise. */
function describeTelegramError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (String(error.code)) {
      case 'encryption_key_missing':
        return 'The server has no APP_ENCRYPTION_KEY, so it cannot store a bot token.';
      case 'telegram_token_invalid':
        return 'Telegram did not accept this token.';
      case 'telegram_unavailable':
        return 'Telegram could not be reached. Try again in a minute.';
      case 'telegram_not_configured':
        return 'The bot is not configured.';
      case 'telegram_not_linked':
        return 'Link your own Telegram on the Notifications page first; the test goes to your chat.';
    }
  }
  return describeError(error);
}

type View =
  | { status: 'loading' }
  | { status: 'not-deployed' }
  | { status: 'ready'; state: TelegramAdminStatus };

export default function TelegramIntegrationPage() {
  const [view, setView] = useState<View>({ status: 'loading' });
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView({
        status: 'ready',
        state: await api<TelegramAdminStatus>(PATH),
      });
    } catch (err) {
      if (err instanceof ApiError && isNotDeployed(err.status)) {
        setView({ status: 'not-deployed' });
      } else {
        toast.error(describeTelegramError(err));
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: TelegramBotTokenUpdate = { token: token.trim() };
      const state = await api<TelegramAdminStatus>(PATH, {
        method: 'PUT',
        body,
      });
      // The token is gone from the page the moment it is sent.
      setToken('');
      setView({ status: 'ready', state });
      toast.success(
        state.unlinkedUsers
          ? `Bot saved. ${state.unlinkedUsers} linked user(s) must link again — it is a different bot.`
          : 'Bot saved.',
      );
    } catch (err) {
      setError(describeTelegramError(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await api(PATH, { method: 'DELETE' });
      await load();
      toast.success('Bot token removed.');
    } catch (err) {
      toast.error(describeTelegramError(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await api(`${PATH}/test`, { method: 'POST' });
      toast.success('Test message sent to your linked chat.');
    } catch (err) {
      toast.error(describeTelegramError(err));
    } finally {
      setBusy(false);
    }
  };

  if (view.status === 'loading') {
    return <p className="text-ink-2 text-sm">Loading…</p>;
  }
  if (view.status === 'not-deployed') {
    return (
      <Banner tone="info" title="Telegram">
        The Telegram part is not deployed yet. In-app notifications work as
        usual.
      </Banner>
    );
  }

  const { state } = view;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Telegram</h1>

      {state.encryptionAvailable ? null : (
        <Banner tone="warn" title="No encryption key">
          Set <code>APP_ENCRYPTION_KEY</code> on the API (32 random bytes,
          base64) before configuring the bot. The token is stored encrypted.
        </Banner>
      )}

      <Card pad="lg">
        <h2 className="mb-4 text-lg font-bold">Status</h2>
        <dl className="grid max-w-md grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-ink-3">Bot</dt>
          <dd>
            {state.configured
              ? state.botUsername
                ? `@${state.botUsername}`
                : 'Configured'
              : 'Not configured'}
          </dd>
          <dt className="text-ink-3">Polling</dt>
          <dd>{state.polling ? 'Running' : 'Not running'}</dd>
          <dt className="text-ink-3">Last poll</dt>
          <dd>
            {state.lastPollAt
              ? new Date(state.lastPollAt).toLocaleString()
              : '—'}
          </dd>
          <dt className="text-ink-3">Linked users</dt>
          <dd>{state.linkedUsers}</dd>
        </dl>
        {state.lastError ? (
          <div className="mt-4">
            <Banner tone="warn" title="Last poller error">
              {state.lastError}
            </Banner>
          </div>
        ) : null}
        {state.configured ? (
          <div className="mt-4 flex gap-3">
            <Button disabled={busy} onClick={() => void test()}>
              Send test message
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void clear()}
            >
              Remove bot
            </Button>
          </div>
        ) : null}
      </Card>

      <Card pad="lg">
        <h2 className="mb-4 text-lg font-bold">
          {state.configured ? 'Replace the bot token' : 'Set the bot token'}
        </h2>
        <form onSubmit={save} className="flex max-w-md flex-col gap-4">
          <Field
            label="Bot token"
            htmlFor="bot-token"
            hint={
              state.configured
                ? 'The stored token is never shown. Enter a new one to replace it.'
                : 'From @BotFather. It is verified with Telegram, then stored encrypted.'
            }
            error={error}
          >
            <Input
              id="bot-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={!state.encryptionAvailable}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          <div>
            <Button
              type="submit"
              variant="solid"
              disabled={
                busy || !state.encryptionAvailable || token.trim() === ''
              }
            >
              Save token
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
