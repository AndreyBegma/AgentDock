import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { planTurnPhaseSchema } from '@nautelle/shared';
import {
  planIdSchema,
  planTurnArgsSchema,
  skillRunShortIdSchema,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import {
  type ExitRecord,
  exitRecordSchema,
  RUN_FILES,
  readJson,
  writeJsonAtomic,
} from '../skills/run/record';

/**
 * A plan's state on the runner, `$XDG_STATE_HOME/nautelle/plans/<planId>/`:
 * `plan.json` (its worktree, D15) and one directory per turn under `turns/`.
 * A turn directory is what `exec-run` reads and writes (`run.json`,
 * `stream.jsonl`, `stderr.log`, `exit.json`), plus `prompt.md` (D16) and the
 * executor's `state.json`. Everything survives a runner restart.
 */
export const PLAN_FILE = 'plan.json';
export const PROMPT_FILE = 'prompt.md';

export const planRecordSchema = z.object({
  planId: planIdSchema,
  projectId: z.string().min(1),
  root: z.string().min(1),
  /** `project.repo` of the event envelope. */
  repo: z.string().min(1),
  shortId: skillRunShortIdSchema,
  worktree: z.string().min(1),
  /** The last time a turn of this plan was queued or finished (the 14-day idle rule). */
  lastActiveAt: z.iso.datetime(),
});
export type PlanRecord = z.infer<typeof planRecordSchema>;

/** A turn as the executor keeps it. The prompt is in `prompt.md`, never here. */
export const turnRecordSchema = planTurnArgsSchema
  .omit({ prompt: true })
  .extend({
    shortId: skillRunShortIdSchema,
    /** The turn's tmux session. */
    tmuxSession: z.string().min(1),
    phase: planTurnPhaseSchema,
    queuedAt: z.iso.datetime(),
    /** Set once the tmux session is created. */
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    cancelRequested: z.boolean().optional(),
    /** #494: the work's key, when the turn runs with Context handoff. */
    handoffKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  });
export type TurnRecord = z.infer<typeof turnRecordSchema>;

export class PlanStore {
  constructor(readonly plansDir: string) {}

  planDir(planId: string): string {
    return join(this.plansDir, planIdSchema.parse(planId));
  }

  turnDir(planId: string, turnId: string): string {
    return join(this.planDir(planId), 'turns', planIdSchema.parse(turnId));
  }

  loadPlan(planId: string): PlanRecord | null {
    if (!planIdSchema.safeParse(planId).success) return null;
    return readJson(join(this.planDir(planId), PLAN_FILE), planRecordSchema);
  }

  savePlan(plan: PlanRecord): void {
    mkdirSync(this.planDir(plan.planId), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.planDir(plan.planId), PLAN_FILE), plan);
  }

  /** The plan's directory, its turns included, is gone. */
  removePlan(planId: string): void {
    rmSync(this.planDir(planId), { recursive: true, force: true });
  }

  plans(): PlanRecord[] {
    return this.names(this.plansDir)
      .map((name) => this.loadPlan(name))
      .filter((p): p is PlanRecord => p !== null);
  }

  turnExists(planId: string, turnId: string): boolean {
    return existsSync(this.turnDir(planId, turnId));
  }

  /** Creates the turn directory with its prompt; false when it already exists. */
  createTurn(turn: TurnRecord, prompt: string): boolean {
    const turns = join(this.planDir(turn.planId), 'turns');
    mkdirSync(turns, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(this.turnDir(turn.planId, turn.turnId), { mode: 0o700 });
    } catch {
      return false;
    }
    writeFileSync(this.promptFile(turn), prompt, { mode: 0o600 });
    this.saveTurn(turn);
    return true;
  }

  saveTurn(turn: TurnRecord): void {
    writeJsonAtomic(this.file(turn, 'state'), turn);
  }

  loadTurn(planId: string, turnId: string): TurnRecord | null {
    if (
      !planIdSchema.safeParse(planId).success ||
      !planIdSchema.safeParse(turnId).success
    ) {
      return null;
    }
    return readJson(
      join(this.turnDir(planId, turnId), RUN_FILES.state),
      turnRecordSchema,
    );
  }

  /** Every readable turn of every plan, oldest queued first. */
  turns(): TurnRecord[] {
    return this.plans()
      .flatMap((plan) =>
        this.names(join(this.planDir(plan.planId), 'turns')).map((name) =>
          this.loadTurn(plan.planId, name),
        ),
      )
      .filter((t): t is TurnRecord => t !== null)
      .sort((a, b) =>
        a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0,
      );
  }

  exit(turn: TurnRecord): ExitRecord | null {
    return readJson(this.file(turn, 'exit'), exitRecordSchema);
  }

  file(turn: TurnRecord, name: keyof typeof RUN_FILES): string {
    return join(this.turnDir(turn.planId, turn.turnId), RUN_FILES[name]);
  }

  promptFile(turn: TurnRecord): string {
    return join(this.turnDir(turn.planId, turn.turnId), PROMPT_FILE);
  }

  private names(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }
}
