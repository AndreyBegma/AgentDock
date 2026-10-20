import {
  DEEPL_TARGET_LANG,
  type DeepLAnswer,
  type DeepLError,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** What one `POST /v2/translate` answered (#324 D4, D8). */
export interface DeepLTranslation {
  answers: DeepLAnswer[];
  /** DeepL's `billed_characters`, else the characters sent. */
  billedChars: number;
}

/**
 * A failed call. The message names the status at most — never the key, never
 * the text.
 */
export class DeepLFailure extends Error {
  constructor(
    readonly kind: DeepLError,
    message: string,
  ) {
    super(message);
  }
}

interface TranslateResponse {
  translations?: {
    text?: unknown;
    detected_source_language?: unknown;
    billed_characters?: unknown;
  }[];
}

const errorOf = (status: number): DeepLError => {
  if (status === 456) return 'quota';
  if (status === 403) return 'auth';
  if (status === 429) return 'rate';
  return 'unavailable';
};

const isAbort = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' || error.name === 'TimeoutError');

/**
 * DeepL (issue #324, ADR-0033): translates stored text when `DEEPL_API_KEY`
 * is set. The key is read from the API's environment only, and leaves this
 * class only in the `Authorization` header of a call to DeepL (D9).
 */
@Injectable()
export class DeepLClient {
  private readonly key: string;

  constructor(config: ConfigService) {
    this.key = config.get<string>('DEEPL_API_KEY')?.trim() ?? '';
  }

  /** D3: without a key, the runner path of ADR-0027 alone. */
  get enabled(): boolean {
    return this.key !== '';
  }

  /** D4: a free key ends in `:fx`. */
  get url(): string {
    const host = this.key.endsWith(':fx')
      ? 'api-free.deepl.com'
      : 'api.deepl.com';
    return `https://${host}/v2/translate`;
  }

  /**
   * D4: one call for every field of a save, each its own `text` entry, in
   * XML with the placeholder tags ignored. Throws `DeepLFailure`.
   */
  async translate(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<DeepLTranslation> {
    if (!this.enabled) throw new DeepLFailure('auth', 'no DEEPL_API_KEY');
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${this.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: texts,
          target_lang: DEEPL_TARGET_LANG,
          tag_handling: 'xml',
          ignore_tags: ['x'],
          preserve_formatting: true,
          outline_detection: false,
          split_sentences: 'nonewlines',
          show_billed_characters: true,
        }),
        signal,
      });
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        throw new DeepLFailure('timeout', 'deepl: no answer in time');
      }
      throw new DeepLFailure('unavailable', 'deepl: network error');
    }
    if (!response.ok) {
      // The body is not read: it is DeepL's to word, and not needed.
      await response.body?.cancel().catch(() => undefined);
      throw new DeepLFailure(
        errorOf(response.status),
        `deepl: HTTP ${response.status}`,
      );
    }
    let json: TranslateResponse;
    try {
      json = (await response.json()) as TranslateResponse;
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        throw new DeepLFailure('timeout', 'deepl: no answer in time');
      }
      throw new DeepLFailure('unavailable', 'deepl: invalid answer');
    }
    const translations = json.translations;
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      throw new DeepLFailure('unavailable', 'deepl: invalid answer');
    }
    let billed = 0;
    let billedAll = true;
    const answers = translations.map((t): DeepLAnswer => {
      if (typeof t.billed_characters === 'number') {
        billed += t.billed_characters;
      } else {
        billedAll = false;
      }
      return {
        text: typeof t.text === 'string' ? t.text : '',
        detectedSourceLanguage:
          typeof t.detected_source_language === 'string'
            ? t.detected_source_language
            : '',
      };
    });
    return {
      answers,
      billedChars: billedAll
        ? billed
        : texts.reduce((sum, text) => sum + text.length, 0),
    };
  }
}
