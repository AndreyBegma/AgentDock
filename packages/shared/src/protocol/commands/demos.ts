import { z } from 'zod';
import {
  DEMO_SECRETS_MAX,
  demoIdSchema,
  demoScenarioPathSchema,
  demoSecretNameSchema,
} from '../../demos/contracts';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import { cardIdSchema, cardShortIdSchema } from './cards';

/**
 * Demo videos of finished cards (C-368, ADR-0090). `card.demo` asks the
 * project's runner to record the card's DemoFlow scenario in the card's
 * worktree: the runner provisions DemoFlow itself (a pinned version through
 * npx, `demoflow setup` for Chromium), starts the app from the repository's
 * `demoflow.config.json` on a free port it assigns, runs the scenario,
 * uploads the video to `runnerDemoVideoPath` and reports `demo.status`.
 *
 * `env` names the Demo env secrets only; the runner reads their values from
 * `runnerDemoEnvPath` over HTTPS and hands them to the `demoflow` process
 * environment. A value is never in a socket payload.
 *
 * As `card.run`, no argument is a path the runner trusts as given: `root` is
 * checked against the watched project, the worktree is derived from
 * `shortId`, and `scenario` is repository-relative under `demoflow/cards/`.
 *
 * The runner's handler answers `unsupported` until it records (S-12 stage 2);
 * the API sends the command only to a runner that advertises it.
 */

/** The command returns once the recording is queued on the runner. */
export const CARD_DEMO_COMMAND_TIMEOUT_MS = 15_000;

export const cardDemoArgsSchema = z
  .strictObject({
    cardId: cardIdSchema,
    projectId: z.string().min(1),
    /** The card's per-project number, for the upload and env paths. */
    card: z.number().int().positive(),
    /** The round whose code the video shows. */
    round: z.number().int().positive(),
    demoId: demoIdSchema,
    /** The card's worktree `<parent>/.wt-<repo>-card-<shortId>` of `root`. */
    worktree: z.strictObject({
      root: absolutePathSchema,
      shortId: cardShortIdSchema,
    }),
    scenario: demoScenarioPathSchema,
    /** Names of the Demo env secrets to read from `runnerDemoEnvPath`. */
    env: z.array(demoSecretNameSchema).max(DEMO_SECRETS_MAX),
  })
  .refine((a) => new Set(a.env).size === a.env.length, {
    message: 'env names must be distinct',
    path: ['env'],
  });
export type CardDemoArgs = z.infer<typeof cardDemoArgsSchema>;

export const cardDemoResultSchema = z.object({
  status: z.enum(['queued', 'recording']),
});
export type CardDemoResult = z.infer<typeof cardDemoResultSchema>;

export const demoCommands = {
  'card.demo': {
    args: cardDemoArgsSchema,
    result: cardDemoResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_DEMO_COMMAND_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;

export type DemoCommandName = keyof typeof demoCommands;
