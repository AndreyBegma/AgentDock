import { z } from 'zod';
import {
  STEWARD_NUDGE_TEXT,
  stewardDialogIdSchema,
} from '../../steward/contracts';
import { stewardActableSubjectSchema } from '../../steward/events';
import { tokenSaverConfigSchema } from '../../token-saver/contracts';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import {
  CARD_TIMEOUTS_MS,
  cardDraftPullRequestSchema,
  cardIdSchema,
  cardShortIdSchema,
  cardTmuxSessionSchema,
} from './cards';
import {
  orchestratorModelSchema,
  orchestratorPermissionModeSchema,
} from './control';
import { gitRefSchema, profileKeySchema, skillRunIdSchema } from './skills';

/**
 * Steward's actions on the runner (#447 D2, D9–D11, ADR-0010). The API
 * decides — the rules, the project's switches and the per-round limits — and
 * sends one of these; the runner acts and reports each action as a
 * `steward.acted` event. None of them takes a fleet slot (D5): the subject
 * schema has no such option.
 *
 * The API sends them only to a runner whose capabilities say `steward: true`.
 *
 * `stewardCommands` is defined and exported here, but entered in the
 * `commands` allowlist only together with its runner handlers: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (the card and text precedent).
 *
 * No argument names a tmux session or a path the runner trusts as given: the
 * session is resolved from the subject, the worktree from `shortId`, and
 * `root` is checked against the watched project.
 */

export const STEWARD_COMMAND_TIMEOUT_MS = 15_000;

// session.nudge

/**
 * D9: types the one fixed line into the subject's session and presses Enter
 * — only when the pane shows an idle prompt. `sent: false` when it does not,
 * or the session is gone; the runner then sends nothing.
 */
export const sessionNudgeArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  subject: stewardActableSubjectSchema,
  text: z.literal(STEWARD_NUDGE_TEXT),
});
export type SessionNudgeArgs = z.infer<typeof sessionNudgeArgsSchema>;

export const sessionNudgeResultSchema = z.object({ sent: z.boolean() });
export type SessionNudgeResult = z.infer<typeof sessionNudgeResultSchema>;

// session.dismiss

/**
 * D11: answers a dialog on the #435 list with the key that changes nothing —
 * only when the pane still shows that dialog. `dismissed: false` otherwise.
 * An unlisted dialog or a permission prompt cannot be named here.
 */
export const sessionDismissArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  subject: stewardActableSubjectSchema,
  dialogId: stewardDialogIdSchema,
});
export type SessionDismissArgs = z.infer<typeof sessionDismissArgsSchema>;

export const sessionDismissResultSchema = z.object({ dismissed: z.boolean() });
export type SessionDismissResult = z.infer<typeof sessionDismissResultSchema>;

// card.resume

/**
 * D10: restarts a dead card session in its existing worktree with
 * `claude --resume <sessionId>` and the fixed `STEWARD_RESUME_TEXT` prompt —
 * the same launch facts as the round's `card.run`. It never creates a
 * worktree: with none, the outcome is `no_worktree` and nothing starts. A
 * session still alive is `alive`, left alone. The API never sends it for a
 * round a person stopped.
 */
export const cardResumeArgsSchema = z
  .strictObject({
    cardId: cardIdSchema,
    projectId: z.string().min(1),
    runId: skillRunIdSchema,
    root: absolutePathSchema,
    base: gitRefSchema,
    shortId: cardShortIdSchema,
    branch: gitRefSchema,
    sessionId: z.uuid(),
    profileKey: profileKeySchema,
    model: orchestratorModelSchema,
    permissionMode: orchestratorPermissionModeSchema,
    /** As on the round's `card.run` (#359 D1). */
    pullRequest: cardDraftPullRequestSchema.optional(),
    /** As on the round's `card.run` (#445 D11). */
    tokenSaver: tokenSaverConfigSchema.optional(),
  })
  .refine((a) => a.pullRequest === undefined || a.branch !== a.base, {
    message: 'a pushed branch must not be the base branch',
    path: ['branch'],
  });
export type CardResumeArgs = z.infer<typeof cardResumeArgsSchema>;

export const cardResumeResultSchema = z
  .object({
    outcome: z.enum(['resumed', 'alive', 'no_worktree']),
    /** With `resumed` and `alive`. */
    tmuxSession: cardTmuxSessionSchema.optional(),
  })
  .refine(
    (r) => (r.outcome === 'no_worktree') === (r.tmuxSession === undefined),
    { message: 'tmuxSession goes with a live session', path: ['tmuxSession'] },
  );
export type CardResumeResult = z.infer<typeof cardResumeResultSchema>;

export const stewardCommands = {
  'session.nudge': {
    args: sessionNudgeArgsSchema,
    result: sessionNudgeResultSchema,
    minRole: 'operator',
    timeoutMs: STEWARD_COMMAND_TIMEOUT_MS,
  },
  'session.dismiss': {
    args: sessionDismissArgsSchema,
    result: sessionDismissResultSchema,
    minRole: 'operator',
    timeoutMs: STEWARD_COMMAND_TIMEOUT_MS,
  },
  'card.resume': {
    args: cardResumeArgsSchema,
    result: cardResumeResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.run,
  },
} as const satisfies Record<string, CommandDefinition>;

export type StewardCommandName = keyof typeof stewardCommands;
export const STEWARD_COMMAND_NAMES = Object.keys(
  stewardCommands,
) as StewardCommandName[];
