import { z } from 'zod';
import {
  STEWARD_DIGEST_TRIGGERS,
  STEWARD_NUDGE_TEXT,
  stewardDialogIdSchema,
} from '../../steward/contracts';
import {
  DIGEST_PROSE_MAX,
  DIGEST_REASON_MAX,
  DIGEST_TITLE_MAX,
  isOneLine,
} from '../../steward/digest';
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
 * `root` is checked against the watched project. `digest.compose` (#491)
 * writes the digest prose; the API also checks that the runner advertises it.
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

// digest.compose

/** D3: the digest prose is always haiku's. */
export const DIGEST_COMPOSE_MODEL = 'haiku';
/** At most this many lines of a section are given to the model; `total` counts them all. */
export const DIGEST_COMPOSE_ITEMS_MAX = 20;
/** The runner gives the call up after this long. */
export const DIGEST_COMPOSE_TIMEOUT_SEC = 60;
/** The API waits for the answer this long: the call, plus the start of `claude`. */
export const DIGEST_COMPOSE_COMMAND_TIMEOUT_MS =
  (DIGEST_COMPOSE_TIMEOUT_SEC + 15) * 1000;

/** A bounded single line: what `oneLine(text, max)` leaves unchanged. */
const digestLineSchema = (max: number) =>
  z
    .string()
    .min(1)
    .refine((t) => isOneLine(t, max), {
      message: `must be one line of at most ${max} characters`,
    });

export const digestComposeItemSchema = z.strictObject({
  label: digestLineSchema(DIGEST_TITLE_MAX),
  title: digestLineSchema(DIGEST_TITLE_MAX),
  reason: digestLineSchema(DIGEST_REASON_MAX).nullable(),
});
export type DigestComposeItem = z.infer<typeof digestComposeItemSchema>;

export const digestComposeSectionSchema = z
  .strictObject({
    /** How many lines the stored section holds. */
    total: z.number().int().min(0).max(10_000),
    items: z.array(digestComposeItemSchema).max(DIGEST_COMPOSE_ITEMS_MAX),
  })
  .refine((s) => s.items.length <= s.total, {
    message: 'more items than the total',
    path: ['items'],
  });
export type DigestComposeSection = z.infer<typeof digestComposeSectionSchema>;

/**
 * #491 (D3, D14): haiku writes the digest's one-paragraph summary on the
 * project's runner, through `profileKey`, as one headless `claude -p` with no
 * tools — as the stall classifier does. The input is the digest's own stored
 * content and nothing else: card and run titles, one-line reasons, counts and
 * the spend, each already one bounded line (DA-13). No pane text, transcript
 * or path can be named here. `runId` is the API's `steward` run that books
 * the call's spend (D16); `sessionId` is the Claude session it picks.
 */
export const digestComposeArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  sessionId: z.uuid(),
  profileKey: profileKeySchema,
  model: z.literal(DIGEST_COMPOSE_MODEL),
  trigger: z.enum(STEWARD_DIGEST_TRIGGERS),
  projectName: digestLineSchema(DIGEST_TITLE_MAX),
  done: digestComposeSectionSchema,
  stuck: digestComposeSectionSchema,
  waiting: digestComposeSectionSchema,
  /** A decimal string, as every `costUsd`. */
  spendUsd: z.string().regex(/^\d{1,12}\.\d{2}$/),
});
export type DigestComposeArgs = z.infer<typeof digestComposeArgsSchema>;

/** One paragraph on one line, at most `DIGEST_PROSE_MAX` characters. */
export const digestComposeResultSchema = z.object({
  prose: digestLineSchema(DIGEST_PROSE_MAX),
});
export type DigestComposeResult = z.infer<typeof digestComposeResultSchema>;

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
  'digest.compose': {
    args: digestComposeArgsSchema,
    result: digestComposeResultSchema,
    minRole: 'operator',
    timeoutMs: DIGEST_COMPOSE_COMMAND_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;

export type StewardCommandName = keyof typeof stewardCommands;
export const STEWARD_COMMAND_NAMES = Object.keys(
  stewardCommands,
) as StewardCommandName[];
