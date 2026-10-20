import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_PR_DESCRIPTION_FILE } from '@nautelle/shared';
import type { CardRunArgs } from '@nautelle/shared/protocol';

/**
 * #445 D8: the artifact guard on `finish_card`. A card launched with Token
 * saver on starts its `agentdock` MCP server as `mcp --finish-guard
 * [--issue <n>]`; that server checks the worker's pull request description
 * and summary before it relays `card.finish`. One MCP process lives as long
 * as one claude process — one round — so the rejections are counted there.
 */
export const FINISH_GUARD_FLAG = '--finish-guard';
export const FINISH_GUARD_ISSUE_FLAG = '--issue';

/** D8: after this many rejections in a round the finish is accepted. */
export const FINISH_GUARD_MAX_REJECTIONS = 2;

/** The headings the description must carry (worker prompt, #359 D3). */
export const FINISH_GUARD_SECTIONS = [
  '## What changed and why',
  '## Acceptance criteria',
] as const;

/** The tool error code of a refused finish. */
export const ARTIFACT_INCOMPLETE = 'artifact_incomplete';

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

/** The arguments after `mcp` for a guarded card round. */
export const finishGuardArgs = (issueNumber: number | null): string[] => [
  FINISH_GUARD_FLAG,
  ...(issueNumber === null
    ? []
    : [FINISH_GUARD_ISSUE_FLAG, String(issueNumber)]),
];

export interface FinishGuardOptions {
  issueNumber: number | null;
}

/** `mcp`'s own arguments: the guard, or `null` without `--finish-guard`. */
export const parseFinishGuardArgs = (
  args: readonly string[],
): FinishGuardOptions | null => {
  if (!args.includes(FINISH_GUARD_FLAG)) return null;
  const at = args.indexOf(FINISH_GUARD_ISSUE_FLAG);
  const value = at === -1 ? undefined : args[at + 1];
  const issueNumber =
    value !== undefined && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null;
  return { issueNumber };
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
