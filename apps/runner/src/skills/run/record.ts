import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  skillRunArgsSchema,
  skillRunIdSchema,
  skillRunPhaseSchema,
  skillRunShortIdSchema,
} from '@agentdock/shared/protocol';
import { z } from 'zod';

/** Files of a run directory, `$XDG_STATE_HOME/agentdock/runs/<runId>/` (D7). */
export const RUN_FILES = {
  /** The executor's record of the run; it survives a runner restart. */
  state: 'state.json',
  /** What `exec-run` launches. */
  launch: 'run.json',
  stream: 'stream.jsonl',
  stderr: 'stderr.log',
  exit: 'exit.json',
  /** The full `git diff` against the base; the event carries at most 128 KiB. */
  patch: 'patch.diff',
} as const;

/** A run as the executor keeps it, on disk and in memory. */
export const runRecordSchema = skillRunArgsSchema.extend({
  shortId: skillRunShortIdSchema,
  /** `project.repo` of the event envelope. */
  repo: z.string().min(1),
  session: z.string().min(1),
  worktree: z.string().min(1),
  branch: z.string().min(1),
  phase: skillRunPhaseSchema,
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  /** The commit of `origin/<base>` the worktree was created from. */
  baseCommit: z.string().min(1).optional(),
  cancelRequested: z.boolean().optional(),
  /** Why the session ended; set when collecting starts, so a restart can resume it. */
  endReason: z
    .enum(['exited', 'vanished', 'cancelled', 'timed_out'])
    .optional(),
  /** `pr` output: the open PR whose closing removes the worktree (D10). */
  pr: z
    .object({
      number: z.number().int().positive(),
      url: z.string().min(1),
      github: z.string().min(1),
    })
    .optional(),
  /** The worktree and branch were removed. */
  cleanedUp: z.boolean().optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** What `exec-run` reads (D7): an argv and an environment, never a shell string. */
export const launchSpecSchema = z.object({
  binary: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string().min(1),
});
export type LaunchSpec = z.infer<typeof launchSpecSchema>;

/** What `exec-run` writes when the profile binary exits. */
export const exitRecordSchema = z.object({
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  at: z.iso.datetime(),
});
export type ExitRecord = z.infer<typeof exitRecordSchema>;

export const runDirOf = (runsDir: string, runId: string): string =>
  join(runsDir, skillRunIdSchema.parse(runId));

/** Writes JSON through a temp file and a rename, so a reader never sees half. */
export const writeJsonAtomic = (path: string, value: unknown): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
};

export const readJson = <T>(path: string, schema: z.ZodType<T>): T | null => {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export class RunStore {
  constructor(readonly runsDir: string) {}

  dir(runId: string): string {
    return runDirOf(this.runsDir, runId);
  }

  exists(runId: string): boolean {
    return existsSync(this.dir(runId));
  }

  /** Creates the run directory; false when it already exists. */
  create(record: RunRecord): boolean {
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(this.dir(record.runId), { mode: 0o700 });
    } catch {
      return false;
    }
    this.save(record);
    return true;
  }

  save(record: RunRecord): void {
    writeJsonAtomic(join(this.dir(record.runId), RUN_FILES.state), record);
  }

  load(runId: string): RunRecord | null {
    if (!skillRunIdSchema.safeParse(runId).success) return null;
    return readJson(join(this.dir(runId), RUN_FILES.state), runRecordSchema);
  }

  /** Every readable record, oldest queued first. */
  all(): RunRecord[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.runsDir);
    } catch {
      return [];
    }
    return names
      .map((name) => this.load(name))
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) =>
        a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0,
      );
  }

  exit(runId: string): ExitRecord | null {
    return readJson(join(this.dir(runId), RUN_FILES.exit), exitRecordSchema);
  }

  file(runId: string, name: keyof typeof RUN_FILES): string {
    return join(this.dir(runId), RUN_FILES[name]);
  }
}
