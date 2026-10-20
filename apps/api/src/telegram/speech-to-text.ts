import { PLANNER_QUESTION_MAX } from '@nautelle/shared';
import { Inject, Injectable } from '@nestjs/common';

/** How the bot reaches the speech-to-text service (#594); tests override it. */
export interface SpeechToTextOptions {
  /**
   * `SPEECH_TO_TEXT_URL` — the base of a Whisper-compatible API, which
   * answers `POST <base>/audio/transcriptions`. Null: voice input is off.
   */
  url: string | null;
  /** `SPEECH_TO_TEXT_API_KEY` — sent as a bearer token; null sends none. */
  apiKey: string | null;
  /** `SPEECH_TO_TEXT_MODEL` — the `model` field of the request. */
  model: string;
  /** The HTTP client; tests may inject one. */
  fetch: typeof fetch;
}

export const SPEECH_TO_TEXT_OPTIONS = Symbol('SPEECH_TO_TEXT_OPTIONS');

export const DEFAULT_SPEECH_TO_TEXT_MODEL = 'whisper-1';
/** A transcription gives up after this long. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** The transcript is cut to fit an answer of the intake's round. */
const TRANSCRIPT_MAX = PLANNER_QUESTION_MAX;

export const speechToTextOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): SpeechToTextOptions => ({
  url: env.SPEECH_TO_TEXT_URL?.trim().replace(/\/+$/, '') || null,
  apiKey: env.SPEECH_TO_TEXT_API_KEY?.trim() || null,
  model: env.SPEECH_TO_TEXT_MODEL?.trim() || DEFAULT_SPEECH_TO_TEXT_MODEL,
  fetch: (input, init) => fetch(input, init),
});

/**
 * A transcription that did not succeed. The message is fixed text with the
 * HTTP status at most: the service's own answer may quote the key.
 */
export class SpeechToTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechToTextError';
  }
}

/**
 * #594: voice input of the Telegram intake. Audio goes to a Whisper-compatible
 * `/audio/transcriptions` endpoint an admin configured, as multipart with
 * `response_format=json`, and the text comes back. The audio is sent and
 * forgotten — never stored.
 */
@Injectable()
export class SpeechToText {
  constructor(
    @Inject(SPEECH_TO_TEXT_OPTIONS)
    private readonly options: SpeechToTextOptions,
  ) {}

  get enabled(): boolean {
    return this.options.url !== null;
  }

  /** The words of `audio`, trimmed; empty when nothing was heard. */
  async transcribe(
    audio: Uint8Array,
    name: string,
    mime: string,
  ): Promise<string> {
    const { url, apiKey, model } = this.options;
    if (url === null) throw new SpeechToTextError('Voice input is off');
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), name);
    form.append('model', model);
    form.append('response_format', 'json');
    let response: Response;
    try {
      response = await this.options.fetch(`${url}/audio/transcriptions`, {
        method: 'POST',
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });
    } catch {
      throw new SpeechToTextError('The speech-to-text service is unreachable');
    }
    if (!response.ok) {
      throw new SpeechToTextError(
        `The speech-to-text service answered ${response.status}`,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    const text =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { text?: unknown }).text === 'string'
        ? (body as { text: string }).text
        : null;
    if (text === null) {
      throw new SpeechToTextError(
        'The speech-to-text service answered without text',
      );
    }
    return [...text.trim()].slice(0, TRANSCRIPT_MAX).join('').trim();
  }
}
