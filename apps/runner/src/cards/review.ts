import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type CardReviewArgs,
  cardIdSchema,
  cardReviewTmuxSessionSchema,
  skillRunIdSchema,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import type { ConfigProfile } from '../config';
import { SESSION_TOKEN_ENV } from '../local/session-tokens';
import { CARD_REVIEW_ENV } from '../mcp/tools';
import type { OtlpEndpoint } from '../otlp/token';
import { gitOk } from '../skills/deps';
import { runEnv } from '../skills/run/launch';
import {
  type LaunchSpec,
  RUN_FILES,
  readJson,
  writeJsonAtomic,
} from '../skills/run/record';
import { commitOf, fetchRef, type GitDeps } from './git';
import { cardArgv, cardEnv } from './launch';
import type { CardWiringFiles } from './wiring';

/**
 * #884: `<parent>/.wt-<repo>-review-<shortId>`, beside the card's own
 * worktree and never it. `review-` is a runner worktree (`NON_SLOT_WORKTREE`).
 */
export const cardReviewWorktreePath = (
  root: string,
  shortId: string,
): string => {
  const trimmed = root.replace(/\/+$/, '');
  return join(dirname(trimmed), `.wt-${basename(trimmed)}-review-${shortId}`);
};

const ENV_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * #884: the `NAUTELLE_CARD` a review session is given — eight `[a-z0-9]`
 * derived from the card's short id, so its test database and its port
 * (`cardPort`) are its own and never the card worker's, which may still be
 * running its tests on the card's. Eight `[a-z0-9]` is what a project's
 * test setup accepts (Nautelle's: `apps/api/src/test`). The same on every
 * review of the card: one review session runs per card at a time.
 */
export const cardReviewEnvId = (shortId: string): string => {
  const digest = createHash('sha256').update(`review:${shortId}`).digest();
  let id = '';
  for (let i = 0; i < 8; i += 1) {
    id += ENV_ID_ALPHABET[(digest[i] ?? 0) % ENV_ID_ALPHABET.length];
  }
  return id;
};

/**
 * #884: what `exec-run` starts in the review's tmux session — a new Claude
 * session (`--session-id`, never a resume), wired like a card round, with
 * the review's own env: the run's id in the OTEL resource attributes (its
 * cost is booked to the `card_review` run), `NAUTELLE_CARD` of its own
 * (`cardReviewEnvId`), `CARD_REVIEW_ENV` (the MCP server offers
 * `report_review`) and the session's token (#113). No Token saver, effort
 * or escalation.
 */
export const cardReviewLaunchSpec = (
  profile: ConfigProfile,
  args: Pick<
    CardReviewArgs,
    | 'session'
    | 'model'
    | 'permissionMode'
    | 'prompt'
    | 'projectId'
    | 'runId'
    | 'shortId'
  >,
  worktree: string,
  otlp: OtlpEndpoint | null,
  wiring?: CardWiringFiles,
  sessionToken?: string,
): LaunchSpec => ({
  ...cardArgv(
    profile,
    {
      session: { id: args.session, resume: false },
      model: args.model,
      permissionMode: args.permissionMode,
      prompt: args.prompt,
    },
    wiring,
  ),
  env: {
    ...runEnv(profile, args, otlp),
    ...cardEnv(cardReviewEnvId(args.shortId)),
    [CARD_REVIEW_ENV]: '1',
    ...(sessionToken ? { [SESSION_TOKEN_ENV]: sessionToken } : {}),
  },
  cwd: worktree,
  interactive: true,
});

/** #884: the review session of a card, `<cardsDir>/<cardId>/review/state.json`. */
export const cardReviewRecordSchema = z.object({
  cardId: cardIdSchema,
  projectId: z.string().min(1),
  root: z.string().min(1),
  runId: skillRunIdSchema,
  sessionId: z.uuid(),
  tmuxSession: cardReviewTmuxSessionSchema,
  worktree: z.string().min(1),
});
export type CardReviewRecord = z.infer<typeof cardReviewRecordSchema>;

/**
 * #884: a card's review on disk — `state.json` and the run's directory
 * (`run.json`, the wiring, `exit.json`) under `<cardDir>/review`, apart from
 * the card's rounds, so neither a round nor a review clears the other's.
 */
export class CardReviewStore {
  /** The cards' directory, `CardStore`'s. */
  constructor(readonly cardsDir: string) {}

  dir(cardId: string): string {
    return join(this.cardsDir, cardIdSchema.parse(cardId), 'review');
  }

  /** A clean directory for the review's run: the last review's files go. */
  createRun(cardId: string, runId: string): string {
    rmSync(this.dir(cardId), { recursive: true, force: true });
    const dir = join(this.dir(cardId), skillRunIdSchema.parse(runId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  save(record: CardReviewRecord): void {
    mkdirSync(this.dir(record.cardId), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir(record.cardId), RUN_FILES.state), record);
  }

  load(cardId: string): CardReviewRecord | null {
    if (!cardIdSchema.safeParse(cardId).success) return null;
    return readJson(
      join(this.dir(cardId), RUN_FILES.state),
      cardReviewRecordSchema,
    );
  }

  /** Every readable review, whether or not its card still has a round. */
  all(): CardReviewRecord[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.cardsDir);
    } catch {
      return [];
    }
    return names
      .map((name) => this.load(name))
      .filter((r): r is CardReviewRecord => r !== null);
  }

  remove(cardId: string): void {
    rmSync(this.dir(cardId), { recursive: true, force: true });
  }
}

const samePath = (a: string, b: string): boolean => {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  return real(a) === real(b);
};

/** Whether `worktree` is a registered worktree of the repository at `root`. */
const isWorktreeOf = async (
  deps: GitDeps,
  root: string,
  worktree: string,
): Promise<boolean> => {
  const listed = await gitOk(deps.exec, [
    '-C',
    root,
    'worktree',
    'list',
    '--porcelain',
  ]);
  return listed
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => samePath(line.slice('worktree '.length), worktree));
};

/**
 * #884: removes the review worktree — `git worktree remove --force`, then
 * `prune`, then whatever directory is left. Answers whether there was one.
 */
export const removeReviewWorktree = async (
  deps: GitDeps,
  root: string,
  worktree: string,
): Promise<boolean> => {
  if (!existsSync(worktree)) {
    await deps.exec('git', ['-C', root, 'worktree', 'prune']);
    return false;
  }
  await deps.exec('git', [
    '-C',
    root,
    'worktree',
    'remove',
    '--force',
    worktree,
  ]);
  await deps.exec('git', ['-C', root, 'worktree', 'prune']);
  rmSync(worktree, { recursive: true, force: true });
  return true;
};

/**
 * #884: puts the review worktree on `headSha`, detached — the PR's head as
 * GitHub has it, whatever the card's branch says locally. `branch` is fetched
 * first (best effort), then the commit itself when that did not bring it; a
 * commit still missing is `null`. An existing review worktree is moved there
 * and cleaned; one that cannot be (or a directory that is no worktree of the
 * repository) is removed and made again.
 */
export const placeReviewWorktree = async (
  deps: GitDeps,
  root: string,
  worktree: string,
  branch: string,
  headSha: string,
): Promise<string | null> => {
  await fetchRef(deps, root, branch);
  let commit = await commitOf(deps, root, headSha);
  if (!commit) {
    await fetchRef(deps, root, headSha);
    commit = await commitOf(deps, root, headSha);
  }
  if (!commit) return null;
  if (existsSync(worktree) && (await isWorktreeOf(deps, root, worktree))) {
    try {
      await gitOk(deps.exec, [
        '-C',
        worktree,
        'checkout',
        '--quiet',
        '--detach',
        '--force',
        commit,
      ]);
      await gitOk(deps.exec, ['-C', worktree, 'clean', '-fdq']);
      return commit;
    } catch {
      // Made again below.
    }
  }
  await removeReviewWorktree(deps, root, worktree);
  await gitOk(deps.exec, [
    '-C',
    root,
    'worktree',
    'add',
    '--quiet',
    '--detach',
    worktree,
    commit,
  ]);
  return commit;
};
