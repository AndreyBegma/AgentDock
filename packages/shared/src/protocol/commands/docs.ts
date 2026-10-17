import { z } from 'zod';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema, repoNameSchema } from '../projects';
import {
  PLAN_PR_BODY_MAX_BYTES,
  PLAN_PUBLISH_SPECS_MAX,
  planSpecFileSchema,
  repoRelativeDirSchema,
} from './planner';
import { ISSUE_TITLE_MAX } from './queue';
import { skillRunShortIdSchema } from './skills';

/**
 * Docs-repository commands (#379, ADR-0036). A project whose documentation
 * lives in a separate repository (ADR-0012 `sibling_repo`, or `remote_repo`
 * with a local clone) gets its specs through a pull request in that
 * repository. The API never touches the docs files (ADR-0001): it names the
 * clone, and the runner checks that it is the top of a git repository with a
 * GitHub remote before it writes anything.
 */

/** Publish commits, pushes and opens a PR; the state is one `gh pr view`. */
export const DOCS_TIMEOUTS_MS = {
  publishSpecs: 180_000,
  prState: 30_000,
} as const;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * The docs pull request's branch: `docs/plan-<shortid>` for a plan (spec 172
 * D10), `docs/card-<shortid>` for a board card.
 */
export const docsSpecBranchSchema = z
  .string()
  .regex(
    /^docs\/(plan|card)-[a-z0-9]{6,16}$/,
    'must be docs/plan-<shortid> or docs/card-<shortid>',
  );

/** A board card's docs branch, one per card. */
export const cardDocsBranch = (shortId: string): string =>
  `docs/card-${skillRunShortIdSchema.parse(shortId)}`;

const docsTarget = {
  projectId: z.string().min(1),
  /** The code repository's root, checked against the watched project. */
  root: absolutePathSchema,
  /** The docs repository's local clone: the top of a git repository. */
  docsRoot: absolutePathSchema,
};

// docs.publish_specs

/**
 * One pull request into the docs repository's default branch with exactly
 * `files`, each a `.md` spec under `specDir` (relative to `docsRoot`),
 * committed without trailers. Designs are not published here: they stay in
 * the code repository (#379 "Out of scope"). A retry after the PR was opened
 * answers that PR.
 */
export const docsPublishSpecsArgsSchema = z
  .strictObject({
    ...docsTarget,
    specDir: repoRelativeDirSchema,
    branch: docsSpecBranchSchema,
    files: z.array(planSpecFileSchema).min(1).max(PLAN_PUBLISH_SPECS_MAX),
    title: z.string().trim().min(1).max(ISSUE_TITLE_MAX),
    body: z
      .string()
      .refine((t) => !t.includes('\u0000'), { message: 'must not contain NUL' })
      .refine((t) => utf8Bytes(t) <= PLAN_PR_BODY_MAX_BYTES, {
        message: `must be at most ${PLAN_PR_BODY_MAX_BYTES} bytes`,
      }),
  })
  .superRefine((a, ctx) => {
    const seen = new Set<string>();
    a.files.forEach((f, i) => {
      if (!f.path.startsWith(`${a.specDir}/`) || !f.path.endsWith('.md')) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'path'],
          message: `must be a .md file under ${a.specDir}/`,
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
    });
    if (a.docsRoot.replace(/\/+$/, '') === a.root.replace(/\/+$/, '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['docsRoot'],
        message: 'must not be the code repository: use plan.publish_specs',
      });
    }
  });
export type DocsPublishSpecsArgs = z.infer<typeof docsPublishSpecsArgsSchema>;

export const docsPublishSpecsResultSchema = z.object({
  /** `owner/name` of the docs repository, read from the clone's origin. */
  repo: repoNameSchema,
  prNumber: z.number().int().positive(),
  prUrl: z.url({ protocol: /^https$/ }),
});
export type DocsPublishSpecsResult = z.infer<
  typeof docsPublishSpecsResultSchema
>;

// docs.pr_state

/**
 * The state of a docs pull request. The runner's PR collector watches only
 * the code repository, so the API asks for a docs PR it waits on.
 */
export const docsPrStateArgsSchema = z.strictObject({
  ...docsTarget,
  pr: z.number().int().positive(),
});
export type DocsPrStateArgs = z.infer<typeof docsPrStateArgsSchema>;

export const docsPrStateResultSchema = z.object({
  state: z.enum(['open', 'merged', 'closed']),
});
export type DocsPrStateResult = z.infer<typeof docsPrStateResultSchema>;

/** Both need an operator, as `plan.publish_specs` does. */
export const docsCommands = {
  'docs.publish_specs': {
    args: docsPublishSpecsArgsSchema,
    result: docsPublishSpecsResultSchema,
    minRole: 'operator',
    timeoutMs: DOCS_TIMEOUTS_MS.publishSpecs,
  },
  'docs.pr_state': {
    args: docsPrStateArgsSchema,
    result: docsPrStateResultSchema,
    minRole: 'operator',
    timeoutMs: DOCS_TIMEOUTS_MS.prState,
  },
} as const satisfies Record<string, CommandDefinition>;

export type DocsCommandName = keyof typeof docsCommands;
