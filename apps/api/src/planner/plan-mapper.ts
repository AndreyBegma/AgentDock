import {
  type PlanDetail,
  type PlanGraphView,
  type PlannerInstructionsVersion,
  type PlanQuestion,
  type PlanSummary,
  type PlanTaskIssueView,
  type PlanTaskStatus,
  type PlanTaskView,
  type PlanTurnInput,
  type PlanTurnView,
  type PlanUserRef,
  planQuestionRoundSchema,
  planTurnInputSchema,
} from '@agentdock/shared';
import type { Prisma } from '@prisma/client';

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

export const turnInclude = {
  author: userSelect,
  task: { select: { key: true } },
} as const;

type TurnRow = Prisma.PlanTurnGetPayload<{ include: typeof turnInclude }>;

export const toTurnView = (row: TurnRow): PlanTurnView => ({
  id: row.id,
  planId: row.planId,
  taskKey: row.task?.key ?? null,
  runId: row.runId,
  action: row.action,
  author: userRef(row.author),
  input: inputOf(row.input),
  phase: row.phase,
  error: row.error,
  resultText: row.resultText,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

type TaskRow = Prisma.PlanTaskGetPayload<object>;

export const toTaskView = (
  row: TaskRow,
  issue: PlanTaskIssueView | null,
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

export const toSummary = (
  row: PlanRow,
  tasks: readonly { status: PlanTaskStatus }[],
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
  /** The current plan-level round (dialogue mode, before decomposition). */
  questions: PlanQuestion[];
}

export const toDetail = ({
  plan,
  tasks,
  turns,
  questions,
}: DetailParts): PlanDetail => ({
  ...toSummary(plan, tasks),
  brief: plan.brief,
  questions,
  instructionsVersion: plan.instructions.version,
  contractVersion: plan.contractVersion,
  profileKey: plan.profileKey,
  model: plan.model,
  docsPrNumber: plan.docsPrNumber,
  docsPrUrl: plan.docsPrUrl,
  tasks,
  turns,
  graph: graphOf(tasks),
  activeTurnId:
    turns.find((t) => t.phase === 'queued' || t.phase === 'running')?.id ??
    null,
});
