import {
  type FrozenTaskRef,
  intakeRoundsAsked,
  isIntakeRound,
  isPlannedTask,
  PLANNER_INTAKE_MAX_ROUNDS,
  type PlanDetail,
  type PlanGraphView,
  type PlanIntakeSplitView,
  type PlannedTask,
  type PlannerInstructionsVersion,
  type PlanQuestion,
  type PlanSummary,
  type PlanTaskIssueView,
  type PlanTaskStatus,
  type PlanTaskView,
  type PlanTurnAction,
  type PlanTurnInput,
  type PlanTurnRound,
  type PlanTurnView,
  type PlanUserRef,
  plannerOutputSchemas,
  planQuestionRoundSchema,
  planTurnInputSchema,
  type TaskDesignSummary,
} from '@agentdock/shared';
import type { Prisma } from '@prisma/client';
import { type PlanStatusTurn, planAttention } from './plan-status';

export const userSelect = {
  select: { id: true, name: true, email: true },
} as const;

type UserRow = { id: string; name: string | null; email: string } | null;

/** A deleted author leaves the record behind without a name (schema: `SET NULL`). */
export const userRef = (user: UserRow): PlanUserRef =>
  user
    ? { id: user.id, name: user.name ?? user.email }
    : { id: '', name: 'Deleted user' };

export const versionInclude = { author: userSelect } as const;

type VersionRow = Prisma.PlannerInstructionsGetPayload<{
  include: typeof versionInclude;
}>;

export const toInstructionsVersion = (
  row: VersionRow,
): PlannerInstructionsVersion => ({
  id: row.id,
  version: row.version,
  body: row.body,
  author: row.author ? userRef(row.author) : null,
  createdAt: row.createdAt.toISOString(),
});

/** A stored round; one that no longer parses reads as empty rather than failing the page. */
export const questionsOf = (value: Prisma.JsonValue): PlanQuestion[] => {
  const parsed = planQuestionRoundSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

export const inputOf = (value: Prisma.JsonValue): PlanTurnInput => {
  const parsed = planTurnInputSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
};

/** D6: open blocking questions keep a task in `needs_talk`. */
export const blockingOpen = (questions: readonly PlanQuestion[]): number =>
  questions.filter((q) => q.blocking).length;

/**
 * The rounds a turn opened, read back from its stored output with the
 * action's contract schema. An output that no longer parses reads as no
 * rounds, like `questionsOf`; a frozen revise pass-through opens none.
 */
export const roundsOf = (
  action: PlanTurnAction,
  output: Prisma.JsonValue,
  taskKey: string | null,
): PlanTurnRound[] => {
  if (output === null) return [];
  const parsed = plannerOutputSchemas[action].safeParse(output);
  if (!parsed.success) return [];
  const out = parsed.data;
  switch (out.action) {
    case 'clarify':
      return out.done ? [] : [{ taskKey: null, questions: out.questions }];
    case 'grill':
      return out.done
        ? []
        : [{ taskKey: taskKey ?? out.taskKey, questions: out.questions }];
    case 'decompose':
    case 'revise':
      return out.tasks.flatMap((t: PlannedTask | FrozenTaskRef) =>
        isPlannedTask(t) && t.questions.length > 0
          ? [{ taskKey: t.key, questions: t.questions }]
          : [],
      );
    case 'write':
    case 'design':
      return [];
    case 'intake':
      // #337 D4: a round; the card and a split (#409) open none.
      return isIntakeRound(out)
        ? [{ taskKey: null, questions: out.questions }]
        : [];
  }
};

export const turnInclude = {
  author: userSelect,
  task: { select: { key: true } },
} as const;

type TurnRow = Prisma.PlanTurnGetPayload<{ include: typeof turnInclude }>;

/** ADR-0025: plan turns are read per plan, so a card's design turn never reaches here. */
const turnPlanId = (row: TurnRow): string => {
  if (row.planId === null) throw new Error(`turn ${row.id} has no plan`);
  return row.planId;
};

export const toTurnView = (row: TurnRow): PlanTurnView => ({
  id: row.id,
  planId: turnPlanId(row),
  taskKey: row.task?.key ?? null,
  runId: row.runId,
  action: row.action,
  author: userRef(row.author),
  input: inputOf(row.input),
  phase: row.phase,
  error: row.error,
  resultText: row.resultText,
  rounds: roundsOf(row.action, row.output, row.task?.key ?? null),
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

type TaskRow = Prisma.PlanTaskGetPayload<object>;

export const toTaskView = (
  row: TaskRow,
  issue: PlanTaskIssueView | null,
  design: TaskDesignSummary | null = null,
): PlanTaskView => {
  const questions = questionsOf(row.questions);
  return {
    id: row.id,
    key: row.key,
    planVersion: row.planVersion,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    dependsOn: row.dependsOn,
    status: row.status,
    questions,
    blockingOpen: blockingOpen(questions),
    document: row.document,
    rewriteComment: row.rewriteComment,
    frozen: row.frozen,
    issue,
    queuedAt: row.queuedAt?.toISOString() ?? null,
    design,
    cardId: row.cardId,
  };
};

export const taskCounts = (
  tasks: readonly { status: PlanTaskStatus }[],
): Partial<Record<PlanTaskStatus, number>> => {
  const counts: Partial<Record<PlanTaskStatus, number>> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return counts;
};

export const planInclude = { author: userSelect } as const;

type PlanRow = Prisma.PlanGetPayload<{ include: typeof planInclude }>;

/**
 * `latestTurn`: the plan's newest turn of any scope (#213) — a failed one
 * that nothing replaced marks the plan for attention.
 */
export const toSummary = (
  row: PlanRow,
  tasks: readonly { status: PlanTaskStatus }[],
  latestTurn: PlanStatusTurn | null,
): PlanSummary => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  author: userRef(row.author),
  mode: row.mode,
  visibility: row.visibility,
  status: row.status,
  version: row.version,
  taskCounts: taskCounts(tasks),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  sentAt: row.sentAt?.toISOString() ?? null,
  attention: planAttention(row.status, latestTurn),
});

/** Tasks as nodes, `dependsOn` as edges from the dependency to its dependant. */
export const graphOf = (
  tasks: readonly Pick<PlanTaskView, 'key' | 'kind' | 'title' | 'dependsOn'>[],
): PlanGraphView => {
  const keys = new Set(tasks.map((t) => t.key));
  return {
    nodes: tasks.map((t) => ({ key: t.key, kind: t.kind, title: t.title })),
    edges: tasks.flatMap((t) =>
      t.dependsOn
        .filter((d) => keys.has(d))
        .map((d) => ({ from: d, to: t.key })),
    ),
  };
};

export interface DetailParts {
  plan: PlanRow & { instructions: { version: number } };
  tasks: PlanTaskView[];
  turns: PlanTurnView[];
  /** The plan's newest turn row, for its attention (#213). */
  latestTurn: PlanStatusTurn | null;
  /** The current plan-level round (dialogue mode, before decomposition). */
  questions: PlanQuestion[];
  /** #409: an intake's open split proposal. */
  split?: PlanIntakeSplitView | null;
}

export const toDetail = ({
  plan,
  tasks,
  turns,
  latestTurn,
  questions,
  split,
}: DetailParts): PlanDetail => ({
  ...toSummary(plan, tasks, latestTurn),
  brief: plan.brief,
  questions,
  instructionsVersion: plan.instructions.version,
  contractVersion: plan.contractVersion,
  profileKey: plan.profileKey,
  model: plan.model,
  docsPrNumber: plan.docsPrNumber,
  docsPrUrl: plan.docsPrUrl,
  docsPrRepo: plan.docsPrRepo,
  tasks,
  turns,
  graph: graphOf(tasks),
  activeTurnId:
    turns.find((t) => t.phase === 'queued' || t.phase === 'running')?.id ??
    null,
  intake:
    plan.mode === 'card'
      ? {
          roundsAsked: intakeRoundsAsked(turns),
          maxRounds: PLANNER_INTAKE_MAX_ROUNDS,
          split: split ?? null,
        }
      : null,
});
