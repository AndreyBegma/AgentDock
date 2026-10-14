import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  cardIdSchema,
  cardShortIdSchema,
  cardTmuxSessionSchema,
  skillRunIdSchema,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
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
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
});
export type CardRecord = z.infer<typeof cardRecordSchema>;

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

  /** Creates the round directory; an existing one is reused. */
  createRound(cardId: string, runId: string): string {
    const dir = this.roundDir(cardId, runId);
    mkdirSync(this.cardsDir, { recursive: true, mode: 0o700 });
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
