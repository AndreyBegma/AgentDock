import {
  SpeechToText,
  SpeechToTextError,
  type SpeechToTextOptions,
  speechToTextOptionsFromEnv,
} from './speech-to-text';

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);

const serviceWith = (
  answer: () => Promise<Response>,
  overrides: Partial<SpeechToTextOptions> = {},
) => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const speech = new SpeechToText({
    url: 'https://stt.test/v1',
    apiKey: 'key',
    model: 'whisper-1',
    fetch: (input, init) => {
      requests.push({ url: String(input), init });
      return answer();
    },
    ...overrides,
  });
  return { speech, requests };
};

describe('speechToTextOptionsFromEnv (#594)', () => {
  it('is off without a URL, and defaults the model', () => {
    expect(speechToTextOptionsFromEnv({})).toMatchObject({
      url: null,
      apiKey: null,
      model: 'whisper-1',
    });
    expect(
      speechToTextOptionsFromEnv({
        SPEECH_TO_TEXT_URL: ' https://api.example.com/v1/ ',
        SPEECH_TO_TEXT_API_KEY: 'k',
        SPEECH_TO_TEXT_MODEL: 'large-v3',
      }),
    ).toMatchObject({
      url: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'large-v3',
    });
  });
});

describe('SpeechToText (#594)', () => {
  it('posts the audio to /audio/transcriptions and returns the trimmed text', async () => {
    const { speech, requests } = serviceWith(async () =>
      Response.json({ text: '  Hello there  ' }),
    );
    expect(speech.enabled).toBe(true);
    await expect(
      speech.transcribe(AUDIO, 'voice.ogg', 'audio/ogg'),
    ).resolves.toBe('Hello there');
    const [request] = requests;
    expect(request?.url).toBe('https://stt.test/v1/audio/transcriptions');
    expect(new Headers(request?.init?.headers).get('authorization')).toBe(
      'Bearer key',
    );
    const form = request?.init?.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('json');
    expect((form.get('file') as File).name).toBe('voice.ogg');
  });

  it('sends no authorization without a key', async () => {
    const { speech, requests } = serviceWith(
      async () => Response.json({ text: 'ok' }),
      { apiKey: null },
    );
    await speech.transcribe(AUDIO, 'voice.ogg', 'audio/ogg');
    expect(new Headers(requests[0]?.init?.headers).has('authorization')).toBe(
      false,
    );
  });

  it('is off without a URL', async () => {
    const { speech, requests } = serviceWith(
      async () => Response.json({ text: 'x' }),
      { url: null },
    );
    expect(speech.enabled).toBe(false);
    await expect(
      speech.transcribe(AUDIO, 'voice.ogg', 'audio/ogg'),
    ).rejects.toBeInstanceOf(SpeechToTextError);
    expect(requests).toEqual([]);
  });

  it('fails in fixed words on an error status, a body without text, or no answer', async () => {
    const failing = [
      async () => new Response('key sk-secret is invalid', { status: 401 }),
      async () => Response.json({ error: 'x' }),
      async (): Promise<Response> => {
        throw new Error('connect ECONNREFUSED https://stt.test/?key=sk-secret');
      },
    ];
    for (const answer of failing) {
      const { speech } = serviceWith(answer);
      const error = await speech
        .transcribe(AUDIO, 'voice.ogg', 'audio/ogg')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SpeechToTextError);
      expect((error as Error).message).not.toContain('sk-secret');
    }
  });
});
