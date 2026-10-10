import { z } from 'zod';
import type { CommandDefinition } from '../commands';

/**
 * GitHub App commands (docs/specs/27-github-app.md D13).
 *
 * `githubCommands` is defined and exported here, but entered in the
 * `commands` allowlist only together with its runner handler: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (spec 27, notes).
 */

/** The collectors a GitHub delivery can ask the runner to poll now (D8). */
export const POLLABLE_COLLECTORS = ['issues', 'prs', 'worktrees'] as const;
export const pollableCollectorSchema = z.enum(POLLABLE_COLLECTORS);
export type PollableCollector = z.infer<typeof pollableCollectorSchema>;

/**
 * `collector.poll` — restart the named collectors of one project through the
 * runner's registry (`stop()` then `start()`; each polls on start). Sent only
 * by the API's GitHub module as the system actor; no user route exposes it.
 */
export const collectorPollArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  collectors: z
    .array(pollableCollectorSchema)
    .min(1)
    .max(POLLABLE_COLLECTORS.length)
    .refine((list) => new Set(list).size === list.length, {
      message: 'collectors must be unique',
    }),
});
export type CollectorPollArgs = z.infer<typeof collectorPollArgsSchema>;

export const collectorPollResultSchema = z.object({
  /** The collectors actually restarted — a collector not running is absent. */
  restarted: z.array(z.string().min(1)),
});
export type CollectorPollResult = z.infer<typeof collectorPollResultSchema>;

export const collectorPollCommand = {
  args: collectorPollArgsSchema,
  result: collectorPollResultSchema,
  // #5's role union has no `system` value; admin keeps every user route out (D13).
  minRole: 'admin',
} as const satisfies CommandDefinition;

/** The GitHub App commands by wire name, for the runner slot to spread into `commands`. */
export const githubCommands = {
  'collector.poll': collectorPollCommand,
} as const;
