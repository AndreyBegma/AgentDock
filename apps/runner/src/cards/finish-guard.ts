import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_PR_DESCRIPTION_FILE } from '@nautelle/shared';
import type { CardRunArgs, LocalErrorCode } from '@nautelle/shared/protocol';

/**
 * #445 D8: the artifact guard on `finish_card`. A card round launched with
 * Token saver on is recorded as guarded (`CardRecord.finishGuard`); the
 * daemon, on its side of the local socket, checks the worker's pull request
 * description and summary before it relays `card.finish` (DR-10) — a process
 * that calls the socket directly meets the same guard. The rejections are
 * counted per round, and `artifactIncomplete` is only ever the guard's
 * (DA-18).
 */
/** D8: after this many rejections in a round the finish is accepted. */
export const FINISH_GUARD_MAX_REJECTIONS = 2;

/** The headings the description must carry (worker prompt, #359 D3). */
export const FINISH_GUARD_SECTIONS = [
  '## What changed and why',
  '## Acceptance criteria',
] as const;

/** The tool error code of a refused finish. */
export const ARTIFACT_INCOMPLETE =
  'artifact_incomplete' satisfies LocalErrorCode;

/**
 * The card's issue, which `card.run` does not carry as a field: the draft
 * pull request body's `Closes #n` (the API writes it when the card has an
 * issue), else round 1's `GitHub issue: #n` prompt line. `null` when neither
 * says — the guard then does not ask for `Closes`.
 */
export const cardIssueNumber = (
  args: Pick<CardRunArgs, 'pullRequest' | 'prompt'>,
): number | null => {
  const found =
    args.pullRequest?.body.match(/^Closes #(\d+)\s*$/m) ??
    args.prompt.match(/^GitHub issue: #(\d+)\s*$/m);
  return found ? Number(found[1]) : null;
};

export interface FinishGuardOptions {
  issueNumber: number | null;
}

/**
 * Marks the round guarded when it launches with Token saver on, with the
 * card's issue; clears it otherwise.
 */
export const guardFinish = (
  record: { finishGuard?: FinishGuardOptions },
  tokenSaver: unknown,
  args: Pick<CardRunArgs, 'pullRequest' | 'prompt'>,
): void => {
  if (tokenSaver) {
    record.finishGuard = { issueNumber: cardIssueNumber(args) };
  } else {
    delete record.finishGuard;
  }
};

/** Sentences: text ending in `.`, `!` or `?` (or the end), at least one letter or digit. */
const sentenceCount = (text: string): number =>
  text.split(/[.!?]+(?:\s+|$)/).filter((part) => /[\p{L}\p{N}]/u.test(part))
    .length;

const hasHeading = (markdown: string, heading: string): boolean =>
  markdown
    .split('\n')
    .some((line) => line.trim().toLowerCase() === heading.toLowerCase());

/**
 * D8: what a finish is missing, in a fixed order; empty when it is complete.
 * `description` is the file's text, `null` when there is none.
 */
export const missingArtifacts = (
  description: string | null,
  summary: string,
  issueNumber: number | null,
): string[] => {
  const missing: string[] = [];
  if (description === null || description.trim() === '') {
    missing.push(`${CARD_PR_DESCRIPTION_FILE} (the file is missing or empty)`);
  } else {
    if (
      issueNumber !== null &&
      !new RegExp(`(^|\\s)Closes #${issueNumber}\\b`).test(description)
    ) {
      missing.push(`\`Closes #${issueNumber}\` in ${CARD_PR_DESCRIPTION_FILE}`);
    }
    for (const heading of FINISH_GUARD_SECTIONS) {
      if (!hasHeading(description, heading)) {
        missing.push(`\`${heading}\` in ${CARD_PR_DESCRIPTION_FILE}`);
      }
    }
  }
  if (sentenceCount(summary) < 2) {
    missing.push(
      'a summary of at least 2 sentences: what changed and how you checked it',
    );
  }
  return missing;
};

/** What the guard decides for one `finish_card` call. */
export type FinishGuardDecision =
  | { kind: 'accept'; artifactIncomplete: boolean }
  | { kind: 'reject'; message: string };

/** The description file in the session's worktree; `null` when unreadable. */
export const readDescription = (worktree: string): string | null => {
  try {
    return readFileSync(join(worktree, CARD_PR_DESCRIPTION_FILE), 'utf8');
  } catch {
    return null;
  }
};

/**
 * D8: refuses an incomplete finish with what is missing, twice; the third
 * attempt is accepted with `artifactIncomplete: true`. A complete finish is
 * always accepted as is.
 */
export class FinishGuard {
  private rejections = 0;

  constructor(
    private readonly options: FinishGuardOptions & {
      worktree: string;
      read?: (worktree: string) => string | null;
    },
  ) {}

  check(summary: string): FinishGuardDecision {
    const read = this.options.read ?? readDescription;
    const missing = missingArtifacts(
      read(this.options.worktree),
      summary,
      this.options.issueNumber,
    );
    if (missing.length === 0) {
      return { kind: 'accept', artifactIncomplete: false };
    }
    if (this.rejections >= FINISH_GUARD_MAX_REJECTIONS) {
      return { kind: 'accept', artifactIncomplete: true };
    }
    this.rejections += 1;
    return {
      kind: 'reject',
      message: [
        'The card is not finished: the pull request description or the summary is incomplete. Missing:',
        ...missing.map((m) => `- ${m}`),
        `Write what is missing — full sentences, every required section — then call finish_card again.`,
      ].join('\n'),
    };
  }
}
