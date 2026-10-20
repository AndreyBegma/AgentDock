import {
  AUTH_ERROR,
  MINI_APP_TARGET_PARAM,
  miniAppTargetHref,
  parseMiniAppStartParam,
} from '@nautelle/shared';
import { ApiError, describeError } from '../api';

/** Telegram's Web App script (#580); the CSP allows its origin on `/tg` only. */
export const TELEGRAM_WEB_APP_SCRIPT =
  'https://telegram.org/js/telegram-web-app.js';

/** The part of `window.Telegram.WebApp` the Mini App uses. */
export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string };
  colorScheme: 'light' | 'dark';
  ready: () => void;
  expand: () => void;
  close: () => void;
  onEvent: (event: 'themeChanged', handler: () => void) => void;
  disableVerticalSwipes?: () => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** The Web App object once Telegram's script ran inside Telegram; else null. */
export const telegramWebApp = (): TelegramWebApp | null =>
  typeof window === 'undefined' ? null : (window.Telegram?.WebApp ?? null);

/**
 * Where the Mini App goes once signed in: the target the bot passed — a
 * direct link's `start_param`, else a Web App button's `?start=` — then the
 * project the chat last worked on, then home.
 */
export function miniAppDestination({
  startParam,
  search,
  projectId,
}: {
  startParam: string | undefined;
  search: string;
  projectId: string | null;
}): string {
  const target =
    parseMiniAppStartParam(startParam) ??
    parseMiniAppStartParam(
      new URLSearchParams(search).get(MINI_APP_TARGET_PARAM),
    );
  if (target) return miniAppTargetHref(target);
  return projectId ? `/projects/${projectId}/board` : '/';
}

/** What the Mini App shows instead of the Board. */
export type MiniAppProblem =
  | { kind: 'outside_telegram' }
  | { kind: 'not_linked' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

/** A failed sign-in as the screen that explains it. */
export function signInProblem(error: unknown): MiniAppProblem {
  if (error instanceof ApiError) {
    if (error.code === AUTH_ERROR.telegramNotLinked) {
      return { kind: 'not_linked' };
    }
    if (error.code === AUTH_ERROR.telegramExpired) return { kind: 'expired' };
  }
  return { kind: 'failed', message: describeError(error) };
}
