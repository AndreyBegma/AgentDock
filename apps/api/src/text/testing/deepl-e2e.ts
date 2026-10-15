import { DEEPL_PLACEHOLDER_TAG } from '@agentdock/shared';

/** Not a real key: no suite ever reaches DeepL. A free one, so the host is `api-free`. */
export const FAKE_DEEPL_KEY = 'e2e-fake-deepl-key-4f1c:fx';

export const DEEPL_FAKE_URL = 'https://api-free.deepl.com/v2/translate';

export interface FakeTranslation {
  text: string;
  /** Default `RU`. */
  lang?: string;
}

/**
 * What the fake answers a call with: one translation per text, a status, or
 * `hang` — no answer until the call's signal aborts.
 */
export type FakeDeepLReply = FakeTranslation[] | { status: number } | 'hang';

export interface FakeDeepLCall {
  texts: string[];
  /** The request's `Authorization` header. */
  authorization: string | null;
  body: Record<string, unknown>;
}

/**
 * DeepL, faked at `fetch` (#324): the API's real `DeepLClient` runs, and only
 * calls to the DeepL host are answered here — anything else goes to the real
 * `fetch`. `reply` decides each answer; by default it translates with
 * `dictionary`, keeping placeholder tags where they were.
 */
export class FakeDeepL {
  calls: FakeDeepLCall[] = [];
  /** Russian → English, applied to every text the fake translates. */
  dictionary = new Map<string, string>();
  reply: (texts: string[]) => FakeDeepLReply = (texts) =>
    texts.map((text) => ({ text: this.translate(text) }));
  private spy: jest.SpyInstance | undefined;

  install(): void {
    const real = globalThis.fetch.bind(globalThis);
    this.spy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (!url.startsWith('https://api-free.deepl.com/')) {
          return real(input, init);
        }
        return this.answer(init);
      });
  }

  uninstall(): void {
    this.spy?.mockRestore();
  }

  reset(): void {
    this.calls = [];
    this.dictionary.clear();
    this.reply = (texts) =>
      texts.map((text) => ({ text: this.translate(text) }));
  }

  /** Each dictionary entry replaced, longest first; tags untouched. */
  translate(text: string): string {
    let out = text;
    const entries = [...this.dictionary].sort(
      ([a], [b]) => b.length - a.length,
    );
    for (const [from, to] of entries) out = out.split(from).join(to);
    return out;
  }

  private async answer(init: RequestInit | undefined): Promise<Response> {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    const texts = (body.text as string[]) ?? [];
    const headers = new Headers(init?.headers);
    this.calls.push({
      texts,
      authorization: headers.get('Authorization'),
      body,
    });
    const reply = this.reply(texts);
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () =>
          reject(new DOMException('The operation timed out.', 'TimeoutError'));
        if (signal?.aborted) abort();
        signal?.addEventListener('abort', abort);
      });
    }
    if (!Array.isArray(reply)) {
      return new Response(JSON.stringify({ message: 'fake' }), {
        status: reply.status,
      });
    }
    return new Response(
      JSON.stringify({
        translations: reply.map((t) => ({
          text: t.text,
          detected_source_language: t.lang ?? 'RU',
          billed_characters: t.text.length,
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

/** A placeholder tag, as the API sends it. */
export const tag = (n: number): string =>
  `<${DEEPL_PLACEHOLDER_TAG} i="${n}"/>`;
