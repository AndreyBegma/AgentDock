import type { PlanTurnView, ProjectDetail } from '@nautelle/shared';
import {
  type CommandSupport,
  commandsSupport,
  RUNNER_FEATURE_COMMANDS,
} from '@nautelle/shared/protocol';
import { isRunnerOnline } from '../prerequisites/facts';
import {
  isContractViolation,
  isRunnerTooOld,
  RUNNER_TOO_OLD_TEXT,
} from './format';

/**
 * #233: whether the project's runner serves a feature, read before the first
 * try from the commands it advertised in its hello. An absent advert is
 * unknown, never none: the screens then keep their reactive `unknown_command`
 * paths, which only an older runner still needs.
 */

/** Where "Update the runner" sends a person: the install page has the upgrade. */
export const RUNNER_UPDATE_HREF = '/install';

export type RunnerFeature = keyof typeof RUNNER_FEATURE_COMMANDS;

/** What stops a feature on a runner that advertised its commands. */
export type RunnerGate = 'outdated' | 'disabled';

export type RunnerFacts = Pick<
  ProjectDetail,
  'runnerStatus' | 'runnerCommands'
>;

/** The feature's support; `unknown` while the project loads. */
export const runnerSupport = (
  project: RunnerFacts | undefined,
  feature: RunnerFeature,
): CommandSupport =>
  commandsSupport(project?.runnerCommands, RUNNER_FEATURE_COMMANDS[feature]);

const gateOf = (support: CommandSupport): RunnerGate | null =>
  support === 'missing'
    ? 'outdated'
    : support === 'disabled'
      ? 'disabled'
      : null;

/**
 * The gate a screen shows and disables its action for, or null. A runner
 * that is not online has the offline banner, which wins: its advert is the
 * last hello's, and the fix is to start it first.
 */
export function runnerGate(
  project: RunnerFacts | undefined,
  feature: RunnerFeature,
): RunnerGate | null {
  if (!project || !isRunnerOnline(project.runnerStatus)) return null;
  return gateOf(runnerSupport(project, feature));
}

export interface PlannerRunnerBlock {
  gate: RunnerGate;
  /**
   * From the advert: Plan is off. False when it was learned from a refusal
   * (the advert is unknown) — the banner shows and Plan stays on, as before.
   */
  known: boolean;
}

/**
 * The Planner page's runner banner. The advert decides when there is one;
 * only when it is unknown does a refused turn — the newest plan's failure,
 * or the plan just tried — say the runner is too old. So the banner clears
 * once an updated runner advertises `plan.turn`.
 */
export function plannerRunnerBlock({
  project,
  createdTooOld,
  newestReason,
}: {
  project: RunnerFacts | undefined;
  createdTooOld: boolean;
  newestReason: string | null | undefined;
}): PlannerRunnerBlock | null {
  if (!project || !isRunnerOnline(project.runnerStatus)) return null;
  const support = runnerSupport(project, 'planner');
  if (support === 'unknown') {
    return createdTooOld || isRunnerTooOld(newestReason)
      ? { gate: 'outdated', known: false }
      : null;
  }
  const gate = gateOf(support);
  return gate ? { gate, known: true } : null;
}

export interface RunnerGateCopy {
  /** The banner's title. */
  title: string;
  /** The banner's body. */
  body: string;
  /** The `DisabledReason` under the action the gate turns off. */
  reason: string;
  /** With `cta`: where the fix is. Absent for a disabled command: it is the runner's config. */
  href?: string;
  cta?: string;
}

/** What the feature is, in "The runner is too old to …". */
const FEATURE_VERB: Record<RunnerFeature, string> = {
  planner: 'plan',
  design: 'draw mockups',
  uiProfileBuild: 'build the UI profile',
  uiProfileLearn: 'learn from approved designs',
  worktree: 'read worktrees',
  docsRepo: 'write specs to a docs repository',
  ruleScan: 'scan a project for coding rules',
  prefixOptimise: 'compress rules and propose prefix overlays',
};

const DISABLED_BODY =
  'This command is turned off in the runner’s config (disabledCommands). Remove it there and restart the runner.';

export function runnerGateCopy(
  feature: RunnerFeature,
  gate: RunnerGate,
): RunnerGateCopy {
  const verb = FEATURE_VERB[feature];
  if (gate === 'disabled') {
    return {
      title: `The runner is set not to ${verb}`,
      body: DISABLED_BODY,
      reason: `The runner’s config turns this off (disabledCommands).`,
    };
  }
  return {
    title: `The runner is too old to ${verb}`,
    body:
      feature === 'planner'
        ? RUNNER_TOO_OLD_TEXT
        : `The project’s runner is too old to ${verb}. Update the runner, then try again.`,
    reason: `The runner is too old to ${verb}. Update it first.`,
    href: RUNNER_UPDATE_HREF,
    cta: 'Update the runner',
  };
}

export interface FailedTurnCopy {
  title: string;
  text: string;
  /** "Update the runner" goes here; null when the runner is not the cause. */
  updateHref: string | null;
}

/**
 * A failed turn's banner. A turn refused with `unknown_command` came from a
 * runner too old for the planner — still possible with an unknown advert, or
 * a turn that raced an update.
 */
export function failedTurnCopy(
  turn: Pick<PlanTurnView, 'error'>,
): FailedTurnCopy {
  const violation = isContractViolation(turn);
  const tooOld = isRunnerTooOld(turn.error);
  const reason = tooOld
    ? RUNNER_TOO_OLD_TEXT
    : (turn.error ?? 'The runner gave no reason.');
  return {
    title: violation
      ? 'The planner’s answer did not follow the contract'
      : tooOld
        ? 'The runner is too old to plan'
        : 'The turn failed',
    text: violation ? `Nothing was changed. ${reason}` : reason,
    updateHref: tooOld ? RUNNER_UPDATE_HREF : null,
  };
}
