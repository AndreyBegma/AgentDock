import { z } from 'zod';
import { cardLabel, cardSlug } from '../board/naming';

/**
 * Demo videos of finished cards (C-368, ADR-0090). DemoFlow records a short
 * video of a UI card on the project's runner; the video is a card attachment
 * and a `card_demos` row tracks each recording. A failed demo never blocks
 * Finished or a merge — it is a warning with its reason.
 *
 * Browser routes are under `/projects/:projectId`, behind the project guard;
 * the runner uploads the video and reads the demo's secrets with its runner
 * token.
 */

/** `card_demos.status`. `queued` and `recording` are a recording in flight. */
export const DEMO_STATUSES = [
  'queued',
  'recording',
  'ready',
  'failed',
  'skipped',
] as const;
export type DemoStatus = (typeof DEMO_STATUSES)[number];
export const demoStatusSchema = z.enum(DEMO_STATUSES);

/** A demo the runner may still record, upload, or read secrets for. */
export const DEMO_ACTIVE_STATUSES = [
  'queued',
  'recording',
] as const satisfies readonly DemoStatus[];
export const isDemoActive = (status: DemoStatus): boolean =>
  (DEMO_ACTIVE_STATUSES as readonly DemoStatus[]).includes(status);

/**
 * `card_demos.trigger`: `auto` after the card's checks (and review) turned
 * green, `manual` from "Record again".
 */
export const DEMO_TRIGGERS = ['auto', 'manual'] as const;
export type DemoTrigger = (typeof DEMO_TRIGGERS)[number];

/**
 * `board_settings.demoUiPaths` of a new project: the globs that make a card a
 * UI card — one whose branch changes a file matching any of them.
 */
export const DEMO_UI_PATHS_DEFAULT: readonly string[] = [
  'apps/web/**',
  '**/*.tsx',
  '**/*.css',
];
export const DEMO_UI_PATHS_MAX = 32;
export const DEMO_UI_PATH_MAX_LENGTH = 200;

/**
 * A Demo env secret's name: an environment variable name, as DemoFlow's
 * `valueFrom.env` reads it.
 */
export const DEMO_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const DEMO_SECRET_NAME_MAX = 64;
/** Characters of one secret's value. */
export const DEMO_SECRET_VALUE_MAX = 4096;
/** Secrets of one project. */
export const DEMO_SECRETS_MAX = 32;

export const demoSecretNameSchema = z
  .string()
  .max(DEMO_SECRET_NAME_MAX)
  .regex(DEMO_SECRET_NAME_PATTERN, 'must match ^[A-Z_][A-Z0-9_]*$');

/** `card_demos.reason`: why a demo failed or was skipped, without a stack trace. */
export const DEMO_REASON_MAX = 500;

/** Where card workers commit their DemoFlow scenarios, repository-relative. */
export const DEMO_SCENARIO_DIR = 'demoflow/cards';

/** `demoflow/cards/C-<n>-<slug>.demo.json`, repository-relative. */
export const demoScenarioPath = (card: {
  number: number;
  title: string;
}): string =>
  `${DEMO_SCENARIO_DIR}/${cardLabel(card.number)}-${cardSlug(card.title)}.demo.json`;

export const demoScenarioPathSchema = z
  .string()
  .max(200)
  .regex(
    /^demoflow\/cards\/C-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*\.demo\.json$/,
    'must be demoflow/cards/C-<n>-<slug>.demo.json',
  );

/** `card_demos.id`: a cuid, a plain token, never a path. */
export const demoIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must match ^[A-Za-z0-9_-]{1,64}$');

/** `GET /projects/:projectId/demos/settings`. */
export interface DemoSettingsView {
  enabled: boolean;
  uiPaths: string[];
  /** Send a ready demo to the project's Telegram chat. */
  telegram: boolean;
}

/** `PATCH /projects/:projectId/demos/settings` (admin); absent keeps a field. */
export interface UpdateDemoSettingsRequest {
  enabled?: boolean;
  uiPaths?: string[];
  telegram?: boolean;
}

/**
 * One Demo env secret, as every route returns it: the name only. A value is
 * write-only — it never comes back to the web app.
 */
export interface DemoSecretView {
  name: string;
  updatedAt: string;
  /** `null` once the user is deleted. */
  updatedByName: string | null;
}

/** `PUT /projects/:projectId/demos/secrets/:name` (admin). */
export interface PutDemoSecretRequest {
  value: string;
}

/** One recording of a card, newest first in `GET …/cards/:number/demos`. */
export interface CardDemoView {
  id: string;
  round: number;
  status: DemoStatus;
  trigger: DemoTrigger;
  /** With `failed` and `skipped`. */
  reason: string | null;
  scenarioPath: string | null;
  /** The video (`ready` only); its bytes are at the attachment's `contentUrl`. */
  attachmentId: string | null;
  contentUrl: string | null;
  durationMs: number | null;
  /** Bytes of the video. */
  size: number | null;
  /** `manual` only; `null` once the user is deleted. */
  requestedByName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * `BoardCardView.demo` (C-371): the card's newest recording, for the board
 * tile's chip. `null` while the card has none.
 */
export interface CardDemoBrief {
  status: DemoStatus;
  durationMs: number | null;
}

/**
 * `GET /projects/:projectId/demos/runner` (C-371): what the project's runner
 * reports about recording. `demoflow` is its pinned DemoFlow, `null` for a
 * runner that never reported one; `supported` is `capabilities.cardDemo`.
 */
export interface DemoRunnerView {
  supported: boolean;
  demoflow: { version: string; ready: boolean; reason: string | null } | null;
}

/** Stable codes in the `error` field of a demo route's error body. */
export const DEMO_ERROR = {
  notFound: 'not_found',
  /** 409: demo videos are off for the project. */
  disabled: 'demos_disabled',
  /** 409: the card already has a demo queued or recording. */
  inFlight: 'demo_in_flight',
  /** 409: the demo is no longer queued or recording. */
  notActive: 'demo_not_active',
  /** 409: the card has never run, so there is nothing to record. */
  noRound: 'no_round',
  /** 409: `APP_ENCRYPTION_KEY` is not set, so a secret cannot be stored. */
  encryptionUnavailable: 'encryption_unavailable',
  /** 422: over `DEMO_SECRETS_MAX`. */
  tooManySecrets: 'too_many_secrets',
  /** 422: the upload's size or SHA-256 does not match its headers. */
  integrity: 'integrity_mismatch',
} as const;
export type DemoErrorCode = (typeof DEMO_ERROR)[keyof typeof DEMO_ERROR];

export interface DemoErrorBody {
  statusCode: number;
  error: DemoErrorCode;
  message: string;
}

/**
 * Headers of the runner's video upload. The body is the raw video bytes, sent
 * with `Content-Type: video/mp4` or `video/webm`; the type is still taken from
 * the bytes, never from the header.
 */
export const DEMO_UPLOAD_HEADERS = {
  /** Lower-case hex SHA-256 of the body. */
  sha256: 'x-demo-sha256',
  /** The video's length in milliseconds. */
  durationMs: 'x-demo-duration-ms',
} as const;

/**
 * `POST` the video here with `Authorization: Bearer <runner token>`, only for
 * a demo of a project the runner owns, while it is queued or recording.
 */
export const runnerDemoVideoPath = (
  cardNumber: number,
  demoId: string,
): string =>
  `/runner/cards/${cardNumber}/demos/${encodeURIComponent(demoId)}/video`;

/**
 * `GET` the demo's secrets here (`RunnerDemoEnvView`), with the runner token,
 * while the demo is queued or recording. They are never in a socket payload.
 */
export const runnerDemoEnvPath = (cardNumber: number, demoId: string): string =>
  `/runner/cards/${cardNumber}/demos/${encodeURIComponent(demoId)}/env`;

/** The runner hands these to the `demoflow` process environment, never to a file. */
export interface RunnerDemoEnvView {
  env: Record<string, string>;
}
