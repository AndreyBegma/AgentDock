import {
  REDACTED,
  redactToken,
  TelegramApiError,
  TelegramClient,
} from './telegram-client';
import type { TelegramOptions } from './telegram-options';

const TOKEN = '7012345678:AAE-very-secret-bot-token-value-xyz';

const clientWith = (
  answer: (url: string, init?: RequestInit) => Promise<Response>,
): { client: TelegramClient; urls: string[] } => {
  const urls: string[] = [];
  const options: TelegramOptions = {
    apiBase: 'https://telegram.test/',
    pollTimeoutS: 30,
    appUrl: null,
    autoStart: false,
    deliveryIntervalMs: 1_000,
    idleMs: 10,
    fetch: (input, init) => {
      urls.push(String(input));
      return answer(String(input), init);
    },
  };
  return { client: new TelegramClient(options), urls };
};

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const failureOf = async (call: Promise<unknown>): Promise<TelegramApiError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof TelegramApiError) return error;
    throw error;
  }
  throw new Error('expected a TelegramApiError');
};

describe('redactToken', () => {
  it('removes the token, its secret part, and anything token-shaped', () => {
    const secret = TOKEN.slice(TOKEN.indexOf(':') + 1);
    expect(redactToken(`a ${TOKEN} b`, TOKEN)).toBe(`a ${REDACTED} b`);
    expect(redactToken(`only ${secret}`, TOKEN)).toBe(`only ${REDACTED}`);
    expect(redactToken('/bot123456:abcdefghijklmnopqrstuvwxyz/getMe')).toBe(
      `/bot${REDACTED}/getMe`,
    );
    expect(redactToken('nothing secret here')).toBe('nothing secret here');
  });
});

describe('TelegramClient', () => {
  it('calls <base>/bot<token>/<method> with JSON', async () => {
    const { client, urls } = clientWith(() =>
      json(200, {
        ok: true,
        result: { id: 1, is_bot: true, username: 'agentdock_bot' },
      }),
    );
    expect(await client.getMe(TOKEN)).toEqual({
      id: 1,
      username: 'agentdock_bot',
    });
    expect(urls).toEqual([`https://telegram.test/bot${TOKEN}/getMe`]);
  });

  it('maps 401 to a rejected token, without the token in the message', async () => {
    const { client } = clientWith(() =>
      json(401, { ok: false, error_code: 401, description: 'Unauthorized' }),
    );
    const error = await failureOf(client.getMe(TOKEN));
    expect(error.tokenRejected).toBe(true);
    expect(error.permanent).toBe(false);
    expect(error.message).toBe('getMe: Unauthorized');
  });

  it('carries retry_after from a 429', async () => {
    const { client } = clientWith(() =>
      json(429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 12',
        parameters: { retry_after: 12 },
      }),
    );
    const error = await failureOf(client.sendMessage(TOKEN, 1n, 'x'));
    expect(error.status).toBe(429);
    expect(error.retryAfterS).toBe(12);
    expect(error.permanent).toBe(false);
  });

  it('treats 403 and 400 as permanent', async () => {
    for (const status of [400, 403]) {
      const { client } = clientWith(() =>
        json(status, { ok: false, error_code: status, description: 'no' }),
      );
      expect(
        (await failureOf(client.sendMessage(TOKEN, 1n, 'x'))).permanent,
      ).toBe(true);
    }
  });

  it('redacts a token Telegram echoes in a description', async () => {
    const { client } = clientWith(() =>
      json(500, {
        ok: false,
        error_code: 500,
        description: `failed for bot${TOKEN}`,
      }),
    );
    const error = await failureOf(client.getMe(TOKEN));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain(REDACTED);
  });

  it('reports a network failure in fixed words, never the URL', async () => {
    const { client } = clientWith(() =>
      Promise.reject(
        new TypeError(`fetch failed: https://telegram.test/bot${TOKEN}/getMe`, {
          cause: { code: 'ECONNREFUSED' },
        }),
      ),
    );
    const error = await failureOf(client.getMe(TOKEN));
    expect(error.kind).toBe('network');
    expect(error.message).toBe('Telegram API unreachable (ECONNREFUSED)');
    expect(error.status).toBeNull();
  });

  it('refuses a body that is not the Bot API envelope', async () => {
    const { client } = clientWith(() =>
      Promise.resolve(new Response('<html>', { status: 502 })),
    );
    const error = await failureOf(client.getMe(TOKEN));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).not.toContain(TOKEN);
  });

  it('sends MarkdownV2 unless told the text is plain', async () => {
    const bodies: unknown[] = [];
    const { client } = clientWith((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json(200, { ok: true, result: {} });
    });
    await client.sendMessage(TOKEN, 42n, 'a');
    await client.sendMessage(TOKEN, 42n, 'b', true);
    expect(bodies[0]).toMatchObject({
      chat_id: 42,
      text: 'a',
      parse_mode: 'MarkdownV2',
    });
    expect(bodies[1]).not.toHaveProperty('parse_mode');
  });

  it('keeps only well-formed updates', async () => {
    const { client } = clientWith(() =>
      json(200, {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 1,
              chat: { id: 5, type: 'private' },
              text: '/stop',
            },
          },
          { update_id: 2, edited_message: {} },
          { nope: true },
        ],
      }),
    );
    expect(await client.getUpdates(TOKEN, 0, 30)).toEqual([
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 5, type: 'private' },
          text: '/stop',
        },
      },
      { update_id: 2 },
    ]);
  });
});
