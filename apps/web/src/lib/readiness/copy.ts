import {
  NO_PROFILE_REASONS,
  type NoProfileDetails,
  noProfileMessage,
  PROFILE_SOURCES,
  type ProjectReadinessView,
  type ReadinessBlocker,
} from '@nautelle/shared';
import { ApiError } from '../api';
import { RUNNERS_PAGE } from '../prerequisites/copy';

/** What a `ReadinessNotice` says about one blocker (issue #272 D5). */
export interface ReadinessCopy {
  text: string;
  /** With `cta`: the page that removes the blocker. */
  href?: string;
  cta?: string;
  /** An admin's one-click fix: set this profile as the project default. */
  useProfile?: { id: string; label: string };
}

export interface ReadinessCopyContext {
  /** Only a workspace admin can set the default profile or open Runners. */
  isAdmin: boolean;
  projectId: string;
  suggestion: ProjectReadinessView['suggestion'];
}

/**
 * A `422 no_profile` (D2) as a sentence naming the fix, from its body's
 * `reason`, `source` and `profileKey`; a body without them is `none`.
 */
export function describeNoProfile(error: unknown): string {
  const body = error instanceof ApiError ? error.body : null;
  const reason = NO_PROFILE_REASONS.find((r) => r === body?.reason) ?? 'none';
  const source = PROFILE_SOURCES.find((s) => s === body?.source) ?? null;
  const profileKey =
    typeof body?.profileKey === 'string' ? body.profileKey : undefined;
  return noProfileMessage(
    reason === 'none' || source === null
      ? { reason: 'none', source: null }
      : { reason, source, profileKey },
  );
}

const settingsHref = (projectId: string, tab: string): string =>
  `/projects/${projectId}/settings?tab=${tab}`;

const SOURCE_NAME = {
  explicit: 'The chosen',
  orchestrator: 'The orchestrator’s',
  default: 'The project’s default',
} as const;

/** What is wrong with the profile D1 picked, as a sentence. */
const noProfileProblem = ({
  reason,
  source,
  profileKey,
}: NoProfileDetails): string => {
  if (reason === 'none' || !source) {
    return 'This project has no runtime profile.';
  }
  const named = `${SOURCE_NAME[source]} profile${profileKey ? ` ${profileKey}` : ''}`;
  switch (reason) {
    case 'not_claude':
      return `${named} is not a Claude profile; this needs one.`;
    case 'missing':
      return `${named} is no longer offered by the project’s runner.`;
    case 'not_on_runner':
      return `${named} does not belong to the project’s runner.`;
  }
};

/**
 * One blocker as text and its fix (D5): an admin gets "Use <profile>" and the
 * Settings link, everyone else is told to ask one; each other blocker links
 * the page that removes it.
 */
export function readinessCopy(
  blocker: ReadinessBlocker,
  { isAdmin, projectId, suggestion }: ReadinessCopyContext,
): ReadinessCopy {
  switch (blocker.code) {
    case 'no_profile': {
      const problem = noProfileProblem(blocker);
      if (!isAdmin) {
        return {
          text: `${problem} Ask an admin to set a runtime profile for this project.`,
        };
      }
      const orchestrator = blocker.source === 'orchestrator';
      return {
        text: problem,
        href: settingsHref(
          projectId,
          orchestrator ? 'orchestrator' : 'general',
        ),
        cta: orchestrator
          ? 'Choose in Settings › Orchestrator'
          : 'Choose in Settings › General',
        useProfile: suggestion
          ? { id: suggestion.id, label: suggestion.label }
          : undefined,
      };
    }
    case 'runner_offline':
      return {
        text: 'The project’s runner is offline, so this cannot start.',
        ...(isAdmin ? { href: RUNNERS_PAGE, cta: 'Open Runners' } : {}),
      };
    case 'runner_outdated':
      return {
        text: `The project’s runner is too old for this (it lacks ${blocker.commands.join(', ')}). Update it.`,
        ...(isAdmin ? { href: RUNNERS_PAGE, cta: 'Open Runners' } : {}),
      };
    case 'no_spec_dir':
      return {
        text: 'This project has no spec folder, so a spec cannot be written on Run. Set the Spec folder in the docs source settings.',
        href: settingsHref(projectId, 'docs'),
        cta: 'Set the Spec folder',
      };
    case 'no_docs_clone':
      return {
        text: 'The docs repository has no local clone, so a spec cannot be written on Run. Set its local clone path in the docs source settings.',
        href: settingsHref(projectId, 'docs'),
        cta: 'Set the local clone',
      };
    case 'content_off':
      return {
        text: 'Capture reads session content, and this project keeps none.',
        href: settingsHref(projectId, 'sessions'),
        cta: 'Open Sessions settings',
      };
  }
}
