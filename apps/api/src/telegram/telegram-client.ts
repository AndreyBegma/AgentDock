import { Inject, Injectable } from '@nestjs/common';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';

/** Calls other than the long poll give up after this long. */
const CALL_TIMEOUT_MS = 15_000;
/** The long poll's own timeout plus this much before the HTTP call is cut. */
const POLL_GRACE_MS = 10_000;
const DESCRIPTION_MAX = 200;
/** #594: a file download — a photo or a voice message — gives up after this long. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

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

/** #594: a file the bot downloads is cut off past its limit. */
export class FileTooLargeError extends Error {
  constructor() {
    super('The file is over the size limit');
    this.name = 'FileTooLargeError';
  }
}

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
  is_bot?: boolean;
  username?: string;
}

/** #594: one size of a photo; Telegram sends several, the largest last. */
export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** #594: a file sent as a document, a voice message or an audio note. */
export interface TelegramFileRef {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  /** #594: the text sent with a photo, a document or a voice message. */
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramFileRef;
  voice?: TelegramFileRef;
  audio?: TelegramFileRef;
  /** The message this one answers; Telegram fills it, the sender cannot. */
  reply_to_message?: TelegramMessage;
}

/** A press on an inline keyboard button (#82). */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  /** The message that carried the button; absent when it is too old. */
  message?: TelegramMessage;
  data?: string;
}

/** The part of an `Update` this module reads; every other kind is skipped. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** #576: a button that opens a link instead of sending a press back. */
export interface InlineKeyboardUrlButton {
  text: string;
  url: string;
}

/** #580: a button that opens the Mini App at `web_app.url`, an https URL. */
export interface WebAppButton {
  text: string;
  web_app: { url: string };
}

/** Any button of an inline keyboard. */
export type InlineButton =
  | InlineKeyboardButton
  | InlineKeyboardUrlButton
  | WebAppButton;

export type InlineKeyboard = InlineButton[][];

/**
 * #580: the button beside the chat's input field — the Mini App, or
 * Telegram's default (the command list) when it cannot be one.
 */
export type MenuButton =
  | { type: 'default' }
  | { type: 'web_app'; text: string; web_app: { url: string } };

/** One entry of the bot's command menu (`setMyCommands`). */
export interface BotCommand {
  /** 1–32 characters of `a-z`, `0-9` and `_`, without the slash. */
  command: string;
  /** 1–256 characters. */
  description: string;
}

/** What `sendMessage` may attach: buttons, or a prompt to reply to it. */
export type TelegramReplyMarkup =
  | { inline_keyboard: InlineKeyboard }
  | { force_reply: true; input_field_placeholder?: string };

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

const isUser = (value: unknown): value is TelegramUser =>
  isObject(value) &&
  typeof value.id === 'number' &&
  (value.is_bot === undefined || typeof value.is_bot === 'boolean');

const isFileId = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0;

const isOptional = (value: unknown, type: 'string' | 'number'): boolean =>
  value === undefined || typeof value === type;

const isPhotoSize = (value: unknown): value is TelegramPhotoSize =>
  isObject(value) &&
  isFileId(value.file_id) &&
  typeof value.width === 'number' &&
  typeof value.height === 'number' &&
  isOptional(value.file_size, 'number');

const isFileRef = (value: unknown): value is TelegramFileRef =>
  isObject(value) &&
  isFileId(value.file_id) &&
  isOptional(value.file_name, 'string') &&
  isOptional(value.mime_type, 'string') &&
  isOptional(value.file_size, 'number');

/** #594: a message's media, when present, has the shape this module reads. */
const hasValidMedia = (value: Record<string, unknown>): boolean =>
  isOptional(value.caption, 'string') &&
  (value.photo === undefined ||
    (Array.isArray(value.photo) && value.photo.every(isPhotoSize))) &&
  (value.document === undefined || isFileRef(value.document)) &&
  (value.voice === undefined || isFileRef(value.voice)) &&
  (value.audio === undefined || isFileRef(value.audio));

const isMessage = (value: unknown, depth = 0): value is TelegramMessage =>
  isObject(value) &&
  typeof value.message_id === 'number' &&
  isChat(value.chat) &&
  (value.text === undefined || typeof value.text === 'string') &&
  hasValidMedia(value) &&
  (value.from === undefined || isUser(value.from)) &&
  // Telegram never nests a reply inside a reply's `reply_to_message`.
  (value.reply_to_message === undefined ||
    (depth === 0 && isMessage(value.reply_to_message, depth + 1)));

const isCallbackQuery = (value: unknown): value is TelegramCallbackQuery =>
  isObject(value) &&
  typeof value.id === 'string' &&
  isUser(value.from) &&
  (value.message === undefined || isMessage(value.message)) &&
  (value.data === undefined || typeof value.data === 'string');

const toUpdate = (value: unknown): TelegramUpdate | null => {
  if (!isObject(value) || typeof value.update_id !== 'number') return null;
  return {
    update_id: value.update_id,
    ...(isMessage(value.message) ? { message: value.message } : {}),
    ...(isCallbackQuery(value.callback_query)
      ? { callback_query: value.callback_query }
      : {}),
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
 * The Bot API over HTTPS (spec 22 D7): `getMe`, the `getUpdates` long poll,
 * `sendMessage`, `editMessageText` (#574), `answerCallbackQuery` (D12),
 * `setMyCommands` (#500), `setChatMenuButton` (#580), and `getFile` with
 * the file download (#594). Stateless — the token is passed per call, read from
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
      {
        offset,
        timeout: timeoutS,
        allowed_updates: ['message', 'callback_query'],
      },
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

  /**
   * Sends `text`, already escaped for `MarkdownV2` unless `plain`. The sent
   * message's id; null when Telegram's answer does not name one.
   */
  async sendMessage(
    token: string,
    chatId: bigint | number,
    text: string,
    plain = false,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<number | null> {
    const result = await this.call(token, 'sendMessage', {
      // A chat id fits a double (Telegram documents 52 significant bits).
      chat_id: Number(chatId),
      text,
      ...(plain ? {} : { parse_mode: 'MarkdownV2' }),
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return isObject(result) && typeof result.message_id === 'number'
      ? result.message_id
      : null;
  }

  /** #620: "typing…" in the chat, for five seconds or until the next message. */
  async sendChatAction(token: string, chatId: bigint | number): Promise<void> {
    await this.call(token, 'sendChatAction', {
      chat_id: Number(chatId),
      action: 'typing',
    });
  }

  /**
   * #574: replaces the text of a message the bot sent, and its buttons —
   * none when `inlineKeyboard` is absent. Same escaping as `sendMessage`.
   */
  async editMessageText(
    token: string,
    chatId: bigint | number,
    messageId: number,
    text: string,
    plain = false,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<void> {
    await this.call(token, 'editMessageText', {
      chat_id: Number(chatId),
      message_id: messageId,
      text,
      ...(plain ? {} : { parse_mode: 'MarkdownV2' }),
      link_preview_options: { is_disabled: true },
      ...(inlineKeyboard
        ? { reply_markup: { inline_keyboard: inlineKeyboard } }
        : {}),
    });
  }

  /**
   * #594: where a file the bot received can be downloaded from — its
   * `file_path` — and its size when Telegram knows it.
   */
  async getFile(
    token: string,
    fileId: string,
  ): Promise<{ path: string; size: number | null }> {
    const result = await this.call(token, 'getFile', { file_id: fileId });
    if (!isObject(result) || typeof result.file_path !== 'string') {
      throw new TelegramApiError(
        'invalid_response',
        'getFile did not name a file path',
      );
    }
    return {
      path: result.file_path,
      size: typeof result.file_size === 'number' ? result.file_size : null,
    };
  }

  /**
   * #594: the bytes of a file `getFile` named, refused past `maxBytes` —
   * by its length up front, else while it streams in.
   */
  async downloadFile(
    token: string,
    filePath: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const base = this.options.apiBase.replace(/\/+$/, '');
    const path = filePath.split('/').map(encodeURIComponent).join('/');
    let response: Response;
    try {
      response = await this.options.fetch(`${base}/file/bot${token}/${path}`, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok || !response.body) {
      throw new TelegramApiError(
        'api',
        `file download: HTTP ${response.status}`,
        response.status,
      );
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body.cancel();
      throw new FileTooLargeError();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new FileTooLargeError();
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof FileTooLargeError) throw error;
      throw networkError(error);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  /** Stops the button's spinner; `text` shows as a short notice. */
  async answerCallbackQuery(
    token: string,
    callbackQueryId: string,
    text: string,
  ): Promise<void> {
    await this.call(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  /**
   * The command menu private chats show (#500): the bot is private-chat
   * only, so the menu is scoped to them.
   */
  async setMyCommands(token: string, commands: BotCommand[]): Promise<void> {
    await this.call(token, 'setMyCommands', {
      commands,
      scope: { type: 'all_private_chats' },
    });
  }

  /** #580: the menu button of every private chat that has none of its own. */
  async setChatMenuButton(token: string, button: MenuButton): Promise<void> {
    await this.call(token, 'setChatMenuButton', { menu_button: button });
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
