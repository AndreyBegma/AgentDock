import type {
  AdminRunner,
  AdminRunnerEvent,
  AdminRuntimeProfile,
  RunnerStatus,
} from '@agentdock/shared';
import type { EventSource } from '@agentdock/shared/protocol';
import type { Event, Runner, RuntimeProfile } from '@prisma/client';

// Explicit field lists: tokenHash / tokenPrefix never leak by default.
export const toAdminRunner = (
  runner: Runner,
  status: RunnerStatus,
  profilesCount: number,
): AdminRunner => ({
  id: runner.id,
  name: runner.name,
  status,
  hostname: runner.hostname,
  version: runner.version,
  protocolVersion: runner.protocolVersion,
  os: runner.os,
  arch: runner.arch,
  profilesCount,
  pairedAt: runner.pairedAt?.toISOString() ?? null,
  lastSeenAt: runner.lastSeenAt?.toISOString() ?? null,
  revokedAt: runner.revokedAt?.toISOString() ?? null,
  createdAt: runner.createdAt.toISOString(),
});

export const toAdminProfile = (
  profile: RuntimeProfile,
): AdminRuntimeProfile => ({
  id: profile.id,
  key: profile.key,
  runtime: profile.runtime,
  label: profile.label,
  binary: profile.binary,
  env: profile.env as Record<string, string>,
  args: profile.args as string[],
  authenticated: profile.authenticated,
  missing: profile.missing,
  updatedAt: profile.updatedAt.toISOString(),
});

export const toAdminEvent = (event: Event): AdminRunnerEvent => ({
  seq: Number(event.seq),
  ts: event.ts.toISOString(),
  type: event.type,
  source: event.source as EventSource,
  projectRepo: event.projectRepo,
  slot: event.slot,
  issue: event.issue,
  data: event.data,
  receivedAt: event.receivedAt.toISOString(),
});
