import type {
  AdminRunner,
  AdminRunnerEvent,
  AdminRuntimeProfile,
  RunnerStatus,
} from '@nautelle/shared';
import {
  type Capabilities,
  type EventSource,
  scrubProfileEnv,
} from '@nautelle/shared/protocol';
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
  // Spec 201 D8, D17.
  localUserId: runner.localUserId,
  awayMode: runner.awayMode,
});

/**
 * Stored capabilities as the admin API shows them (C-123): each profile's env
 * scrubbed, so a blob a runner sent before the fix never shows a value.
 */
export const toAdminCapabilities = (stored: unknown): Capabilities | null => {
  if (typeof stored !== 'object' || stored === null) return null;
  const { profiles } = stored as { profiles?: unknown };
  if (!Array.isArray(profiles)) return stored as Capabilities;
  return {
    ...stored,
    profiles: profiles.map((profile: unknown) =>
      typeof profile === 'object' && profile !== null
        ? {
            ...profile,
            env: scrubProfileEnv((profile as { env?: unknown }).env),
          }
        : profile,
    ),
  } as Capabilities;
};

export const toAdminProfile = (
  profile: RuntimeProfile,
): AdminRuntimeProfile => ({
  id: profile.id,
  key: profile.key,
  runtime: profile.runtime,
  label: profile.label,
  binary: profile.binary,
  // C-123: never a value outside the allowlist, even from an older row.
  env: scrubProfileEnv(profile.env),
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
