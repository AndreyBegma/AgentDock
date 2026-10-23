import { z } from 'zod';
import { pendingQuestionSchema } from '../../session-message/contracts';
import { protectedPathsSchema } from '../branch-policy';
import { headShaSchema } from '../commands/approvals';
import { cardIdSchema, cardTmuxSessionSchema } from '../commands/cards';
import { gitRefSchema, skillRunIdSchema } from '../commands/skills';
import { localErrorCodeSchema } from '../local';
import { paneDialogSchema, quotaLimitSchema } from './fleet';

/**
 * Card worker events (issue #242 "Runner"). A round outlives the `card.run`
 * command that started it, so its progress travels in the event stream.
 * `source: "runner"`; the envelope's `project` names the project, and
 * `data.projectId` repeats its id so the API can match the round without a
 * lookup. What Claude does inside the session arrives as `hook.*` events of
 * the card's session id (D6).
 */

/**
 * The runner's view of a round. `ended` is the tmux session gone (D6, polled
 * every `CARD_SESSION_POLL_MS`); `failed` is a round that could not start.
 */
export const cardRunPhaseSchema = z.enum([
  'starting',
  'running',
  'ended',
  'failed',
]);
export type CardRunPhase = z.infer<typeof cardRunPhaseSchema>;

/**
 * #367 D1–D3: how a round's session reaches the Board — hooks and
 * `finish_card`. `plugin`: the profile's own nautelle plugin; `injected`:
 * the runner's `--settings` / `--mcp-config` of the round; `none`: neither.
 */
export const cardRunWiringSchema = z.enum(['plugin', 'injected', 'none']);
export type CardRunWiring = z.infer<typeof cardRunWiringSchema>;

/**
 * #367 D3: why a round has no wiring. The runner sends
 * `settings_write_failed` (and, once it probes the CLI, `claude_too_old`);
 * `runner_outdated` is the API's reading of a `running` event without
 * `wiring` — a runner older than #367.
 */
export const cardRunWiringReasonSchema = z.enum([
  'runner_outdated',
  'settings_write_failed',
  'claude_too_old',
]);
export type CardRunWiringReason = z.infer<typeof cardRunWiringReasonSchema>;

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), { message: 'must be an absolute path' });

export const cardRunPhaseChangedDataSchema = z
  .object({
    cardId: cardIdSchema,
    runId: skillRunIdSchema,
    projectId: z.string().min(1),
    phase: cardRunPhaseSchema,
    at: z.iso.datetime(),
    tmuxSession: cardTmuxSessionSchema.optional(),
    /** Display only. */
    worktree: absolutePath.optional(),
    /** `exec-run`'s `exit.json`, on `ended`; absent when the session was killed. */
    exitCode: z.number().int().optional(),
    /** Why a round failed, without a stack trace. */
    error: z.string().min(1).max(500).optional(),
    /** #367 D3: the round's launch facts, on `running`; absent from older runners. */
    wiring: cardRunWiringSchema.optional(),
    /** #367 D3: with `wiring: 'none'` only. */
    wiringReason: cardRunWiringReasonSchema.optional(),
  })
  .refine((d) => d.wiringReason === undefined || d.wiring === 'none', {
    message: 'wiringReason goes with wiring: none',
    path: ['wiringReason'],
  });
export type CardRunPhaseChangedData = z.infer<
  typeof cardRunPhaseChangedDataSchema
>;

/** `data` schema of every card run event type. */
export const cardRunEventDataSchemas = {
  'card_run.phase_changed': cardRunPhaseChangedDataSchema,
} as const;

export type CardRunEventType = keyof typeof cardRunEventDataSchemas;
export const CARD_RUN_EVENT_TYPES = Object.keys(
  cardRunEventDataSchemas,
) as CardRunEventType[];

export const isCardRunEventType = (type: string): type is CardRunEventType =>
  Object.hasOwn(cardRunEventDataSchemas, type);

/**
 * #359 D1: the runner's session poll pushed the round's committed HEAD of
 * `branch` and, when none was open, opened a draft PR. Sent after every push
 * (at most one per `CARD_PUSH_MIN_INTERVAL_MS`), and with the PR whenever one
 * is open, so the API fills the card's `prUrl` while it is In progress and a
 * new head resets its CI state.
 *
 * Its own map, outside `cardRunEventDataSchemas`: the board sink enters it
 * together with its handler.
 */
export const cardRunPushedDataSchema = z
  .object({
    cardId: cardIdSchema,
    runId: skillRunIdSchema,
    projectId: z.string().min(1),
    at: z.iso.datetime(),
    branch: gitRefSchema,
    /** The pushed commit, now the PR's head. */
    headSha: headShaSchema,
    prNumber: z.number().int().positive().optional(),
    prUrl: z.url({ protocol: /^https$/ }).optional(),
    /** With a PR only; `draft` until collect marks it ready (D3). */
    prState: z.enum(['open', 'draft']).optional(),
    /** C-148 (D-12): as `card.collect`'s — the protected paths the branch changes. */
    protectedPaths: protectedPathsSchema.optional(),
    /**
     * #837: commits on `branch` ahead of `origin/<base>` at this push — the
     * API counts a round's commits from it. Absent from a runner older than
     * the field.
     */
    ahead: z.number().int().nonnegative().optional(),
  })
  .refine((d) => (d.prNumber === undefined) === (d.prUrl === undefined), {
    message: 'prNumber and prUrl go together',
    path: ['prUrl'],
  })
  .refine((d) => d.prState === undefined || d.prNumber !== undefined, {
    message: 'prState needs a PR',
    path: ['prState'],
  });
export type CardRunPushedData = z.infer<typeof cardRunPushedDataSchema>;

export const cardPushEventDataSchemas = {
  'card_run.pushed': cardRunPushedDataSchema,
} as const;

export type CardPushEventType = keyof typeof cardPushEventDataSchemas;

export const isCardPushEventType = (type: string): type is CardPushEventType =>
  Object.hasOwn(cardPushEventDataSchemas, type);

/**
 * #473: the round's pane shows Claude Code's question selector — the worker
 * asked the person a question (`AskUserQuestion`) and waits for the answer.
 * Sent once per question, when the runner's session poll first sees it; the
 * API moves the round to `waiting` and tells the person. The answer ends the
 * tool call, and its `hook.tool_finished` moves the round back to `running`.
 * Never carries the question: it is content.
 *
 * Its own map, outside `cardRunEventDataSchemas`: the board sink enters it
 * together with its handler.
 */
export const cardRunQuestionDataSchema = z.object({
  cardId: cardIdSchema,
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  at: z.iso.datetime(),
});
export type CardRunQuestionData = z.infer<typeof cardRunQuestionDataSchema>;

export const cardQuestionEventDataSchemas = {
  'card_run.question': cardRunQuestionDataSchema,
} as const;

export type CardQuestionEventType = keyof typeof cardQuestionEventDataSchemas;

export const isCardQuestionEventType = (
  type: string,
): type is CardQuestionEventType =>
  Object.hasOwn(cardQuestionEventDataSchemas, type);

/**
 * #624: a Claude Code dialog has blocked the round's session for
 * `CARD_DIALOG_WAIT_MS` — the workspace trust dialog, or any other the
 * runner does not answer itself. Sent once per dialog shown; the API moves
 * the round to `waiting`, names the dialog on the card and tells the person.
 * The answer's next hook event moves the round back to `running`. Names the
 * dialog only, never pane text.
 */
export const cardRunDialogDataSchema = z.object({
  cardId: cardIdSchema,
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  at: z.iso.datetime(),
  dialog: paneDialogSchema,
});
export type CardRunDialogData = z.infer<typeof cardRunDialogDataSchema>;

export const cardDialogEventDataSchemas = {
  'card_run.dialog': cardRunDialogDataSchema,
} as const;

export type CardDialogEventType = keyof typeof cardDialogEventDataSchemas;

export const isCardDialogEventType = (
  type: string,
): type is CardDialogEventType =>
  Object.hasOwn(cardDialogEventDataSchemas, type);

/**
 * #741: a round's pane shows a usage-limit banner, or (`resumed`) the runner
 * has typed `continue` into it after the limit reset. Sent once per banner
 * and once on resume; the Board shows "waiting for the limit until <time>"
 * from the first and drops it on the second. `resetsAt` is null when the
 * banner shows no reset time that parses, and the runner then never resumes.
 */
export const cardRunQuotaDataSchema = z.object({
  cardId: cardIdSchema,
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  at: z.iso.datetime(),
  limit: quotaLimitSchema,
  resetsAt: z.iso.datetime().nullable(),
  resumed: z.boolean().default(false),
});
export type CardRunQuotaData = z.infer<typeof cardRunQuotaDataSchema>;

export const cardQuotaEventDataSchemas = {
  'card_run.quota': cardRunQuotaDataSchema,
} as const;

export type CardQuotaEventType = keyof typeof cardQuotaEventDataSchemas;

export const isCardQuotaEventType = (
  type: string,
): type is CardQuotaEventType => Object.hasOwn(cardQuotaEventDataSchemas, type);

/**
 * #489 M4: the question selector a round's pane shows now — its text and
 * options, so the Board and Telegram can answer it — or `null` once it is
 * gone. Sent when what the pane shows changes, before the `card_run.question`
 * of a new question. It is session content (ADR-0021): a runner sends it
 * only for a project that ships content.
 */
export const cardRunPendingQuestionDataSchema = z.object({
  cardId: cardIdSchema,
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  at: z.iso.datetime(),
  question: pendingQuestionSchema.nullable(),
});
export type CardRunPendingQuestionData = z.infer<
  typeof cardRunPendingQuestionDataSchema
>;

export const cardPendingQuestionEventDataSchemas = {
  'card_run.pending_question': cardRunPendingQuestionDataSchema,
} as const;

export type CardPendingQuestionEventType =
  keyof typeof cardPendingQuestionEventDataSchemas;

export const isCardPendingQuestionEventType = (
  type: string,
): type is CardPendingQuestionEventType =>
  Object.hasOwn(cardPendingQuestionEventDataSchemas, type);

/**
 * #482: the API refused the round's `finish_card` — `code` is the local
 * error it answered (`not_a_card_session`, `runner_offline`, …). Sent by the
 * runner's local socket for a refused `card.finish` from a session in the
 * worktree of a live round; the API marks the round as needing attention,
 * with the reason, until a later `finish_card` is taken. Never carries the
 * summary: it is content.
 *
 * Its own map, outside `cardRunEventDataSchemas`: the board sink enters it
 * together with its handler.
 */
export const cardRunFinishRefusedDataSchema = z.object({
  cardId: cardIdSchema,
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  at: z.iso.datetime(),
  code: localErrorCodeSchema,
});
export type CardRunFinishRefusedData = z.infer<
  typeof cardRunFinishRefusedDataSchema
>;

export const cardFinishRefusedEventDataSchemas = {
  'card_run.finish_refused': cardRunFinishRefusedDataSchema,
} as const;

export type CardFinishRefusedEventType =
  keyof typeof cardFinishRefusedEventDataSchemas;

export const isCardFinishRefusedEventType = (
  type: string,
): type is CardFinishRefusedEventType =>
  Object.hasOwn(cardFinishRefusedEventDataSchemas, type);
