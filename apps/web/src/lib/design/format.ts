import type { Status } from '@andrewbehma/glass-ui/status-pill';
import {
  type BoardCardView,
  DESIGN_ERROR,
  type DesignErrorCode,
  type PlanTaskView,
  type TaskDesignStatus,
  type TaskDesignSummary,
  type UiProfileStatus,
} from '@nautelle/shared';
import { ApiError, type Described } from '../api';
import {
  RUNNER_UPDATE_HREF,
  type RunnerFacts,
  type RunnerGate,
  runnerGate,
} from '../planner/runner-support';
import { describeNoProfile } from '../readiness/copy';
import { elapsedSince, formatClock } from './progress';

/**
 * The design stage's words and colours (spec 223 "UI"), on glass-ui's status
 * scale like the Planner's.
 */

export const DESIGN_STATUS_LABEL: Record<TaskDesignStatus, string> = {
  idle: 'Not drawn yet',
  generating: 'Drawing',
  reviewing: 'In review',
  revising: 'Revising',
  approved: 'Approved',
};

export const DESIGN_STATUS_PILL: Record<TaskDesignStatus, Status> = {
  idle: 'idle',
  generating: 'running',
  // Waits on the person's comments or approval.
  reviewing: 'waiting',
  revising: 'running',
  approved: 'done',
};

export const PROFILE_STATUS_LABEL: Record<UiProfileStatus, string> = {
  none: 'Not built',
  fresh: 'Up to date',
  stale: 'Out of date',
  building: 'Building',
};

export const PROFILE_STATUS_PILL: Record<UiProfileStatus, Status> = {
  none: 'idle',
  fresh: 'done',
  // The next design turn rebuilds it first (D13).
  stale: 'paused',
  building: 'running',
};

export const PROFILE_STATUS_HINT: Record<UiProfileStatus, string> = {
  none: 'The first design in this project builds it.',
  fresh: 'Built from the files on the base branch as they are now.',
  stale:
    'Files it was built from have changed. The next design rebuilds it first.',
  building: 'A build is running.',
};

/**
 * What Generate does with the project's UI profile before the first turn
 * (D13), from its status (#606) — not from the design's `profileId`, which
 * stays null until a revision is drawn. Null when nothing comes first, or
 * while the status is not known.
 */
export function generateProfileNote(
  status: UiProfileStatus | null,
): string | null {
  switch (status) {
    case 'none':
      return 'This project has no UI profile yet: Generate builds it first, which takes a few minutes.';
    case 'stale':
      return 'The last rebuild of the UI profile failed: Generate tries it again first, which takes a few minutes.';
    case 'building':
      return 'The UI profile is being built: Generate waits for it to finish.';
    case 'fresh':
    case null:
      return null;
  }
}

/**
 * The Design chip on a task card: off, suggested by the planner and not on,
 * on, approved (spec 223 "UI", D2).
 */
export type DesignChipState = 'off' | 'suggested' | 'on' | 'approved';

export function designChipState(task: PlanTaskView): DesignChipState {
  const design = task.design;
  if (!design) return 'off';
  if (design.status === 'approved') return 'approved';
  if (design.needed) return 'on';
  return design.suggested ? 'suggested' : 'off';
}

export const DESIGN_CHIP_LABEL: Record<DesignChipState, string> = {
  off: 'Design off',
  suggested: 'Design suggested',
  on: 'Design on',
  approved: 'Design approved',
};

/**
 * The Design chip on a board card (#243): off, on and not drawn, being drawn,
 * waiting for the person, approved. A card has no planner suggestion.
 */
export type CardDesignChipState =
  | 'off'
  | 'on'
  | 'generating'
  | 'reviewing'
  | 'approved';

export function cardDesignChipState(
  design: TaskDesignSummary | null,
): CardDesignChipState {
  if (!design?.needed) return 'off';
  switch (design.status) {
    case 'approved':
      return 'approved';
    case 'generating':
    case 'revising':
      return 'generating';
    case 'reviewing':
      return 'reviewing';
    case 'idle':
      return 'on';
  }
}

export const CARD_DESIGN_CHIP_LABEL: Record<CardDesignChipState, string> = {
  off: 'Design off',
  on: 'Design on',
  generating: 'Drawing design',
  reviewing: 'Design in review',
  approved: 'Design approved',
};

/**
 * #275 D8: the chip's text. While the design is being drawn it carries the
 * whole job's clock from `busySince` ("Drawing design · 3:12"); a design
 * without one (busy at deploy) keeps the plain label.
 */
export function cardDesignChipText(
  design: TaskDesignSummary | null,
  now: number,
): string {
  const state = cardDesignChipState(design);
  const label = CARD_DESIGN_CHIP_LABEL[state];
  if (state !== 'generating' || !design?.busySince) return label;
  return `${label} · ${formatClock(elapsedSince(design.busySince, now))}`;
}

/**
 * Whether the card's design can still be switched or the continue switch
 * changed (#243 D5, "designs freeze once a round exists"): no round yet, the
 * design not approved, no turn running.
 */
export const canToggleCardDesign = (
  card: Pick<BoardCardView, 'round' | 'design'>,
): boolean =>
  card.round === null &&
  card.design?.status !== 'approved' &&
  card.design?.status !== 'generating' &&
  card.design?.status !== 'revising';

/** Whether "Continue after design" can still change: until the design is approved. */
export const canChangeContinue = (
  card: Pick<BoardCardView, 'round' | 'design'>,
): boolean => card.round === null && card.design?.status !== 'approved';

/** Whether the chip offers Open design: the design is on, or was approved. */
export const opensCardDesign = (design: TaskDesignSummary | null): boolean =>
  design?.needed === true || design?.status === 'approved';

/**
 * D3: where the toggle sits. A project whose profile says it has no UI hides
 * it behind "Design anyway", unless the design is already on; with no
 * profile yet (`hasUi` null) it is shown.
 */
export const toggleBehindMenu = (
  task: PlanTaskView,
  hasUi: boolean | null,
): boolean => hasUi === false && !task.design?.needed;

/** Whether the card offers "Open design": the design is on, or was approved. */
export const opensDesign = (task: PlanTaskView): boolean =>
  task.status === 'needs_design' ||
  task.design?.needed === true ||
  task.design?.status === 'approved';

/** Whether the person may still switch the design (D2: until the task is approved). */
export const canToggleDesign = (task: PlanTaskView): boolean =>
  !task.frozen &&
  task.status !== 'approved' &&
  task.status !== 'issued' &&
  task.design?.status !== 'approved' &&
  task.design?.status !== 'generating' &&
  task.design?.status !== 'revising';

const ERROR_TEXT: Record<DesignErrorCode, string> = {
  not_found:
    'This design does not exist, or its plan is private to its author.',
  forbidden: 'Your role in this project cannot do that.',
  invalid_args: 'The request was refused as invalid. Reload and try again.',
  design_not_approved:
    'This task needs its design approved before the task can be approved.',
  design_off: 'The design is off for this task. Turn it on first.',
  design_busy:
    'The planner is still working on this design. Wait for it to finish.',
  no_open_comments: 'Leave a comment first: Revise sends the open comments.',
  design_approved: 'This design is approved and takes no more changes.',
  task_frozen:
    'This task is approved or sent, or this card has started a round; its design can no longer change.',
  profile_build_failed:
    'The UI profile could not be built. See the build run in the Design settings.',
  contract_violation:
    'The planner returned a mockup that breaks the rules. Try again, or revise with a comment.',
  unsupported_runtime:
    'Designs run on Claude Code only; this plan uses another runtime.',
  budget_exceeded: 'The project has reached its budget. Raise it to continue.',
  command_unavailable:
    'The runner does not know this command yet. Update the runner.',
  command_failed: 'The runner could not run it. Try again.',
  runner_timeout: 'The runner did not answer in time. Try again.',
  runner_outdated: 'The runner is too old for this. Update the runner.',
  design_not_running: 'Nothing of this design is running.',
  no_profile: 'No runtime profile. An admin sets it in Settings › General.',
};

/** A sentence for the person, and where the fix is when it is elsewhere. */
export function describeDesignError(
  error: unknown,
  projectId?: string,
): Described {
  if (!(error instanceof ApiError)) {
    return 'The request failed. Check your connection and try again.';
  }
  const raw = error.body?.error;
  const code =
    typeof raw === 'string' && raw in ERROR_TEXT
      ? (raw as DesignErrorCode)
      : error.status === 404
        ? DESIGN_ERROR.notFound
        : error.status === 403
          ? DESIGN_ERROR.forbidden
          : null;
  if (code === null) return error.message;
  if (code === DESIGN_ERROR.noProfile) {
    const text = describeNoProfile(error);
    return projectId
      ? {
          text,
          href: `/projects/${projectId}/settings?tab=${error.body?.source === 'orchestrator' ? 'orchestrator' : 'general'}`,
          cta: 'Open project settings',
        }
      : text;
  }
  const text = ERROR_TEXT[code];
  if (projectId && code === DESIGN_ERROR.budgetExceeded) {
    return {
      text,
      href: `/projects/${projectId}/settings?tab=budget`,
      cta: 'Open budget',
    };
  }
  if (projectId && code === DESIGN_ERROR.profileBuildFailed) {
    return {
      text,
      href: `/projects/${projectId}/settings?tab=design`,
      cta: 'Open Design settings',
    };
  }
  // 503 `command_unavailable` is also an offline runner, not only an old one.
  if (
    code === DESIGN_ERROR.commandUnavailable &&
    /not connected/i.test(error.message)
  ) {
    return 'The project’s runner is offline. Start it, then try again.';
  }
  if (
    code === DESIGN_ERROR.commandUnavailable ||
    code === DESIGN_ERROR.runnerOutdated
  ) {
    return { text, href: RUNNER_UPDATE_HREF, cta: 'Update the runner' };
  }
  return text;
}

/**
 * #233: what stops **Generate** before it is tried — a design turn needs
 * `plan.turn` and both UI profile commands.
 */
export const generateRunnerGate = (
  project: RunnerFacts | undefined,
): RunnerGate | null => runnerGate(project, 'design');

/** #233: what stops Settings → Design's **Build** / **Rebuild**. */
export const rebuildRunnerGate = (
  project: RunnerFacts | undefined,
): RunnerGate | null => runnerGate(project, 'uiProfileBuild');

/** "Variant 2 · revision 3". */
export const revisionLabel = (variant: number, revision: number): string =>
  `Variant ${variant} · revision ${revision}`;
