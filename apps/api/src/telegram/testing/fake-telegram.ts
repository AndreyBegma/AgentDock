import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A request the fake received. */
export interface FakeCall {
  token: string;
  method: string;
  body: Record<string, unknown>;
}

/** A scripted answer: HTTP status and JSON body. */
export interface FakeReply {
  status: number;
  body: unknown;
}

export const BOT = { id: 7012345678, is_bot: true, username: 'agentdock_bot' };
/** A token of the shape BotFather hands out; the fake accepts it. */
export const BOT_TOKEN = '7012345678:AAE-very-secret-bot-token-value-xyz';

export const tooManyRequests = (retryAfter: number): FakeReply => ({
  status: 429,
  body: {
    ok: false,
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter}`,
    parameters: { retry_after: retryAfter },
  },
});

export const forbidden = (): FakeReply => ({
  status: 403,
  body: {
    ok: false,
    error_code: 403,
    description: 'Forbidden: bot was blocked by the user',
  },
});

export const serverError = (): FakeReply => ({
  status: 502,
  body: { ok: false, error_code: 502, description: 'Bad Gateway' },
});

/** A file of a multipart call (C-372), as the fake records it. */
export interface FakeUpload {
  name: string;
  type: string;
  size: number;
}

/**
 * A multipart call's fields (C-372): `chat_id` as a number and
 * `reply_markup` parsed, as a JSON call has them; a file as a `FakeUpload`.
 */
const readForm = async (
  bytes: Buffer,
  contentType: string,
): Promise<Record<string, unknown>> => {
  const form = await new Response(new Uint8Array(bytes), {
    headers: { 'content-type': contentType },
  }).formData();
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') {
      const upload: FakeUpload = {
        name: value.name,
        type: value.type,
        size: value.size,
      };
      body[key] = upload;
    } else if (key === 'chat_id') {
      body[key] = Number(value);
    } else if (key === 'reply_markup') {
      body[key] = JSON.parse(value) as unknown;
    } else {
      body[key] = value;
    }
  }
  return body;
};

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.startsWith('multipart/form-data')) {
        readForm(bytes, contentType).then(resolve, reject);
        return;
      }
      const text = bytes.toString('utf8');
      try {
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });

/**
 * A stand-in for the Bot API on 127.0.0.1 (spec 22: "Telegram is tested only
 * against the mock base URL"). It records every call, answers `getMe`,
 * `getUpdates`, `sendMessage` (each with a new `message_id`), `sendVideo`
 * (multipart, with a `file_id` per upload — C-372),
 * `editMessageText`, `answerCallbackQuery`, `sendChatAction`, `setMyCommands`,
 * `setChatMenuButton` and `getFile` like Telegram does, serves the files it
 * was given at `/file/bot<token>/<path>` (#594), refuses unknown tokens with 401,
 * and plays scripted replies per method first.
 */
export class FakeTelegram {
  readonly calls: FakeCall[] = [];
  /** What `getUpdates` hands out — those at or past the request's offset. */
  updates: { update_id: number; [key: string]: unknown }[] = [];
  readonly tokens = new Set<string>([BOT_TOKEN]);
  bot: typeof BOT = { ...BOT };
  /** #594: what `getFile` names and the file route serves, by `file_id`. */
  readonly files = new Map<string, { bytes: Buffer; size?: number }>();
  /** #594: the files the bot downloaded, by `file_id`. */
  readonly downloads: string[] = [];
  private readonly scripted = new Map<string, FakeReply[]>();

  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeTelegram> {
    let fake: FakeTelegram | null = null;
    const server = createServer((req, res) => {
      const file = fake?.file(req.url ?? '');
      if (file !== undefined) {
        if (file === null) {
          res.writeHead(404);
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(file);
        }
        return;
      }
      void fake?.handle(req).then(
        (reply) => {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    fake = new FakeTelegram(server, `http://127.0.0.1:${port}`);
    return fake;
  }

  /** The next call of `method` gets `reply` instead of the usual answer. */
  script(method: string, ...replies: FakeReply[]): void {
    this.scripted.set(method, [
      ...(this.scripted.get(method) ?? []),
      ...replies,
    ]);
  }

  /** #594: a file the chat sent, for `getFile` and the download route. */
  addFile(fileId: string, bytes: Buffer, size?: number): void {
    this.files.set(fileId, { bytes, size });
  }

  reset(): void {
    this.calls.length = 0;
    this.files.clear();
    this.downloads.length = 0;
    this.updates = [];
    this.scripted.clear();
    this.tokens.clear();
    this.tokens.add(BOT_TOKEN);
    this.bot = { ...BOT };
  }

  sent(): FakeCall[] {
    return this.calls.filter((c) => c.method === 'sendMessage');
  }

  /** C-372: the videos the bot sent, uploaded or by `file_id`. */
  videos(): FakeCall[] {
    return this.calls.filter((c) => c.method === 'sendVideo');
  }

  /** The messages the bot rewrote in place (#576). */
  edited(): FakeCall[] {
    return this.calls.filter((c) => c.method === 'editMessageText');
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /**
   * `/file/bot<token>/<file_path>`: the bytes, null for an unknown file or
   * token; undefined for any other path.
   */
  private file(url: string): Buffer | null | undefined {
    const match = /^\/file\/bot([^/]+)\/files\/([^/]+)$/.exec(url);
    if (!match) return undefined;
    const [, token, fileId] = match;
    const file = this.files.get(decodeURIComponent(fileId));
    if (!this.tokens.has(decodeURIComponent(token)) || !file) return null;
    this.downloads.push(decodeURIComponent(fileId));
    return file.bytes;
  }

  private async handle(req: IncomingMessage): Promise<FakeReply> {
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    if (!match) {
      return {
        status: 404,
        body: { ok: false, error_code: 404, description: 'Not Found' },
      };
    }
    const [, token, method] = match;
    const body = await readBody(req);
    this.calls.push({ token: decodeURIComponent(token), method, body });

    const queue = this.scripted.get(method);
    const next = queue?.shift();
    if (next) return next;
    if (!this.tokens.has(decodeURIComponent(token))) {
      return {
        status: 401,
        body: { ok: false, error_code: 401, description: 'Unauthorized' },
      };
    }
    switch (method) {
      case 'getMe':
        return { status: 200, body: { ok: true, result: this.bot } };
      case 'getUpdates': {
        const offset = typeof body.offset === 'number' ? body.offset : 0;
        return {
          status: 200,
          body: {
            ok: true,
            result: this.updates.filter((u) => u.update_id >= offset),
          },
        };
      }
      case 'sendMessage':
        return {
          status: 200,
          body: { ok: true, result: { message_id: this.calls.length } },
        };
      case 'sendVideo': {
        const video = body.video;
        const fileId =
          typeof video === 'string' ? video : `video-${this.calls.length}`;
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              message_id: this.calls.length,
              video: { file_id: fileId, file_unique_id: fileId },
            },
          },
        };
      }
      case 'editMessageText':
        return {
          status: 200,
          body: {
            ok: true,
            result: { message_id: body.message_id, text: body.text },
          },
        };
      case 'getFile': {
        const fileId = String(body.file_id);
        const file = this.files.get(fileId);
        if (!file) {
          return {
            status: 400,
            body: {
              ok: false,
              error_code: 400,
              description: 'Bad Request: invalid file_id',
            },
          };
        }
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              file_id: fileId,
              file_size: file.size ?? file.bytes.length,
              file_path: `files/${fileId}`,
            },
          },
        };
      }
      case 'answerCallbackQuery':
      case 'sendChatAction':
      case 'setMyCommands':
      case 'setChatMenuButton':
        return { status: 200, body: { ok: true, result: true } };
      default:
        return {
          status: 404,
          body: { ok: false, error_code: 404, description: 'Not Found' },
        };
    }
  }
}

/** A private-chat message update. */
export const privateMessage = (
  updateId: number,
  chatId: number,
  text: string,
  username = 'ada_tg',
) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false, username },
    text,
  },
});

/**
 * #594: a private message with media — a photo, a document, a voice message —
 * and maybe a caption, maybe replying to the bot's message `replyToId`.
 */
export const mediaMessage = (
  updateId: number,
  chatId: number,
  media: Record<string, unknown>,
  caption?: string,
  replyToId?: number,
) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false },
    ...media,
    ...(caption === undefined ? {} : { caption }),
    ...(replyToId === undefined
      ? {}
      : {
          reply_to_message: {
            message_id: replyToId,
            date: 0,
            chat: { id: chatId, type: 'private' },
            from: { id: BOT.id, is_bot: true },
            text: 'question',
          },
        }),
  },
});

/** A press on an inline button of a message the bot sent to a private chat. */
export const callbackPress = (
  updateId: number,
  chatId: number,
  data: string,
  messageId = 1,
) => ({
  update_id: updateId,
  callback_query: {
    id: `cb${updateId}`,
    from: { id: chatId, is_bot: false },
    chat_instance: '1',
    message: {
      message_id: messageId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: BOT.id, is_bot: true, username: BOT.username },
      text: 'PR waiting',
    },
    data,
  },
});

/** A private message replying to `replyTo`, sent by `from` (default: the bot). */
export const replyMessage = (
  updateId: number,
  chatId: number,
  text: string | undefined,
  replyTo: string,
  from: { id: number; is_bot: boolean } = { id: BOT.id, is_bot: true },
  replyToId = 1,
) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false },
    ...(text === undefined ? { sticker: { file_id: 'x' } } : { text }),
    reply_to_message: {
      message_id: replyToId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from,
      text: replyTo,
    },
  },
});

/** A group-chat message update. */
export const groupMessage = (
  updateId: number,
  chatId: number,
  text: string,
) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: chatId, type: 'group' },
    from: { id: 1, is_bot: false },
    text,
  },
});
