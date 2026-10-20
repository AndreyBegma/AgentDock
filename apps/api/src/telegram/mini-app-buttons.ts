import { cardLabel, type MiniAppTarget, miniAppPath } from '@nautelle/shared';
import type {
  InlineButton,
  MenuButton,
  TelegramReplyMarkup,
  WebAppButton,
} from './telegram-client';

/** The menu button's label beside the chat's input field. */
export const MENU_BUTTON_TEXT = 'Board';
export const OPEN_IN_APP_TEXT = 'Open in app';
/** Telegram shows a few Web App buttons well; more cards keep their links. */
const OPEN_BUTTONS_MAX = 5;

/**
 * #580: the Mini App's URL for `target`, or null when `APP_URL` is not
 * https — Telegram opens a Mini App only over TLS, so the bot then keeps to
 * the plain links its messages already carry.
 */
export const miniAppUrl = (
  appUrl: string | null,
  target: MiniAppTarget | null,
): string | null =>
  appUrl?.startsWith('https://') ? `${appUrl}${miniAppPath(target)}` : null;

/** The menu button: the Mini App's Board, or Telegram's default without one. */
export const menuButton = (appUrl: string | null): MenuButton => {
  const url = miniAppUrl(appUrl, null);
  return url
    ? { type: 'web_app', text: MENU_BUTTON_TEXT, web_app: { url } }
    : { type: 'default' };
};

/** An "Open in app" button for a card; null without an https `APP_URL`. */
export const openInAppButton = (
  appUrl: string | null,
  target: MiniAppTarget,
  text = OPEN_IN_APP_TEXT,
): WebAppButton | null => {
  const url = miniAppUrl(appUrl, target);
  return url ? { text, web_app: { url } } : null;
};

/**
 * `markup` with an "Open in app" row for `target` below its own buttons.
 * Unchanged without a target or an https `APP_URL`, and for a reply prompt:
 * Telegram takes buttons or a prompt, not both.
 */
export const withOpenInApp = (
  markup: TelegramReplyMarkup | undefined,
  appUrl: string | null,
  target: MiniAppTarget | null,
): TelegramReplyMarkup | undefined => {
  const button = target ? openInAppButton(appUrl, target) : null;
  if (!button) return markup;
  if (!markup) return { inline_keyboard: [[button]] };
  if (!('inline_keyboard' in markup)) return markup;
  return { inline_keyboard: [...markup.inline_keyboard, [button]] };
};

/** One "Open C-12" button per card, a few at most; none without https. */
export const openCardsKeyboard = (
  appUrl: string | null,
  projectId: string,
  cards: readonly { number: number }[],
): InlineButton[][] =>
  cards.slice(0, OPEN_BUTTONS_MAX).flatMap((card) => {
    const button = openInAppButton(
      appUrl,
      { projectId, card: card.number },
      cards.length === 1 ? OPEN_IN_APP_TEXT : `Open ${cardLabel(card.number)}`,
    );
    return button ? [[button]] : [];
  });
