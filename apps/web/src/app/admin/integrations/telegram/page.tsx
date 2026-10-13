'use client';

import type {
  TelegramBotTokenUpdate,
  TelegramIntegrationStatus,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../components/prerequisites/async-section';
import { DisabledReason } from '../../../../components/prerequisites/disabled-reason';
import { PrerequisiteBanner } from '../../../../components/prerequisites/prerequisite-banner';
import { api, errorText } from '../../../../lib/api';
import { Time } from '../../../../lib/format/time';
import { ENCRYPTION_KEY_REMEDY } from '../../../../lib/prerequisites/copy';
import { useErrorToast } from '../../../../lib/section/use-error-toast';
import { useSection } from '../../../../lib/section/use-section';
import {
  describeTelegramError,
  pollingNote,
  removeBotConsequence,
  TELEGRAM_LINK_PAGE,
} from '../../../../lib/telegram/format';

const PATH = '/admin/integrations/telegram';

export default function TelegramIntegrationPage() {
  const section = useSection(() => api<TelegramIntegrationStatus>(PATH), []);
  const showError = useErrorToast();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: TelegramBotTokenUpdate = { token: token.trim() };
      const state = await api<TelegramIntegrationStatus>(PATH, {
        method: 'PUT',
        body,
      });
      // The token is gone from the page the moment it is sent.
      setToken('');
      section.setData(state);
      toast.success(
        state.unlinkedUsers
          ? `Bot saved. ${state.unlinkedUsers} linked user(s) must link again — it is a different bot.`
          : 'Bot saved.',
      );
    } catch (err) {
      setError(errorText(describeTelegramError(err)));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      section.setData(
        await api<TelegramIntegrationStatus>(PATH, { method: 'DELETE' }),
      );
      setConfirmRemove(false);
      toast.success('Bot token removed.');
    } catch (err) {
      showError(describeTelegramError(err));
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
      showError(describeTelegramError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="Telegram"
        description="One bot for this instance. Each person links their own chat under Account › Notifications, then gets the notifications they chose there."
      />

      <AsyncSection
        section={section}
        unavailable={{
          title: 'The Telegram settings are not answering',
          stillWorks: 'Notifications keep going out with the bot already set.',
        }}
        isEmpty={() => false}
        empty={null}
        skeleton={<Skeleton className="h-64 w-full" />}
      >
        {(state) => (
          <>
            {state.encryptionAvailable ? null : (
              <PrerequisiteBanner
                tone="warn"
                title="No APP_ENCRYPTION_KEY on the server"
                body={`The bot token is stored encrypted, so it cannot be set until the key is. ${ENCRYPTION_KEY_REMEDY}`}
              />
            )}

            <Card pad="lg">
              <h2 className="mb-4 text-lg font-bold">Status</h2>
              <dl className="grid max-w-xl grid-cols-[10rem_1fr] gap-y-2 text-sm">
                <dt className="text-ink-3">Bot</dt>
                <dd>
                  {state.configured
                    ? state.botUsername
                      ? `@${state.botUsername}`
                      : 'Configured'
                    : 'Not configured'}
                </dd>
                <dt className="text-ink-3">Polling</dt>
                <dd>
                  {state.polling ? 'Running' : 'Not running'}
                  <div className="text-xs text-ink-3">{pollingNote(state)}</div>
                </dd>
                <dt className="text-ink-3">Last poll</dt>
                <dd>
                  <Time value={state.lastPollAt} />
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
                <div className="mt-4 flex flex-col gap-1">
                  <div className="flex gap-3">
                    <Button disabled={busy} onClick={() => void test()}>
                      Send test message
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => setConfirmRemove(true)}
                    >
                      Remove bot
                    </Button>
                  </div>
                  <p className="text-xs text-ink-2">
                    The test goes to your own chat.{' '}
                    <Link
                      href={TELEGRAM_LINK_PAGE}
                      className="text-accent-ink underline underline-offset-2"
                    >
                      Link your Telegram
                    </Link>{' '}
                    first if you have not.
                  </p>
                </div>
              ) : null}
            </Card>

            <Card pad="lg">
              <h2 className="mb-4 text-lg font-bold">
                {state.configured
                  ? 'Replace the bot token'
                  : 'Set the bot token'}
              </h2>
              <form onSubmit={save} className="flex max-w-md flex-col gap-4">
                <Field
                  label="Bot token"
                  htmlFor="bot-token"
                  required
                  hint={
                    state.configured
                      ? 'The stored token is never shown. Enter a new one to replace it.'
                      : 'From @BotFather in Telegram: send /newbot, then copy the token it gives you. It is verified with Telegram, then stored encrypted.'
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
                <div className="flex flex-col gap-1">
                  <div>
                    <Button
                      type="submit"
                      variant="solid"
                      disabled={
                        busy ||
                        !state.encryptionAvailable ||
                        token.trim() === ''
                      }
                      aria-describedby="bot-token-reason"
                    >
                      Save token
                    </Button>
                  </div>
                  {!state.encryptionAvailable ? (
                    <DisabledReason id="bot-token-reason">
                      Setting a token needs APP_ENCRYPTION_KEY on the server —
                      see the banner above.
                    </DisabledReason>
                  ) : token.trim() === '' ? (
                    <DisabledReason id="bot-token-reason">
                      Paste a token to save it.
                    </DisabledReason>
                  ) : null}
                </div>
              </form>
            </Card>

            <DialogRoot
              open={confirmRemove}
              onOpenChange={(open) => !open && !busy && setConfirmRemove(false)}
            >
              <DialogContent
                title="Remove the Telegram bot?"
                description={removeBotConsequence(state)}
                footer={
                  <>
                    <Button
                      variant="glass"
                      disabled={busy}
                      onClick={() => setConfirmRemove(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => void clear()}
                    >
                      Remove bot
                    </Button>
                  </>
                }
              >
                {null}
              </DialogContent>
            </DialogRoot>
          </>
        )}
      </AsyncSection>
    </div>
  );
}
