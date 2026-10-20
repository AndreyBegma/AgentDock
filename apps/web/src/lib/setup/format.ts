import type {
  ProjectSummary,
  SetupState,
  SetupStep,
  TerminalSetupItem,
  TerminalSetupItemId,
  TerminalSetupView,
} from '@agentdock/shared';

/** Issue #281 D6: the web side of the "Terminal → Board" checklist. */

export const SETUP_ITEM_LABEL: Record<TerminalSetupItemId, string> = {
  runner_online: 'Runner is connected',
  plugin: 'agentdock plugin is installed',
  plugin_loaded: 'Sessions load the plugin',
  content: 'Session content is on',
  capture: 'Card capture is on',
  telemetry: 'Telemetry reaches the runner',
};

export const SETUP_STATE_LABEL: Record<SetupState, string> = {
  done: 'Done',
  todo: 'To do',
  unknown: 'Unknown',
};

export const SETUP_STATE_TONE: Record<SetupState, 'ok' | 'warn' | 'neutral'> = {
  done: 'ok',
  todo: 'warn',
  unknown: 'neutral',
};

/** "agentdock plugin is installed · main" for a per-profile item. */
export const setupItemTitle = (item: TerminalSetupItem): string =>
  item.profileKey
    ? `${SETUP_ITEM_LABEL[item.id]} · ${item.profileKey}`
    : SETUP_ITEM_LABEL[item.id];

/** A step in `/projects/:id/settings…` changes a setting: administrators only. */
export const stepNeedsAdmin = (step: SetupStep): boolean =>
  step.kind === 'link' && /^\/projects\/[^/]+\/settings/.test(step.href);

export const ASK_AN_ADMIN = 'Ask an admin';

/** The sentence under a blocked item. */
export const BLOCKED_LABEL: Record<TerminalSetupItemId, string> = {
  runner_online: 'Needs the runner',
  plugin: 'Needs the plugin',
  plugin_loaded: 'Needs the plugin',
  content: 'Needs session content',
  capture: 'Needs session content first',
  telemetry: 'Needs the plugin',
};

/** #719: the runner's profiles the project does not use — never required. */
export const OTHER_PROFILES_TITLE = 'Other profiles on this runner';
export const OTHER_PROFILES_DESCRIPTION =
  'This project does not use these profiles, so their steps are optional.';

/** #719: the profiles a project admin hid from Nautelle on the runner. */
export const IGNORED_PROFILES_TITLE = 'Ignored profiles';

export const settingsSessionsHref = (projectId: string): string =>
  `/projects/${projectId}/settings?tab=sessions`;

/** "3 steps", "1 step". */
export const stepsLabel = (count: number): string =>
  `${count} ${count === 1 ? 'step' : 'steps'}`;

/** One Overview "Needs you" row for the checklist. */
export interface TerminalSetupNeed {
  key: string;
  projectId: string;
  projectName: string;
  title: string;
  reason: string;
  href: string;
}

/**
 * The Overview entry of a project whose checklist has a required step to do.
 * Operators and up only (D6); none while everything required is done or only
 * unknown.
 */
export function terminalSetupNeed(
  project: Pick<ProjectSummary, 'id' | 'displayName' | 'role'>,
  view: TerminalSetupView | undefined,
): TerminalSetupNeed | null {
  if (!view || project.role === 'viewer' || view.todo === 0) return null;
  return {
    key: `terminal-setup:${project.id}`,
    projectId: project.id,
    projectName: project.displayName,
    title: 'Terminal sessions don’t reach the Board',
    reason: stepsLabel(view.todo),
    href: settingsSessionsHref(project.id),
  };
}

/** Every project's entry, in project order. */
export function terminalSetupNeeds(
  projects: readonly Pick<ProjectSummary, 'id' | 'displayName' | 'role'>[],
  views: ReadonlyMap<string, TerminalSetupView>,
): TerminalSetupNeed[] {
  return projects.flatMap((project) => {
    const need = terminalSetupNeed(project, views.get(project.id));
    return need ? [need] : [];
  });
}
