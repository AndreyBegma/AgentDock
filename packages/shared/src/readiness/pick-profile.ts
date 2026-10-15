import type { Runtime } from '../protocol';

/**
 * One runtime-profile rule for every model-running action (issue #272 D1):
 * the explicit key, else the orchestrator profile, else the project default.
 * The first candidate that is set decides; an unusable one does not fall
 * through to the next — a silent fallback would run another account than the
 * one the admin chose.
 */

/** Which setting named the profile. */
export const PROFILE_SOURCES = ['explicit', 'orchestrator', 'default'] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

/**
 * Why no profile can run the action (D2):
 * - `none` — no candidate is set;
 * - `not_on_runner` — the profile belongs to another runner, or the explicit
 *   key names no profile on the project's runner;
 * - `missing` — the runner no longer advertises it;
 * - `not_claude` — a Codex profile; model-running actions need Claude.
 */
export const NO_PROFILE_REASONS = [
  'none',
  'not_on_runner',
  'missing',
  'not_claude',
] as const;
export type NoProfileReason = (typeof NO_PROFILE_REASONS)[number];

/** The `runtime_profiles` row facts the rule reads. */
export interface ProfileCandidate {
  id: string;
  key: string;
  label: string;
  runtime: Runtime;
  runnerId: string;
  missing: boolean;
}

export interface RuntimeProfileCandidates<P extends ProfileCandidate> {
  /** The project's runner. */
  runnerId: string;
  /**
   * A key named by the action (plan create's `profileKey`, a plan turn's
   * stored key), with the profile found by that key on the project's runner
   * (null when none matches). Absent when the action names no key.
   */
  explicit?: { key: string; profile: P | null } | null;
  /** `project_orchestrator_settings.profileId`'s row; null when unset. */
  orchestrator: P | null;
  /** `projects.defaultProfileId`'s row; null when unset. */
  default: P | null;
}

/** What a `no_profile` refusal carries next to its message (D2). */
export interface NoProfileDetails {
  reason: NoProfileReason;
  /** The setting that named the unusable profile; null for `none`. */
  source: ProfileSource | null;
  /** The unusable profile's key; absent for `none`. */
  profileKey?: string;
}

export type RuntimeProfilePick<P extends ProfileCandidate = ProfileCandidate> =
  | { ok: true; profile: P; source: ProfileSource }
  | {
      ok: false;
      reason: 'none';
      source: null;
      profile: null;
    }
  | {
      ok: false;
      reason: Exclude<NoProfileReason, 'none'>;
      source: ProfileSource;
      profileKey: string;
      /** The unusable row; null when an explicit key matched none. */
      profile: P | null;
    };

/** The pick's refusal as D2's body fields; null when the pick is usable. */
export const noProfileDetails = (
  pick: RuntimeProfilePick,
): NoProfileDetails | null => {
  if (pick.ok) return null;
  if (pick.reason === 'none') return { reason: 'none', source: null };
  return {
    reason: pick.reason,
    source: pick.source,
    profileKey: pick.profileKey,
  };
};

const usableReason = (
  profile: ProfileCandidate,
  runnerId: string,
): Exclude<NoProfileReason, 'none'> | null => {
  if (profile.runnerId !== runnerId) return 'not_on_runner';
  if (profile.missing) return 'missing';
  if (profile.runtime !== 'claude') return 'not_claude';
  return null;
};

/** D1: the profile a model-running action runs on, or why there is none. */
export const pickRuntimeProfile = <P extends ProfileCandidate>(
  candidates: RuntimeProfileCandidates<P>,
): RuntimeProfilePick<P> => {
  const { explicit, orchestrator, runnerId } = candidates;
  const chosen: {
    source: ProfileSource;
    key: string;
    profile: P | null;
  } | null = explicit
    ? { source: 'explicit', key: explicit.key, profile: explicit.profile }
    : orchestrator
      ? { source: 'orchestrator', key: orchestrator.key, profile: orchestrator }
      : candidates.default
        ? {
            source: 'default',
            key: candidates.default.key,
            profile: candidates.default,
          }
        : null;
  if (!chosen)
    return { ok: false, reason: 'none', source: null, profile: null };
  const { source, key, profile } = chosen;
  const refuse = (
    reason: Exclude<NoProfileReason, 'none'>,
  ): RuntimeProfilePick<P> => ({
    ok: false,
    reason,
    source,
    profileKey: key,
    profile,
  });
  if (!profile) return refuse('not_on_runner');
  const reason = usableReason(profile, runnerId);
  return reason ? refuse(reason) : { ok: true, profile, source };
};

const FIX: Record<ProfileSource, string> = {
  explicit:
    'Choose another profile, or have an admin set the project default in Settings › General.',
  orchestrator: 'An admin can change it in Settings › Orchestrator.',
  default: 'An admin can change the default in Settings › General.',
};

/**
 * D2: the message of a `no_profile` refusal — what is wrong and where the
 * fix is. `runtime` names the runtime of a `not_claude` profile.
 */
export const noProfileMessage = (
  details: NoProfileDetails & { runtime?: Runtime },
): string => {
  const { reason, source, profileKey = 'The profile' } = details;
  if (reason === 'none' || !source) {
    return 'This project has no runtime profile. An admin sets the default in Settings › General.';
  }
  const what =
    reason === 'not_claude'
      ? `${profileKey} is a ${details.runtime ?? 'non-Claude'} profile; this needs a Claude profile.`
      : reason === 'missing'
        ? `${profileKey} is no longer offered by the project's runner.`
        : `${profileKey} is not a profile of the project's runner.`;
  return `${what} ${FIX[source]}`;
};

/**
 * D4: the profile an admin's one-click "Use <profile>" sets as the project
 * default — the runner's usable Claude profiles, first by label (so the only
 * one when there is one); null when there is none.
 */
export const suggestRuntimeProfile = <P extends ProfileCandidate>(
  profiles: readonly P[],
  runnerId: string,
): P | null =>
  profiles
    .filter((profile) => usableReason(profile, runnerId) === null)
    .sort(
      (a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
    )
    .at(0) ?? null;

/** The body of a `422 no_profile` from any module (D2). */
export type NoProfileErrorBody = {
  statusCode: number;
  error: 'no_profile';
  message: string;
} & NoProfileDetails;
