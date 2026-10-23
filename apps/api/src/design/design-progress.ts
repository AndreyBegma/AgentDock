import {
  type DesignBatchMode,
  type DesignFailureView,
  type DesignProgressView,
  designFailureReasonOf,
  type TaskDesignStatus,
} from '@nautelle/shared';
import type { PlanTurnPhase, Prisma, RunStatus } from '@prisma/client';
import { designTurnPlanOf } from './design-rules';
import type { Db, DesignKey } from './design-store';
import { buildArgsOf } from './ui-profile-mapper';

/**
 * #275 D1, D6: what a busy design is doing, and why its last batch ended
 * without a revision. Derived at read time from the design turns and the
 * profile builds — nothing is stored but `task_designs.busySince` (D2).
 * The rules are pure; `loadDesignProgress` reads their inputs.
 */

const BUSY: readonly TaskDesignStatus[] = ['generating', 'revising'];

/** A design turn of the owner, with its run. */
export interface ProgressTurn {
  id: string;
  phase: PlanTurnPhase;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  run: { id: string; startedAt: Date; args: Prisma.JsonValue };
}

/** A `ui_profile` run whose `args.waiting` held the design. */
export interface ProgressBuild {
  id: string;
  status: RunStatus;
  outcome: string | null;
  startedAt: Date;
  endedAt: Date | null;
  args: Prisma.JsonValue;
}

export interface ProgressDesign {
  id: string;
  status: TaskDesignStatus;
  variantCount: number;
  busySince: Date | null;
  approvedAt: Date | null;
  revisions: readonly { createdAt: Date }[];
}

const batchModeOf = (status: TaskDesignStatus): DesignBatchMode =>
  status === 'revising' ? 'revise' : 'generate';

/** A design turn the runner has not finished: queued or running. */
export const isActiveTurn = <T extends Pick<ProgressTurn, 'phase'>>(
  turn: T | null,
): turn is T & { phase: 'queued' | 'running' } =>
  turn !== null && (turn.phase === 'queued' || turn.phase === 'running');

/**
 * D1: the queued or running turn first — once it exists the build is done —
 * then the running build. Busy with neither is the gap between two variants
 * of a batch: `null`, read as "Starting the next variant…". #840: a turn
 * not finished yet is progress whatever the status says — the design is busy
 * until the turn's end settles it.
 */
export const progressOf = (
  design: ProgressDesign,
  active: { turn: ProgressTurn | null; build: ProgressBuild | null },
): DesignProgressView | null => {
  const { turn, build } = active;
  if (isActiveTurn(turn)) {
    const plan = designTurnPlanOf(turn.run.args);
    const mode = plan?.mode ?? batchModeOf(design.status);
    return {
      stage: mode === 'revise' ? 'revise' : 'draw',
      phase: turn.phase,
      runId: turn.run.id,
      turnId: turn.id,
      variant: plan?.variant ?? null,
      variantCount: design.variantCount,
      step: plan?.profileBuildRunId ? 2 : null,
      startedAt: (design.busySince ?? turn.run.startedAt).toISOString(),
    };
  }
  if (!BUSY.includes(design.status)) return null;
  if (build && build.status === 'running') {
    return {
      // A build's queued phase is not stored (`uiprofile_build.phase_changed`
      // only publishes), so it reads as running.
      stage: 'profile',
      phase: 'running',
      runId: build.id,
      turnId: null,
      variant: null,
      variantCount: design.variantCount,
      step: 1,
      startedAt: (design.busySince ?? build.startedAt).toISOString(),
    };
  }
  return null;
};

const turnFailure = (
  turn: ProgressTurn,
  design: ProgressDesign,
): DesignFailureView | null => {
  if (turn.phase !== 'failed' && turn.phase !== 'cancelled') return null;
  const plan = designTurnPlanOf(turn.run.args);
  return {
    stage: plan?.mode === 'revise' ? 'revise' : 'draw',
    mode: plan?.mode ?? (design.revisions.length > 0 ? 'revise' : 'generate'),
    reason: designFailureReasonOf(turn.error, turn.phase === 'cancelled'),
    message: turn.error ?? '',
    variant: plan?.variant ?? null,
    at: (turn.finishedAt ?? turn.createdAt).toISOString(),
  };
};

const buildFailure = (
  build: ProgressBuild,
  designId: string,
): DesignFailureView | null => {
  if (build.status !== 'failed' && build.status !== 'abandoned') return null;
  const waiting = buildArgsOf(build.args)?.waiting.find(
    (w) => w.designId === designId,
  );
  if (!waiting) return null;
  return {
    stage: 'profile',
    mode: waiting.mode,
    reason: designFailureReasonOf(build.outcome, build.status === 'abandoned'),
    message: build.outcome ?? '',
    variant: null,
    at: (build.endedAt ?? build.startedAt).toISOString(),
  };
};

/**
 * D6: only at rest — not busy, no design turn queued or running — the newer of the owner's latest design turn and the
 * latest build that held the design — when it failed or was cancelled, and
 * only when it is newer than the latest revision and the last approval.
 */
export const lastFailureOf = (
  design: ProgressDesign,
  last: { turn: ProgressTurn | null; build: ProgressBuild | null },
): DesignFailureView | null => {
  if (BUSY.includes(design.status) || isActiveTurn(last.turn)) return null;
  const since = Math.max(
    0,
    design.approvedAt?.getTime() ?? 0,
    ...design.revisions.map((r) => r.createdAt.getTime()),
  );
  const candidates = [
    last.turn ? turnFailure(last.turn, design) : null,
    last.build ? buildFailure(last.build, design.id) : null,
  ].filter(
    (f): f is DesignFailureView =>
      f !== null && new Date(f.at).getTime() > since,
  );
  candidates.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
  return candidates[0] ?? null;
};

const turnSelect = {
  id: true,
  phase: true,
  error: true,
  createdAt: true,
  finishedAt: true,
  run: { select: { id: true, startedAt: true, args: true } },
} as const satisfies Prisma.PlanTurnSelect;

const buildSelect = {
  id: true,
  status: true,
  outcome: true,
  startedAt: true,
  endedAt: true,
  args: true,
} as const satisfies Prisma.RunSelect;

/** The design turns of an owner: its plan task's, or its card's. */
export const designTurnWhere = (owner: DesignKey): Prisma.PlanTurnWhereInput =>
  'cardId' in owner
    ? { cardId: owner.cardId, action: 'design' }
    : 'stackId' in owner
      ? { stackId: owner.stackId, action: 'design' }
      : {
          planId: owner.planId,
          task: { key: owner.taskKey },
          action: 'design',
        };

/** `ui_profile` runs of the project whose `args.waiting` holds the design. */
export const buildsHoldingWhere = (
  projectId: string,
  designId: string,
): Prisma.RunWhereInput => ({
  projectId,
  kind: 'ui_profile',
  args: { path: ['waiting'], array_contains: [{ designId }] },
});

/**
 * The view's `activeTurnId`, `progress` and `lastFailure` (D1, D6): the
 * latest design turn and the latest build that held the design are all
 * either rule reads.
 */
export const loadDesignProgress = async (
  db: Db,
  projectId: string,
  owner: DesignKey,
  design: ProgressDesign,
): Promise<{
  activeTurnId: string | null;
  progress: DesignProgressView | null;
  lastFailure: DesignFailureView | null;
}> => {
  const [turn, build] = await Promise.all([
    db.planTurn.findFirst({
      where: designTurnWhere(owner),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: turnSelect,
    }),
    db.run.findFirst({
      where: buildsHoldingWhere(projectId, design.id),
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: buildSelect,
    }),
  ]);
  const found = { turn, build };
  return {
    activeTurnId: isActiveTurn(turn) ? turn.id : null,
    progress: progressOf(design, found),
    lastFailure: lastFailureOf(design, found),
  };
};
