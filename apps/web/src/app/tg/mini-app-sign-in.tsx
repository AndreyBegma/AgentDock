'use client';

import type {
  TelegramSignInRequest,
  TelegramSignInResponse,
} from '@agentdock/shared';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Script from 'next/script';
import { useCallback, useRef, useState } from 'react';
import { AuthCard } from '../../components/auth-card';
import { applyTheme, storeTheme } from '../../components/shell/theme';
import { api } from '../../lib/api';
import {
  type MiniAppProblem,
  miniAppDestination,
  signInProblem,
  TELEGRAM_WEB_APP_SCRIPT,
  type TelegramWebApp,
  telegramWebApp,
} from '../../lib/telegram/mini-app';

/** Telegram's light or dark, as the app's own theme — kept for later pages too. */
function followTelegramTheme(webApp: TelegramWebApp): void {
  const follow = () => {
    storeTheme(webApp.colorScheme);
    applyTheme(webApp.colorScheme);
  };
  follow();
  // On Telegram's global object: it outlives this page, across the Board.
  webApp.onEvent('themeChanged', follow);
}

/**
 * Loads Telegram's Web App script, signs in with its `initData` and replaces
 * itself with the Board the bot pointed at. Without Telegram, or refused,
 * it says why and what to do.
 */
export function MiniAppSignIn({ nonce }: { nonce: string | undefined }) {
  const router = useRouter();
  const [problem, setProblem] = useState<MiniAppProblem | null>(null);
  // `onReady` fires again on a remount; one sign-in is enough.
  const started = useRef(false);

  const start = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    const webApp = telegramWebApp();
    if (!webApp?.initData) {
      setProblem({ kind: 'outside_telegram' });
      return;
    }
    webApp.ready();
    webApp.expand();
    // A vertical swipe scrolls the Board instead of closing the app.
    webApp.disableVerticalSwipes?.();
    followTelegramTheme(webApp);
    try {
      const body: TelegramSignInRequest = { initData: webApp.initData };
      const { projectId } = await api<TelegramSignInResponse>(
        '/auth/telegram',
        { method: 'POST', body },
      );
      router.replace(
        miniAppDestination({
          startParam: webApp.initDataUnsafe.start_param,
          search: window.location.search,
          projectId,
        }),
      );
    } catch (error) {
      setProblem(signInProblem(error));
    }
  }, [router]);

  return (
    <>
      <Script
        src={TELEGRAM_WEB_APP_SCRIPT}
        nonce={nonce}
        strategy="afterInteractive"
        onReady={() => void start()}
        onError={() => setProblem({ kind: 'outside_telegram' })}
      />
      {problem ? (
        <Problem problem={problem} />
      ) : (
        <AuthCard
          title="Opening the Board"
          description="Signing you in with Telegram…"
        >
          <div className="flex justify-center py-2">
            <Spinner size="lg" label="Signing in" />
          </div>
        </AuthCard>
      )}
    </>
  );
}

const closeApp = () => telegramWebApp()?.close();

function Problem({ problem }: { problem: MiniAppProblem }) {
  switch (problem.kind) {
    case 'not_linked':
      return (
        <AuthCard
          title="Link your account first"
          description="This Telegram account is not linked to AgentDock yet."
        >
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-ink-2">
            <li>Sign in to AgentDock in a browser.</li>
            <li>Open Account → Notifications and connect Telegram.</li>
            <li>Come back to the bot and open the app again.</li>
          </ol>
          <Button variant="glass" full onClick={closeApp}>
            Close
          </Button>
        </AuthCard>
      );
    case 'expired':
      return (
        <AuthCard
          title="Open the app again"
          description="This session from Telegram is too old to sign in with. Close the app and open it again from the bot."
        >
          <Button variant="glass" full onClick={closeApp}>
            Close
          </Button>
        </AuthCard>
      );
    case 'outside_telegram':
      return (
        <AuthCard
          title="Open this in Telegram"
          description="This page signs you in from the AgentDock bot. Open it with the bot's menu button in Telegram, or sign in here with your password."
        >
          <Link
            href="/login"
            className={buttonClassName({ variant: 'glass', full: true })}
          >
            Sign in with a password
          </Link>
        </AuthCard>
      );
    case 'failed':
      return (
        <AuthCard title="Could not sign you in" description={problem.message}>
          <Button variant="glass" full onClick={closeApp}>
            Close
          </Button>
        </AuthCard>
      );
  }
}
