import {
  isPlannedTask,
  type PlannedTask,
  type PlanQuestion,
  type PlanTaskKind,
  type PlanTaskStatus,
  type ReviseOutput,
} from '@nautelle/shared';
import {
  type DesignGate,
  designBlocks,
  withDesign,
} from '../design/design-rules';

/** D6: a blocking question keeps a task in `needs_talk`; otherwise it can be approved. */
export const statusOfRound = (
  questions: readonly PlanQuestion[],
): Extract<PlanTaskStatus, 'needs_talk' | 'ready'> =>
  questions.some((q) => q.blocking) ? 'needs_talk' : 'ready';

/** Statuses a task-level turn may talk about; an approved, rejected or issued one is settled. */
export const TALKABLE_STATUSES: readonly PlanTaskStatus[] = [
  'draft',
  'needs_talk',
  'needs_design',
  'ready',
  'rewrite_requested',
];

/** A task row to create, as `plan_tasks` holds it. */
export interface TaskDraft {
  key: string;
  kind: PlanTaskKind;
  title: string;
  summary: string;
  dependsOn: string[];
  status: PlanTaskStatus;
  questions: PlanQuestion[];
  document: string | null;
  frozen: boolean;
  sessionId: string | null;
}

/** A decomposed task: a draft whose status follows its first round. */
export const draftOf = (
  task: PlannedTask,
  sessionId: string | null = null,
): TaskDraft => ({
  key: task.key,
  kind: task.kind,
  title: task.title,
  summary: task.summary,
  dependsOn: task.dependsOn,
  status: statusOfRound(task.questions),
  questions: task.questions,
  document: null,
  frozen: false,
  sessionId,
});

/**
 * The grill result for a task: the next round, or done — `write` follows,
 * unless the task's design holds it (spec 223 D1): then approving the design
 * chains the write instead.
 */
export const afterGrill = (
  output: {
    questions: PlanQuestion[];
    done: boolean;
  },
  design: DesignGate | null = null,
): {
  status: PlanTaskStatus;
  questions: PlanQuestion[];
  chainWrite: boolean;
} =>
  output.done
    ? {
        status: withDesign('ready', design),
        questions: [],
        chainWrite: !designBlocks(design),
      }
    : {
        status: withDesign(statusOfRound(output.questions), design),
        questions: output.questions,
        chainWrite: false,
      };

/** A task of the current version, as revise reads it. */
export interface CurrentTask extends TaskDraft {
  rewriteComment: string | null;
}

/**
 * D9: the next plan version. Approved tasks pass through frozen and
 * unchanged (the parser already checked each `{ key }` names one); rejected
 * tasks are dropped by not being returned; new or changed tasks come back as
 * drafts with no document. A changed task keeps its conversation fork.
 */
export const revisedTasks = (
  current: readonly CurrentTask[],
  output: ReviseOutput,
): TaskDraft[] => {
  const byKey = new Map(current.map((t) => [t.key, t]));
  return output.tasks.map((t) => {
    const before = byKey.get(t.key);
    if (!isPlannedTask(t)) {
      if (!before) throw new Error(`frozen task ${t.key} is not in the plan`);
      return {
        key: before.key,
        kind: before.kind,
        title: before.title,
        summary: before.summary,
        dependsOn: before.dependsOn,
        status: 'approved',
        questions: before.questions,
        document: before.document,
        frozen: true,
        sessionId: before.sessionId,
      };
    }
    return draftOf(t, before?.sessionId ?? null);
  });
};
