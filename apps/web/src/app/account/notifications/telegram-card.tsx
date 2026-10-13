'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { useState } from 'react';
import { formatDate } from '../../../lib/format';
import type { useTelegramLink } from '../../../lib/notifications/use-telegram-link';

type Link = ReturnType<typeof useTelegramLink>;

export function TelegramCard({ link }: { link: Link }) {
  const { view, busy, start, unlink, reload } = link;
  const [pending, setPending] = useState<{ url: string; expiresAt: string }>();

  const begin = async () => {
    const started = await start();
    if (!started) return;
    setPending(started);
    window.open(started.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Card pad="lg" id="telegram">
      <h2 className="mb-1 text-lg font-bold">Telegram</h2>
      <p className="text-ink-2 mb-4 text-sm">
        Get the notifications you pick below in a private chat with the bot.
      </p>
      {view.status === 'loading' ? (
        <p className="text-ink-2 text-sm">Loading…</p>
      ) : view.status === 'error' ? (
        <Banner
          tone="warn"
          title="Telegram is not answering"
          action={
            <Button size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          }
        >
          Could not read your Telegram link.
        </Banner>
      ) : view.state.linked ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">
            Linked
            {view.state.username ? ` as @${view.state.username}` : ''}
            {view.state.linkedAt
              ? ` · since ${formatDate(view.state.linkedAt, 'date')}`
              : ''}
          </span>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => void unlink()}
          >
            Unlink
          </Button>
        </div>
      ) : !view.state.botConfigured ? (
        <Banner tone="info">
          An administrator has not set up the Telegram bot yet. Until they do,
          notifications stay in the app.
        </Banner>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <Button
              variant="solid"
              disabled={busy}
              onClick={() => void begin()}
            >
              Link Telegram
            </Button>
          </div>
          {pending ? (
            <p className="text-ink-2 text-sm">
              Press Start in the chat that opened. If nothing opened,{' '}
              <a
                href={pending.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-ink underline"
              >
                open the link
              </a>{' '}
              (valid until {formatDate(pending.expiresAt, 'time')}), then{' '}
              <button
                type="button"
                className="text-accent-ink underline"
                onClick={() => void reload()}
              >
                check again
              </button>
              .
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
