import { ConfigService } from '@nestjs/config';
import { DeepLClient, DeepLFailure } from './deepl-client';

/** Not a real key: tests never call DeepL. */
const FREE_KEY = 'unit-test-key:fx';

const client = (key?: string) =>
  new DeepLClient(
    new ConfigService(key === undefined ? {} : { DEEPL_API_KEY: key }),
  );

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('DeepLClient', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('is off without a key, or with a blank one', () => {
    const saved = process.env.DEEPL_API_KEY;
    delete process.env.DEEPL_API_KEY;
    try {
      expect(client().enabled).toBe(false);
      expect(client('  ').enabled).toBe(false);
      expect(client(FREE_KEY).enabled).toBe(true);
    } finally {
      if (saved !== undefined) process.env.DEEPL_API_KEY = saved;
    }
  });

  it('picks the free host for a :fx key, else the paid one', () => {
    expect(client(FREE_KEY).url).toBe(
      'https://api-free.deepl.com/v2/translate',
    );
    expect(client('paid-key').url).toBe('https://api.deepl.com/v2/translate');
  });

  it('sends one call with every text and the D4 parameters', async () => {
    fetchMock.mockResolvedValue(
      answer({
        translations: [
          {
            text: 'Add login',
            detected_source_language: 'RU',
            billed_characters: 13,
          },
          {
            text: 'Body',
            detected_source_language: 'RU',
            billed_characters: 4,
          },
        ],
      }),
    );
    const result = await client(FREE_KEY).translate(
      ['Добавить вход', 'Тело'],
      new AbortController().signal,
    );
    expect(result).toEqual({
      answers: [
        { text: 'Add login', detectedSourceLanguage: 'RU' },
        { text: 'Body', detectedSourceLanguage: 'RU' },
      ],
      billedChars: 17,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `DeepL-Auth-Key ${FREE_KEY}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      text: ['Добавить вход', 'Тело'],
      target_lang: 'EN-US',
      tag_handling: 'xml',
      ignore_tags: ['x'],
      preserve_formatting: true,
      outline_detection: false,
      split_sentences: 'nonewlines',
      show_billed_characters: true,
    });
  });

  it('counts the characters sent when DeepL bills none', async () => {
    fetchMock.mockResolvedValue(
      answer({
        translations: [{ text: 'Hi', detected_source_language: 'RU' }],
      }),
    );
    const result = await client(FREE_KEY).translate(
      ['Привет'],
      new AbortController().signal,
    );
    expect(result.billedChars).toBe(6);
  });

  it.each([
    [456, 'quota'],
    [403, 'auth'],
    [429, 'rate'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'unavailable'],
  ])('maps HTTP %i to %s, with no key in the message', async (status, kind) => {
    fetchMock.mockResolvedValue(answer({ message: FREE_KEY }, status));
    const failure = await client(FREE_KEY)
      .translate(['Привет'], new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeepLFailure);
    expect((failure as DeepLFailure).kind).toBe(kind);
    expect((failure as DeepLFailure).message).toBe(`deepl: HTTP ${status}`);
  });

  it('is unavailable on a network error or an answer it cannot use', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${FREE_KEY}`));
    fetchMock.mockResolvedValueOnce(answer({ translations: [] }));
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    for (let i = 0; i < 3; i += 1) {
      const failure = (await client(FREE_KEY)
        .translate(['Привет'], new AbortController().signal)
        .catch((error: unknown) => error)) as DeepLFailure;
      expect(failure.kind).toBe('unavailable');
      expect(failure.message).not.toContain(FREE_KEY);
    }
  });

  it('is a timeout when the signal aborts', async () => {
    fetchMock.mockImplementation(
      (_url, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'TimeoutError')),
          );
        }),
    );
    const failure = (await client(FREE_KEY)
      .translate(['Привет'], AbortSignal.timeout(20))
      .catch((error: unknown) => error)) as DeepLFailure;
    expect(failure.kind).toBe('timeout');
  });

  it('makes no call without a key', async () => {
    const failure = (await client('')
      .translate(['Привет'], new AbortController().signal)
      .catch((error: unknown) => error)) as DeepLFailure;
    expect(failure).toBeInstanceOf(DeepLFailure);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
