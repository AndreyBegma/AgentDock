import { Inject, Injectable } from '@nestjs/common';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';

/** Calls other than the long poll give up after this long. */
const CALL_TIMEOUT_MS = 15_000;
/** The long poll's own timeout plus this much before the HTTP call is cut. */
const POLL_GRACE_MS = 10_000;
const DESCRIPTION_MAX = 200;

/** Anything shaped like a bot token: `<bot id>:<secret>`. */
const TOKEN_SHAPE = /\d{3,}:[A-Za-z0-9_-]{20,}/g;
export const REDACTED = '<redacted>';

/**
 * `text` without the bot token, nor anything shaped like one. Every string
 * that leaves the client — error messages, `lastError`, log lines — goes
 * through this: the token is part of every Telegram URL (spec 22 D8).
 */
export const redactToken = (text: string, token?: string): string => {
  let out = text;
  if (token) {
    out = out.split(token).join(REDACTED);
    const secret = token.slice(token.indexOf(':') + 1);
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  return out.replace(TOKEN_SHAPE, REDACTED);
};

export type TelegramErrorKind = 'api' | 'network' | 'invalid_response';

/**
 * A Telegram call that did not succeed. The message is Telegram's own
 * `description` (redacted, clipped) or fixed text; it never carries the URL,
 * so it is safe to log, store as `lastError` and return to an admin.
 */
export class TelegramApiError extends Error {
  constructor(
    readonly kind: TelegramErrorKind,
    message: string,
    /** Telegram's `error_code` (its HTTP status); null without a response. */
    readonly status: number | null = null,
    /** 429: seconds Telegram asks to wait. */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }

  /** The token is wrong or revoked: nothing sent with it can succeed. */
  get tokenRejected(): boolean {
    return this.status === 401 || this.status === 404;
  }

  /**
   * Retrying this message cannot help: the chat blocked the bot or is gone
   * (403), or Telegram refused the request itself (400).
   */
  get permanent(): boolean {
    return this.status === 400 || this.status === 403;
  }
}

export interface TelegramBot {
  id: number;
  username: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

/** The part of an `Update` this module reads; every other kind is skipped. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

type ApiResponse =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isApiResponse = (value: unknown): value is ApiResponse =>
  isObject(value) && typeof value.ok === 'boolean';

const isChat = (value: unknown): value is TelegramChat =>
  isObject(value) &&
  typeof value.id === 'number' &&
  typeof value.type === 'string';

const isMessage = (value: unknown): value is TelegramMessage =>
  isObject(value) &&
  typeof value.message_id === 'number' &&
  isChat(value.chat) &&
  (value.text === undefined || typeof value.text === 'string') &&
  (value.from === undefined ||
    (isObject(value.from) && typeof value.from.id === 'number'));

const toUpdate = (value: unknown): TelegramUpdate | null => {
  if (!isObject(value) || typeof value.update_id !== 'number') return null;
  return {
    update_id: value.update_id,
    ...(isMessage(value.message) ? { message: value.message } : {}),
  };
};

/** A network failure, in fixed words: the underlying message may name the URL. */
const networkError = (error: unknown): TelegramApiError => {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new TelegramApiError('network', 'Telegram API timed out');
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new TelegramApiError('network', 'Telegram API call aborted');
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    isObject(cause) && typeof cause.code === 'string' ? cause.code : null;
  return new TelegramApiError(
    'network',
    code && /^[A-Z_]+$/.test(code)
      ? `Telegram API unreachable (${code})`
      : 'Telegram API unreachable',
  );
};

/**
 * The Bot API over HTTPS (spec 22 D7): `getMe`, the `getUpdates` long poll and
 * `sendMessage`. Stateless — the token is passed per call, read from
 * `BotTokenStore` by the caller. The base URL is `TELEGRAM_API_BASE`, which
 * tests point at a fake server: nothing here ever reaches the real API in a
 * test.
 */
@Injectable()
export class TelegramClient {
  constructor(
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  async getMe(token: string): Promise<TelegramBot> {
    const result = await this.call(token, 'getMe', {});
    if (
      !isObject(result) ||
      typeof result.id !== 'number' ||
      typeof result.username !== 'string' ||
      result.is_bot !== true
    ) {
      throw new TelegramApiError(
        'invalid_response',
        'getMe did not describe a bot',
      );
    }
    return { id: result.id, username: result.username };
  }

  /** Long poll: waits up to `timeoutS` for updates at or past `offset`. */
  async getUpdates(
    token: string,
    offset: number,
    timeoutS: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const timeout = AbortSignal.timeout(timeoutS * 1000 + POLL_GRACE_MS);
    const result = await this.call(
      token,
      'getUpdates',
      { offset, timeout: timeoutS, allowed_updates: ['message'] },
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
    if (!Array.isArray(result)) {
      throw new TelegramApiError(
        'invalid_response',
        'getUpdates did not return a list',
      );
    }
    return result.map(toUpdate).filter((u): u is TelegramUpdate => u !== null);
  }

  /** Sends `text`, already escaped for `MarkdownV2` unless `plain`. */
  async sendMessage(
    token: string,
    chatId: bigint | number,
    text: string,
    plain = false,
  ): Promise<void> {
    await this.call(token, 'sendMessage', {
      // A chat id fits a double (Telegram documents 52 significant bits).
      chat_id: Number(chatId),
      text,
      ...(plain ? {} : { parse_mode: 'MarkdownV2' }),
      link_preview_options: { is_disabled: true },
    });
  }

  private async call(
    token: string,
    method: string,
    body: object,
    signal: AbortSignal = AbortSignal.timeout(CALL_TIMEOUT_MS),
  ): Promise<unknown> {
    const base = this.options.apiBase.replace(/\/+$/, '');
    let response: Response;
    try {
      response = await this.options.fetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw networkError(error);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new TelegramApiError(
        'invalid_response',
        `Telegram API answered ${response.status} without JSON`,
        response.status,
      );
    }
    if (!isApiResponse(parsed)) {
      throw new TelegramApiError(
        'invalid_response',
        `Telegram API answered ${response.status} with an unknown body`,
        response.status,
      );
    }
    if (parsed.ok) return parsed.result;

    const status = parsed.error_code ?? response.status;
    const description = redactToken(
      (parsed.description ?? `HTTP ${status}`).slice(0, DESCRIPTION_MAX),
      token,
    );
    const retryAfter = parsed.parameters?.retry_after;
    throw new TelegramApiError(
      'api',
      `${method}: ${description}`,
      status,
      typeof retryAfter === 'number' && retryAfter >= 0
        ? retryAfter
        : undefined,
    );
  }
}
