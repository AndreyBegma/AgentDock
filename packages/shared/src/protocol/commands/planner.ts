import { z } from 'zod';
import {
  ATTACHMENTS_PER_CARD_MAX,
  attachmentRefSchema,
} from '../../attachments';
import { tokenSaverConfigSchema } from '../../token-saver/contracts';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import { orchestratorModelSchema } from './control';
import { ISSUE_TITLE_MAX } from './queue';
import {
  gitRefSchema,
  profileKeySchema,
  skillRunIdSchema,
  skillRunShortIdSchema,
} from './skills';

/**
 * Planner commands (docs/specs/172-planner.md "Protocol", D3, D15, D16).
 *
 * `plannerCommands` is defined and exported here, but entered in the
 * `commands` allowlist only together with its runner handlers: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (the skills precedent, spec 24 notes).
 *
 * The prompt travels as a field and reaches `claude -p` on stdin from a file,
 * never as a shell string or an argv element (D16, ADR-0010).
 */

/** D16: the assembled prompt — instructions, contract, action, brief, state, answers. */
export const PLAN_TURN_PROMPT_MAX_BYTES = 256 * 1024;
/** "Configuration": a plan turn's default timeout is 20 min. */
export const PLAN_TURN_DEFAULT_TIMEOUT_SEC = 1200;
export const PLAN_TURN_MIN_TIMEOUT_SEC = 60;
export const PLAN_TURN_MAX_TIMEOUT_SEC = 7200;
/** `plan.queue_issues`: issues labelled in one command. */
export const PLAN_QUEUE_ISSUES_MAX = 50;
/**
 * `plan.publish_specs`: one spec per feature task and, per task with an
 * approved design (spec 223 D16), one file per frame (#441) — a plan has at
 * most 12 tasks, and a design's frames are at most `DESIGN_TOTAL_MAX_BYTES`
 * together (#686) and at most `DESIGN_FRAMES_MAX` (32) in number (DA-07), so
 * every task's frames fit.
 */
export const PLAN_PUBLISH_SPECS_MAX = 12;
export const PLAN_PUBLISH_DESIGNS_MAX = 12 * 32;
export const PLAN_PUBLISH_FILES_MAX =
  PLAN_PUBLISH_SPECS_MAX + PLAN_PUBLISH_DESIGNS_MAX;
export const PLAN_SPEC_FILE_MAX_BYTES = 256 * 1024;
/** Spec 223 "Protocol": an approved mockup, without the pin helper. */
export const PLAN_DESIGN_FILE_MAX_BYTES = 192 * 1024;
export const PLAN_PR_BODY_MAX_BYTES = 64 * 1024;

/** Per-command timeouts. A turn returns once queued; publish commits, pushes and opens a PR. */
export const PLAN_TIMEOUTS_MS = {
  turn: 30_000,
  cancel: 15_000,
  close: 30_000,
  publishSpecs: 180_000,
  queueIssues: 120_000,
} as const;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

const maxBytes = (max: number) =>
  z
    .string()
    .refine((t) => !t.includes('\u0000'), { message: 'must not contain NUL' })
    .refine((t) => utf8Bytes(t) <= max, {
      message: `must be at most ${max} bytes`,
    });

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A plan or turn id (cuid): it names paths and the turn's tmux session. */
export const planIdSchema = skillRunIdSchema;

/** A Claude Code session id (D3): `--session-id`, `--resume`. */
export const planSessionIdSchema = z.uuid();

/**
 * D3. `resume: false` starts the plan's session with `--session-id <id>`.
 * `resume: true` continues it with `--resume <id>`. With `forkFrom`, the turn
 * is a task's first: `--resume <forkFrom> --fork-session --session-id <id>`,
 * so the fork's id is chosen by the API and every later task turn resumes it.
 */
export const planTurnSessionSchema = z
  .strictObject({
    id: planSessionIdSchema,
    resume: z.boolean(),
    forkFrom: planSessionIdSchema.optional(),
  })
  .refine((s) => s.forkFrom === undefined || s.resume, {
    message: 'forkFrom resumes a session: resume must be true',
    path: ['resume'],
  })
  .refine((s) => s.forkFrom !== s.id, {
    message: 'a fork needs its own id',
    path: ['forkFrom'],
  });
export type PlanTurnSession = z.infer<typeof planTurnSessionSchema>;

/**
 * A repository-relative directory (the project's `specDir`): `/`-separated,
 * no leading or trailing `/`, no `\`, no empty, `.` or `..` segment.
 */
export const repoRelativeDirSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.endsWith('/') &&
      !p.includes('\\') &&
      !CONTROL_CHARS.test(p) &&
      p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
    { message: 'must be a relative path without "." or ".." segments' },
  );

/**
 * D10: `<specDir>/<issue>-<slug>.md`, as the runner writes it; and spec 223
 * D16, #441: a design frame, `<specDir>/<issue>-<slug>/design/<variant>/<frame>.html`
 * — or `docs/design/<issue>-<slug>/<variant>/<frame>.html` for a project
 * without a `specDir`, published with `specDir: "docs"`.
 */
export const planSpecFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.includes('..') &&
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !CONTROL_CHARS.test(p) &&
      p.split('/').every((seg) => seg !== '' && seg !== '.'),
    { message: 'must be a relative path without "." or ".." segments' },
  )
  .refine((p) => p.endsWith('.md') || p.endsWith('.html'), {
    message: 'must be a .md or .html file',
  });

/** A design file: `.html` with a `design` directory between `specDir` and the file. */
export const isPlanDesignFilePath = (specDir: string, path: string): boolean =>
  path.endsWith('.html') &&
  path.startsWith(`${specDir}/`) &&
  path
    .slice(specDir.length + 1)
    .split('/')
    .slice(0, -1)
    .includes('design');

/** D10: the docs pull request's branch, one per plan. */
export const planDocsBranchSchema = z
  .string()
  .regex(/^docs\/plan-[a-z0-9]{6,16}$/, 'must be docs/plan-<shortid>');

/** D10: the branch of a plan's docs pull request. */
export const planDocsBranch = (shortId: string): string =>
  `docs/plan-${skillRunShortIdSchema.parse(shortId)}`;

// plan.turn

export const planTurnArgsSchema = z.strictObject({
  planId: planIdSchema,
  turnId: planIdSchema,
  /** The turn's `runs` row (D14): its log relay and cost are keyed by it. */
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  root: absolutePathSchema,
  base: gitRefSchema,
  session: planTurnSessionSchema,
  prompt: maxBytes(PLAN_TURN_PROMPT_MAX_BYTES).refine((p) => p.trim() !== '', {
    message: 'must not be empty',
  }),
  /**
   * #337 D10: the files attached in New Card or in an answer. Before the turn
   * starts, the runner makes `<worktree>/.agentdock/attachments/` hold exactly
   * these — every attachment of the plan so far, in upload order, because the
   * worktree is the plan's for its life and unlisted files are removed — as
   * `card.run` does (#309 D9: download, size and SHA-256 check). A file that
   * cannot be had fails the turn (`attachments_unavailable`) rather than
   * running it blind. Absent is an empty list.
   */
  attachments: z
    .array(attachmentRefSchema)
    .max(ATTACHMENTS_PER_CARD_MAX)
    .refine((list) => new Set(list.map((f) => f.id)).size === list.length, {
      message: 'attachment ids must be distinct',
    })
    .optional(),
  profileKey: profileKeySchema,
  model: orchestratorModelSchema,
  timeoutSec: z
    .number()
    .int()
    .min(PLAN_TURN_MIN_TIMEOUT_SEC)
    .max(PLAN_TURN_MAX_TIMEOUT_SEC),
  /** #445 D11: as on `card.run`. */
  tokenSaver: tokenSaverConfigSchema.optional(),
});
export type PlanTurnArgs = z.infer<typeof planTurnArgsSchema>;

/** The turn outlives the command: progress arrives as `plan_turn.*` events. */
export const planTurnResultSchema = z.object({
  phase: z.enum(['queued', 'running']),
});
export type PlanTurnResult = z.infer<typeof planTurnResultSchema>;

// plan.cancel

/** `projectId` lets the runner refuse a turn of another project (`not_found`). */
export const planCancelArgsSchema = z.strictObject({
  planId: planIdSchema,
  turnId: planIdSchema,
  projectId: z.string().min(1),
});
export type PlanCancelArgs = z.infer<typeof planCancelArgsSchema>;

export const planCancelResultSchema = z.object({ cancelled: z.boolean() });
export type PlanCancelResult = z.infer<typeof planCancelResultSchema>;

// plan.close

export const planCloseArgsSchema = z.strictObject({
  planId: planIdSchema,
  projectId: z.string().min(1),
});
export type PlanCloseArgs = z.infer<typeof planCloseArgsSchema>;

export const planCloseResultSchema = z.object({ removed: z.boolean() });
export type PlanCloseResult = z.infer<typeof planCloseResultSchema>;

// plan.publish_specs

export const planSpecFileSchema = z
  .strictObject({
    path: planSpecFilePathSchema,
    content: maxBytes(PLAN_SPEC_FILE_MAX_BYTES),
  })
  .refine(
    (f) =>
      !f.path.endsWith('.html') ||
      utf8Bytes(f.content) <= PLAN_DESIGN_FILE_MAX_BYTES,
    {
      message: `a design file must be at most ${PLAN_DESIGN_FILE_MAX_BYTES} bytes`,
      path: ['content'],
    },
  );
export type PlanSpecFile = z.infer<typeof planSpecFileSchema>;

/**
 * D10: one docs pull request with exactly `files`, committed without
 * trailers. Every file sits under `specDir` (the project's, repeated here so
 * the schema can hold it), and no two files share a path. Spec 223 D16: up to
 * `PLAN_PUBLISH_SPECS_MAX` `.md` specs and `PLAN_PUBLISH_DESIGNS_MAX` `.html`
 * designs, each design under a `design/` directory.
 */
export const planPublishSpecsArgsSchema = z
  .strictObject({
    planId: planIdSchema,
    projectId: z.string().min(1),
    root: absolutePathSchema,
    base: gitRefSchema,
    specDir: repoRelativeDirSchema,
    branch: planDocsBranchSchema,
    files: z.array(planSpecFileSchema).min(1).max(PLAN_PUBLISH_FILES_MAX),
    title: z.string().trim().min(1).max(ISSUE_TITLE_MAX),
    body: maxBytes(PLAN_PR_BODY_MAX_BYTES),
  })
  .superRefine((a, ctx) => {
    const seen = new Set<string>();
    a.files.forEach((f, i) => {
      if (!f.path.startsWith(`${a.specDir}/`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'path'],
          message: `must be under ${a.specDir}/`,
        });
      }
      if (seen.has(f.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'path'],
          message: 'duplicate path',
        });
      }
      seen.add(f.path);
      if (
        f.path.endsWith('.html') &&
        !isPlanDesignFilePath(a.specDir, f.path)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'path'],
          message: `a design file must sit in a design/ directory under ${a.specDir}/`,
        });
      }
    });
    const designs = a.files.filter((f) => f.path.endsWith('.html')).length;
    if (designs > PLAN_PUBLISH_DESIGNS_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `at most ${PLAN_PUBLISH_DESIGNS_MAX} design files`,
      });
    }
    if (a.files.length - designs > PLAN_PUBLISH_SPECS_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `at most ${PLAN_PUBLISH_SPECS_MAX} spec files`,
      });
    }
  });
export type PlanPublishSpecsArgs = z.infer<typeof planPublishSpecsArgsSchema>;

export const planPublishSpecsResultSchema = z.object({
  prNumber: z.number().int().positive(),
  prUrl: z.url({ protocol: /^https$/ }),
});
export type PlanPublishSpecsResult = z.infer<
  typeof planPublishSpecsResultSchema
>;

// plan.queue_issues

/**
 * D10: `gh issue edit --add-label <readyLabel>` on each issue. `readyLabel`
 * is the project's effective label, as `issue.create` carries it; without it
 * the runner falls back to its own config.
 */
export const planQueueIssuesArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  numbers: z
    .array(z.number().int().positive())
    .min(1)
    .max(PLAN_QUEUE_ISSUES_MAX)
    .refine((ns) => new Set(ns).size === ns.length, {
      message: 'numbers must be unique',
    }),
  readyLabel: z.string().trim().min(1).max(100).optional(),
});
export type PlanQueueIssuesArgs = z.infer<typeof planQueueIssuesArgsSchema>;

export const planQueueIssuesResultSchema = z.object({
  labelled: z.array(z.number().int().positive()).max(PLAN_QUEUE_ISSUES_MAX),
});
export type PlanQueueIssuesResult = z.infer<typeof planQueueIssuesResultSchema>;

/** The five planner commands; all need an operator (D13). */
export const plannerCommands = {
  'plan.turn': {
    args: planTurnArgsSchema,
    result: planTurnResultSchema,
    minRole: 'operator',
    timeoutMs: PLAN_TIMEOUTS_MS.turn,
  },
  'plan.cancel': {
    args: planCancelArgsSchema,
    result: planCancelResultSchema,
    minRole: 'operator',
    timeoutMs: PLAN_TIMEOUTS_MS.cancel,
  },
  'plan.close': {
    args: planCloseArgsSchema,
    result: planCloseResultSchema,
    minRole: 'operator',
    timeoutMs: PLAN_TIMEOUTS_MS.close,
  },
  'plan.publish_specs': {
    args: planPublishSpecsArgsSchema,
    result: planPublishSpecsResultSchema,
    minRole: 'operator',
    timeoutMs: PLAN_TIMEOUTS_MS.publishSpecs,
  },
  'plan.queue_issues': {
    args: planQueueIssuesArgsSchema,
    result: planQueueIssuesResultSchema,
    minRole: 'operator',
    timeoutMs: PLAN_TIMEOUTS_MS.queueIssues,
  },
} as const satisfies Record<string, CommandDefinition>;

export type PlannerCommandName = keyof typeof plannerCommands;
