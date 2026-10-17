import type { PublicUser } from '../auth/contracts';
import { workCardHref } from '../work/format';

/**
 * #580: the web app's Telegram Mini App entry route. The bot's menu button
 * and its "Open in app" buttons open it; it signs in with Telegram's
 * `initData` and moves on to the Board.
 */
export const MINI_APP_PATH = '/tg';

/** The query parameter a Web App button carries the target in. */
export const MINI_APP_TARGET_PARAM = 'start';

/** What the Mini App opens: a project's Board, optionally with a card's sheet. */
export interface MiniAppTarget {
  projectId: string;
  /** The card's per-project number, or null for the Board alone. */
  card: number | null;
}

/** Telegram allows these in `start_param`, up to 64 of them. */
const START_PARAM_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_ID_SHAPE = /^[A-Za-z0-9-]{1,48}$/;
const CARD_SHAPE = /^[1-9][0-9]{0,8}$/;

/**
 * A target as a Telegram `start_param` — `<projectId>` or
 * `<projectId>_<card>` — so it fits a `t.me/<bot>/<app>?startapp=` link too.
 */
export const miniAppStartParam = (target: MiniAppTarget): string =>
  target.card === null
    ? target.projectId
    : `${target.projectId}_${target.card}`;

/** The target a `start_param` names; null for anything not shaped like one. */
export const parseMiniAppStartParam = (
  raw: string | null | undefined,
): MiniAppTarget | null => {
  if (!raw || !START_PARAM_SHAPE.test(raw)) return null;
  const [projectId, card, ...rest] = raw.split('_');
  if (rest.length > 0 || !projectId || !PROJECT_ID_SHAPE.test(projectId)) {
    return null;
  }
  if (card === undefined) return { projectId, card: null };
  return CARD_SHAPE.test(card) ? { projectId, card: Number(card) } : null;
};

/** The Mini App's own URL path for a target (a Web App button's `url`). */
export const miniAppPath = (target: MiniAppTarget | null): string =>
  target
    ? `${MINI_APP_PATH}?${MINI_APP_TARGET_PARAM}=${miniAppStartParam(target)}`
    : MINI_APP_PATH;

/** The web page a target opens once signed in. */
export const miniAppTargetHref = (target: MiniAppTarget): string =>
  target.card === null
    ? `/projects/${target.projectId}/board`
    : workCardHref(target.projectId, target.card);

/**
 * The target a card link of the web app (`/projects/<id>/board?card=<n>`)
 * names; null for any other link. The bot reads it off a notification's link.
 */
export const miniAppTargetOfLink = (
  link: string | null | undefined,
): MiniAppTarget | null => {
  const match = link?.match(
    /^\/projects\/([A-Za-z0-9-]{1,48})\/board\?card=([1-9][0-9]{0,8})$/,
  );
  return match ? { projectId: match[1], card: Number(match[2]) } : null;
};

/** `POST /auth/telegram` — sign in with a Mini App's `initData` (#580). */
export interface TelegramSignInRequest {
  /** `Telegram.WebApp.initData`, verbatim. */
  initData: string;
}

export interface TelegramSignInResponse {
  user: PublicUser;
  /**
   * The project the linked chat last worked on (`/project`), when the user
   * may still see it; the Mini App opens it when no target was passed.
   */
  projectId: string | null;
}
