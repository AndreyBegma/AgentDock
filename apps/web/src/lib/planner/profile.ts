import type { ProjectRuntimeProfile } from '@agentdock/shared';
import type { RunProfileReason } from '../skills/format';

/**
 * The runtime profile a new plan starts on (#213): the project default, else
 * the only Claude profile, else none — the person picks one. Never an empty
 * "(none set)" that the API answers with a 422.
 */
export function initialProfileKey(
  profiles: readonly ProjectRuntimeProfile[],
): string {
  const preferred =
    profiles.find((p) => p.isDefault) ??
    (profiles.length === 1 ? profiles[0] : undefined);
  return preferred?.key ?? '';
}

/** Where the default runtime profile is set. */
export const profileSettingsHref = (projectId: string): string =>
  `/projects/${projectId}/settings?tab=orchestrator`;

/**
 * Why **Plan** is off for want of a profile (rule R1), as the next step; null
 * when the plan has one. `profiles` are the runner's Claude profiles; a
 * failed load is said as such, never as "there are none".
 */
export function planProfileReason(
  profileKey: string,
  profiles: readonly ProjectRuntimeProfile[] | 'failed',
  projectId: string,
): RunProfileReason | null {
  if (profiles === 'failed') {
    return {
      text: 'The runner’s runtime profiles could not be loaded, so a plan cannot pick one. Reload the page.',
    };
  }
  if (profiles.length === 0) {
    return {
      text: 'The project’s runner has no Claude runtime profile to plan with.',
      href: profileSettingsHref(projectId),
      cta: 'Open project settings',
    };
  }
  if (profileKey !== '') return null;
  return {
    text: 'Pick a runtime profile, or set a project default.',
    href: profileSettingsHref(projectId),
    cta: 'Set a default profile',
  };
}
