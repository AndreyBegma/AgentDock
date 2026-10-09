import { basename, dirname, join } from 'node:path';
import type {
  OrchestratorPermissionMode,
  SkillRunArgs,
} from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../../config';
import { OTLP_HOST } from '../../otlp/receiver';
import type { LaunchSpec } from './record';

/** The Claude CLI's `--permission-mode` value for each protocol mode (as spec 17 D3). */
const CLI_PERMISSION_MODE: Record<OrchestratorPermissionMode, string> = {
  auto: 'auto',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
  manual: 'default',
};

/** D7: `<parent>/.wt-<repo>-run-<shortid>`, beside the main checkout. */
export const runWorktreePath = (root: string, shortId: string): string => {
  const trimmed = root.replace(/\/+$/, '');
  return join(dirname(trimmed), `.wt-${basename(trimmed)}-run-${shortId}`);
};

/** D8: the one prompt, `/<skill> <args>` — a single argv element. */
export const skillPrompt = (skill: string, args: string): string =>
  args.trim() ? `/${skill} ${args.trim()}` : `/${skill}`;

/** D7: the profile's binary and args, then the headless flags. */
export const runArgv = (
  profile: ConfigProfile,
  args: Pick<SkillRunArgs, 'skill' | 'args' | 'model' | 'permissionMode'>,
): { binary: string; args: string[] } => ({
  binary: profile.binary ?? profile.runtime,
  args: [
    ...profile.args,
    '-p',
    skillPrompt(args.skill, args.args),
    '--model',
    args.model,
    '--permission-mode',
    CLI_PERMISSION_MODE[args.permissionMode],
    '--output-format',
    'stream-json',
    '--verbose',
  ],
});

/** A W3C resource attribute value: anything outside the safe set is %-encoded. */
const attribute = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, (c) => encodeURIComponent(c));

/**
 * D9: the profile's env, the run's resource attributes and — when the
 * runner's OTLP receiver listens — telemetry pointed at it.
 */
export const runEnv = (
  profile: ConfigProfile,
  args: Pick<SkillRunArgs, 'projectId' | 'runId'>,
  otlpPort: number | null,
): Record<string, string> => ({
  ...profile.env,
  OTEL_RESOURCE_ATTRIBUTES: `agentdock.project=${attribute(args.projectId)},agentdock.run=${attribute(args.runId)}`,
  ...(otlpPort
    ? {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${OTLP_HOST}:${otlpPort}`,
      }
    : {}),
});

export const launchSpec = (
  profile: ConfigProfile,
  args: SkillRunArgs,
  worktree: string,
  otlpPort: number | null,
): LaunchSpec => ({
  ...runArgv(profile, args),
  env: runEnv(profile, args, otlpPort),
  cwd: worktree,
});
