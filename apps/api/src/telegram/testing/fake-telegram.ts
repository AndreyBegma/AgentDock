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

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
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
 * `getUpdates` and `sendMessage` like Telegram does, refuses unknown tokens
 * with 401, and plays scripted replies per method first.
 */
export class FakeTelegram {
  readonly calls: FakeCall[] = [];
  /** What `getUpdates` hands out — those at or past the request's offset. */
  updates: { update_id: number; [key: string]: unknown }[] = [];
  readonly tokens = new Set<string>([BOT_TOKEN]);
  bot: typeof BOT = { ...BOT };
  private readonly scripted = new Map<string, FakeReply[]>();

  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeTelegram> {
    let fake: FakeTelegram | null = null;
    const server = createServer((req, res) => {
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

  reset(): void {
    this.calls.length = 0;
    this.updates = [];
    this.scripted.clear();
    this.tokens.clear();
    this.tokens.add(BOT_TOKEN);
    this.bot = { ...BOT };
  }

  sent(): FakeCall[] {
    return this.calls.filter((c) => c.method === 'sendMessage');
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
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
