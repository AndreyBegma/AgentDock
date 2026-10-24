import {
  DEMO_ERROR,
  DEMO_SECRET_VALUE_MAX,
  DEMO_UPLOAD_HEADERS,
  demoSecretNameSchema,
  runnerDemoEnvPath,
  runnerDemoVideoPath,
} from '@nautelle/shared';
import { z } from 'zod';
import { errorMessage } from '../log';
import { normalizeServer } from '../server-url';

/** Where and as whom the runner reads a demo's secrets and uploads its video. */
export interface DemoApiSource {
  /** The API origin the runner is paired with. */
  server: string;
  insecureServer?: boolean;
  /** The runner's own token — sent only to `server`. */
  token: string;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

export const DEMO_ENV_TIMEOUT_MS = 30_000;
export const DEMO_UPLOAD_TIMEOUT_MS = 5 * 60_000;
/** Tries of one upload: the first and two retries. */
export const DEMO_UPLOAD_ATTEMPTS = 3;
/** The wait before each retry. */
export const DEMO_UPLOAD_BACKOFF_MS = [2_000, 10_000] as const;

const runnerEnvSchema = z.object({
  env: z.record(demoSecretNameSchema, z.string().max(DEMO_SECRET_VALUE_MAX)),
});

/** What the API said, without the body: it is ours, but kept short anyway. */
const errorCode = async (response: Response): Promise<string | null> => {
  try {
    const body: unknown = await response.json();
    const code =
      body && typeof body === 'object' && 'error' in body ? body.error : null;
    return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
};

const described = async (response: Response): Promise<string> => {
  const code = await errorCode(response);
  return `HTTP ${response.status}${code ? ` ${code}` : ''}`;
};

export class DemoApiError extends Error {
  constructor(
    message: string,
    /** The demo is no longer queued or recording: nothing to report. */
    readonly notActive = false,
  ) {
    super(message);
  }
}

const call = (
  source: DemoApiSource,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> =>
  (source.fetch ?? fetch)(
    `${normalizeServer(source.server, source.insecureServer)}${path}`,
    {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${source.token}`,
      },
      // The token must never follow a redirect to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

/**
 * The values of `names`, read from the API over HTTPS. They go to the
 * `demoflow` process environment and nowhere else: not to disk, not to a log.
 * A name the project no longer has is left out — DemoFlow then reports it as
 * missing, by name.
 */
export const fetchDemoEnv = async (
  source: DemoApiSource,
  card: number,
  demoId: string,
  names: readonly string[],
): Promise<Record<string, string>> => {
  if (names.length === 0) return {};
  let response: Response;
  try {
    response = await call(
      source,
      runnerDemoEnvPath(card, demoId),
      { method: 'GET' },
      DEMO_ENV_TIMEOUT_MS,
    );
  } catch (error) {
    throw new DemoApiError(
      `the demo's secrets could not be fetched: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    const code = await errorCode(response);
    throw new DemoApiError(
      `the demo's secrets could not be fetched: HTTP ${response.status}${code ? ` ${code}` : ''}`,
      response.status === 409 && code === DEMO_ERROR.notActive,
    );
  }
  let parsed: z.infer<typeof runnerEnvSchema>;
  try {
    parsed = runnerEnvSchema.parse(await response.json());
  } catch {
    throw new DemoApiError(
      "the API's answer with the demo's secrets is invalid",
    );
  }
  return Object.fromEntries(
    names.flatMap((name) =>
      Object.hasOwn(parsed.env, name) ? [[name, parsed.env[name]]] : [],
    ),
  );
};

export interface DemoVideo {
  bytes: Uint8Array;
  sha256: string;
  durationMs: number | null;
}

export interface UploadOptions {
  /** Waits between tries; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const retryable = (status: number): boolean =>
  status === 429 || status === 408 || status >= 500;

/**
 * Uploads the video (`runnerDemoVideoPath`), which makes the demo ready. A
 * network error, a 408, a 429 or a 5xx is tried again, up to
 * `DEMO_UPLOAD_ATTEMPTS` times; any other refusal is final.
 */
export const uploadDemoVideo = async (
  source: DemoApiSource,
  card: number,
  demoId: string,
  video: DemoVideo,
  options: UploadOptions = {},
): Promise<void> => {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let last = '';
  for (let attempt = 0; attempt < DEMO_UPLOAD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(DEMO_UPLOAD_BACKOFF_MS[attempt - 1] ?? 0);
    let response: Response;
    try {
      response = await call(
        source,
        runnerDemoVideoPath(card, demoId),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'video/mp4',
            [DEMO_UPLOAD_HEADERS.sha256]: video.sha256,
            ...(video.durationMs !== null
              ? { [DEMO_UPLOAD_HEADERS.durationMs]: String(video.durationMs) }
              : {}),
          },
          body: video.bytes,
        },
        DEMO_UPLOAD_TIMEOUT_MS,
      );
    } catch (error) {
      last = errorMessage(error);
      continue;
    }
    if (response.ok) return;
    if (!retryable(response.status)) {
      const code = await errorCode(response);
      throw new DemoApiError(
        `the API refused the video: HTTP ${response.status}${code ? ` ${code}` : ''}`,
        response.status === 409 && code === DEMO_ERROR.notActive,
      );
    }
    last = await described(response);
  }
  throw new DemoApiError(
    `the video upload failed after ${DEMO_UPLOAD_ATTEMPTS} tries: ${last}`,
  );
};
