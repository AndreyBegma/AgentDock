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
  runnerTokenSchema,
  runtimeProfileSchema,
} from '@agentdock/shared/protocol';
import { z } from 'zod';

const portSchema = z.number().int().min(1).max(65_535);

/** A profile as stored: `authenticated` is a machine fact, re-detected, never stored. */
export const configProfileSchema = runtimeProfileSchema.omit({
  authenticated: true,
});
export type ConfigProfile = z.infer<typeof configProfileSchema>;

/** `~/.config/agentdock/runner.json` (D3). Unpaired until `pair` fills the first three. */
export const runnerConfigSchema = z.object({
  /** API origin, `http(s)://host[:port]`. */
  server: z.url({ protocol: /^https?$/ }).optional(),
  runnerId: z.string().min(1).optional(),
  token: runnerTokenSchema.optional(),
  profiles: z.array(configProfileSchema).default([]),
  projects: z
    .array(z.object({ id: z.string().min(1), root: z.string().min(1) }))
    .default([]),
  disabledCommands: z.array(z.string().min(1)).default([]),
  /** OTLP receiver ports (reserved until collectors land). */
  otlp: z
    .object({ grpc: portSchema.nullable(), http: portSchema.nullable() })
    .nullable()
    .default(null),
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

/** Writes the config atomically with mode 0600: temp file, fsync, rename. */
export const saveConfig = (
  path: string,
  config: z.input<typeof runnerConfigSchema>,
): void => {
  const valid = runnerConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(valid, null, 2)}\n`);
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
