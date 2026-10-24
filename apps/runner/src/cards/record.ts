import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  cardDraftPullRequestSchema,
  cardIdSchema,
  cardShortIdSchema,
  cardTmuxSessionSchema,
  orchestratorPermissionModeSchema,
  skillRunIdSchema,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import { removeRawDir } from '../filter/raw-store';
import {
  type ExitRecord,
  exitRecordSchema,
  RUN_FILES,
  readJson,
  writeJsonAtomic,
} from '../skills/run/record';

/**
 * The runner's view of a card's current round. `stopped` is a session the
 * runner killed itself (`card.stop`, `card.close`, or replaced by the next
 * round, D9): its end is not reported as `ended`.
 */
export const cardRecordPhaseSchema = z.enum([
  'starting',
  'running',
  'ended',
  'failed',
  'stopped',
]);
export type CardRecordPhase = z.infer<typeof cardRecordPhaseSchema>;

/** A card as the executor keeps it, `<cardsDir>/<cardId>/state.json`. */
export const cardRecordSchema = z.object({
  cardId: cardIdSchema,
  projectId: z.string().min(1),
  root: z.string().min(1),
  /** `project.repo` of the event envelope. */
  repo: z.string().min(1),
  shortId: cardShortIdSchema,
  worktree: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1),
  tmuxSession: cardTmuxSessionSchema,
  /** The round the session runs for. */
  runId: skillRunIdSchema,
  phase: cardRecordPhaseSchema,
  /**
   * #447: the round's Claude session — Steward matches hook events to the
   * round by it — and the profile it runs on, for the local classifier.
   * Absent on a record from before Steward.
   */
  sessionId: z.uuid().optional(),
  profileKey: z.string().min(1).optional(),
  /**
   * DA-15: the mode the round's `card.run` launched in; `card.resume`
   * relaunches in it, never in a mode of its own. Absent on an older record.
   */
  permissionMode: orchestratorPermissionModeSchema.optional(),
  /**
   * C-369: the round's `card.run` carried `demo` — the session has DemoFlow's
   * MCP server, and `card.resume` relaunches it with it. Absent is off.
   */
  demo: z.literal(true).optional(),
  /**
   * #445 D8, DR-10: set when the round launched with Token saver on — the
   * daemon then guards its `finish_card`, asking for `Closes #issueNumber`.
   */
  finishGuard: z
    .object({ issueNumber: z.number().int().positive().nullable() })
    .optional(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  /**
   * #359 D3: the paths `card.run` committed (the spec, a design), kept
   * across rounds; the PR body links them when the worker wrote none.
   */
  specFiles: z.array(z.string().min(1)).optional(),
  /**
   * #359 D1: the round's draft PR (`card.run`'s `pullRequest`). Set, the
   * session poll pushes the committed HEAD and opens the draft; absent,
   * nothing is pushed before collect.
   */
  pullRequest: cardDraftPullRequestSchema.optional(),
  /** #359 D1: the commit of `branch` this runner last pushed. */
  pushedHead: z.string().min(1).optional(),
  /**
   * #359 D1: the open PR of `branch` the poll found or opened; `opened` when
   * this runner opened it as a draft — the one collect marks ready (D3).
   */
  pushPr: z
    .object({
      number: z.number().int().positive(),
      url: z.string().min(1),
      opened: z.boolean(),
    })
    .optional(),
  /**
   * #359 D8: the card's earlier branches, a follow-up round ago, with the
   * head this runner pushed of each; Completed's cleanup deletes them.
   */
  previousBranches: z
    .array(
      z.object({
        branch: z.string().min(1),
        pushedHead: z.string().min(1).optional(),
      }),
    )
    .optional(),
});
export type CardRecord = z.infer<typeof cardRecordSchema>;

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Card state on disk, so a runner restart keeps watching the sessions that
 * run on in tmux. Each round has its own directory for `run.json` and
 * `exit.json`, the files `exec-run` reads and writes.
 */
export class CardStore {
  constructor(readonly cardsDir: string) {}

  dir(cardId: string): string {
    return join(this.cardsDir, cardIdSchema.parse(cardId));
  }

  roundDir(cardId: string, runId: string): string {
    return join(this.dir(cardId), 'rounds', skillRunIdSchema.parse(runId));
  }

  /**
   * Creates the round directory; an existing one is reused. #445 DR-07: the
   * earlier rounds are over, so their raw outputs go now, not with the card.
   */
  createRound(cardId: string, runId: string): string {
    const dir = this.roundDir(cardId, runId);
    mkdirSync(this.cardsDir, { recursive: true, mode: 0o700 });
    const rounds = join(this.dir(cardId), 'rounds');
    for (const name of safeReaddir(rounds)) {
      if (name !== skillRunIdSchema.parse(runId)) {
        removeRawDir(join(rounds, name));
      }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  save(record: CardRecord): void {
    mkdirSync(this.dir(record.cardId), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir(record.cardId), RUN_FILES.state), record);
  }

  load(cardId: string): CardRecord | null {
    if (!cardIdSchema.safeParse(cardId).success) return null;
    return readJson(join(this.dir(cardId), RUN_FILES.state), cardRecordSchema);
  }

  /** Every readable record. */
  all(): CardRecord[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.cardsDir);
    } catch {
      return [];
    }
    return names
      .map((name) => this.load(name))
      .filter((r): r is CardRecord => r !== null);
  }

  /** What `exec-run` recorded when the round's binary exited. */
  exit(record: CardRecord): ExitRecord | null {
    return readJson(
      join(this.roundDir(record.cardId, record.runId), RUN_FILES.exit),
      exitRecordSchema,
    );
  }

  /** The card and every round of it, gone (D10). */
  remove(cardId: string): void {
    rmSync(this.dir(cardId), { recursive: true, force: true });
  }
}
