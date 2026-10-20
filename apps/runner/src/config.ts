import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  profileConfigEnvSchema,
  runnerTokenSchema,
  runtimeProfileSchema,
  SKILL_RUN_MAX_TIMEOUT_SEC,
  SKILL_RUN_MIN_TIMEOUT_SEC,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { policyConfigSchema } from './policy/schema';

/** D11: skill runs per runner before the next one queues. */
export const SKILL_RUNS_DEFAULT_MAX_CONCURRENT = 2;

/** Spec 19 D1: `queue.pollSeconds` defaults to 60 and is never below 15. */
export const QUEUE_POLL_DEFAULT_SECONDS = 60;
export const QUEUE_POLL_MIN_SECONDS = 15;

const portSchema = z.number().int().min(1).max(65_535);

/**
 * A profile as stored: `authenticated` is a machine fact, re-detected, never
 * stored. The env holds values here; they are reported names-only (C-123).
 */
export const configProfileSchema = runtimeProfileSchema
  .omit({ authenticated: true })
  .extend({ env: profileConfigEnvSchema });
export type ConfigProfile = z.infer<typeof configProfileSchema>;

/** `~/.config/agentdock/runner.json` (D3). Unpaired until `pair` fills the first three. */
export const runnerConfigSchema = z.object({
  /** API origin, `http(s)://host[:port]`. */
  server: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * Set only by `pair --insecure`: `server` may be plain http to a host that
   * is not loopback (D-06). Never written by the daemon or from a server message.
   */
  insecureServer: z.boolean().optional(),
  /**
   * Cloudflare Access service token (D-07), set by `pair --access-client-id`.
   * Sent on the pairing request and every WebSocket connect; the secret is
   * never printed or logged.
   */
  accessClientId: z.string().min(1).optional(),
  accessClientSecret: z.string().min(1).optional(),
  runnerId: z.string().min(1).optional(),
  token: runnerTokenSchema.optional(),
  profiles: z.array(configProfileSchema).default([]),
  projects: z
    .array(z.object({ id: z.string().min(1), root: z.string().min(1) }))
    .default([]),
  disabledCommands: z.array(z.string().min(1)).default([]),
  /**
   * The OTLP receiver (spec 13 D11). `null`, the default, is the receiver on
   * 127.0.0.1:4318. `http: null` is the default port; `grpc` is not served
   * (D11) and stays reserved. `codexExperimental` maps Codex records, whose
   * attribute names are not verified yet (D13).
   */
  otlp: z
    .object({
      enabled: z.boolean().optional(),
      grpc: portSchema.nullable().default(null),
      http: portSchema.nullable().default(null),
      codexExperimental: z.boolean().optional(),
    })
    .nullable()
    .default(null),
  /** Fleet collector intervals (spec 11), for every watched project. */
  fleet: z
    .object({
      pollSeconds: z.number().int().min(5).max(3600).default(15),
      prPollSeconds: z.number().int().min(15).max(3600).default(60),
      /** `events.jsonl` poll fallback beside `fs.watch` (spec 16 D2). */
      eventsPollSeconds: z.number().int().min(1).max(3600).default(5),
    })
    .default({ pollSeconds: 15, prPollSeconds: 60, eventsPollSeconds: 5 }),
  /** The task queue (spec 19): how often the `issues` collector polls GitHub. */
  queue: z
    .object({
      pollSeconds: z
        .number()
        .int()
        .min(QUEUE_POLL_MIN_SECONDS)
        .max(3600)
        .default(QUEUE_POLL_DEFAULT_SECONDS),
    })
    .prefault({}),
  /**
   * Agent sessions (spec 12). `ingestSince`: transcripts last modified before
   * it are not read unless a backfill asks; `pair` sets it (D11).
   */
  sessions: z
    .object({
      enabled: z.boolean().default(true),
      ingestSince: z.iso.datetime().optional(),
    })
    .prefault({}),
  /**
   * Skill runs (spec 24 D11). A run over `maxConcurrentRuns` waits in
   * `queued`; a `timeoutSec` above `maxTimeoutSec` is cut to it. The catalog
   * host is not configurable: it is fixed in the runner (D1).
   * `keepPatchesLocal` (C-128, D-15): the patch stays in the run's directory
   * and `skill_run.finished` carries only the file list and the patch's
   * SHA-256. Set by hand in `runner.json`; the daemon never rewrites it.
   */
  skills: z
    .object({
      maxConcurrentRuns: z
        .number()
        .int()
        .min(1)
        .max(32)
        .default(SKILL_RUNS_DEFAULT_MAX_CONCURRENT),
      maxTimeoutSec: z
        .number()
        .int()
        .min(SKILL_RUN_MIN_TIMEOUT_SEC)
        .max(SKILL_RUN_MAX_TIMEOUT_SEC)
        .default(SKILL_RUN_MAX_TIMEOUT_SEC),
      keepPatchesLocal: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * The runner-local security policy (ADR-0047). Written only by
   * `agentdock-runner policy …` and `pair --allow-root`; the daemon reads it
   * and keeps it as it is when it rewrites the file (`updateConfig`).
   */
  policy: policyConfigSchema,
});
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export interface PairedConfig extends RunnerConfig {
  server: string;
  runnerId: string;
  token: string;
}

export const isPaired = (config: RunnerConfig): config is PairedConfig =>
  config.server !== undefined &&
  config.runnerId !== undefined &&
  config.token !== undefined;

export class ConfigError extends Error {}

/** Reads the config; a missing file is an empty, unpaired config. */
export const loadConfig = (path: string): RunnerConfig => {
  if (!existsSync(path)) return runnerConfigSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const parsed = runnerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Name the fields only: an echoed value could be the token.
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new ConfigError(
      `${path} is invalid at: ${[...new Set(fields)].join(', ')}`,
    );
  }
  return parsed.data;
};

/**
 * Whether the file holds a `policy` block. A runner before 0.13 wrote none
 * (#691): it parses to the default policy, which allows no project root. A
 * missing or unreadable file counts as having one — it is no upgrade.
 */
export const hasPolicyBlock = (path: string): boolean => {
  if (!existsSync(path)) return true;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof raw !== 'object' || raw === null || 'policy' in raw;
  } catch {
    return true;
  }
};

/**
 * Writes the config atomically with mode 0600: temp file, fsync, rename.
 * `withoutPolicy` leaves the `policy` block out of the file.
 */
export const saveConfig = (
  path: string,
  config: z.input<typeof runnerConfigSchema>,
  options: { withoutPolicy?: boolean } = {},
): void => {
  const valid = runnerConfigSchema.parse(config);
  const { policy: _policy, ...unpoliced } = valid;
  const body = options.withoutPolicy ? unpoliced : valid;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/**
 * What the daemon may rewrite in the file: never the policy (ADR-0047),
 * `insecureServer` (D-06) or the skill-run settings (C-128).
 */
export type DaemonConfigPatch = Partial<
  Omit<
    z.input<typeof runnerConfigSchema>,
    'policy' | 'insecureServer' | 'skills'
  >
>;

/**
 * The daemon's one way to rewrite `runner.json`: re-reads the file and
 * applies `patch` on top, so the policy on disk — whatever the CLI last
 * wrote — is kept as is. A file with no `policy` block keeps none (#691):
 * the daemon does not write the default policy for the person, so the
 * upgrade notice shows on every start until they set one.
 */
export const updateConfig = (path: string, patch: DaemonConfigPatch): void => {
  const {
    policy: _policy,
    insecureServer: _insecure,
    skills: _skills,
    ...safe
  } = patch as DaemonConfigPatch & {
    policy?: unknown;
    insecureServer?: unknown;
    skills?: unknown;
  };
  saveConfig(
    path,
    { ...loadConfig(path), ...safe },
    { withoutPolicy: !hasPolicyBlock(path) },
  );
};
