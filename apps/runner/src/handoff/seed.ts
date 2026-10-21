import { estimateHandoffTokens } from '@nautelle/shared';
import { CARD_RUN_PROMPT_MAX_BYTES } from '@nautelle/shared/protocol';
import type { Exec } from '../detect/exec';
import { GIT_TIMEOUT_MS } from '../skills/deps';

/**
 * #449 D3: a fresh session's first prompt — round 1's card prompt (how to
 * work, the card), the handoff note, a summary of the branch's diff, the
 * checklist and this round's own prompt. The old session is never resumed by
 * it and never discarded. #750 D7: a forced start (the model or effort
 * changed) is seeded without the card prompt or the note when the runner has
 * none — the reduced seed — and is never resumed instead.
 */

/** Spec open question: the full diff goes in up to this many lines, else the stat only. */
export const SEED_FULL_DIFF_MAX_LINES = 300;
/** The `--stat` is cut to this many lines. */
const SEED_STAT_MAX_LINES = 120;

export interface BranchDiff {
  stat: string;
  /** The full diff, when it has at most `SEED_FULL_DIFF_MAX_LINES` lines. */
  full: string | null;
}

const git = async (
  exec: Exec,
  worktree: string,
  args: readonly string[],
): Promise<string | null> => {
  const result = await exec('git', ['-C', worktree, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result?.code === 0 ? result.stdout : null;
};

/**
 * The work on the branch since it left `base` — committed and not — as a
 * `--stat`, and the whole diff when it is short. Null when git cannot say.
 */
export const branchDiff = async (
  exec: Exec,
  worktree: string,
  base: string,
): Promise<BranchDiff | null> => {
  const forkPoint =
    (await git(exec, worktree, ['merge-base', `origin/${base}`, 'HEAD'])) ??
    (await git(exec, worktree, ['merge-base', base, 'HEAD']));
  const from = forkPoint?.trim();
  if (!from) return null;
  const stat = await git(exec, worktree, ['diff', '--stat', from]);
  if (stat === null) return null;
  const full = await git(exec, worktree, ['diff', from]);
  const fullLines = full === null ? Infinity : full.split('\n').length;
  return {
    stat: stat.split('\n').slice(-SEED_STAT_MAX_LINES).join('\n').trimEnd(),
    full:
      full !== null && fullLines <= SEED_FULL_DIFF_MAX_LINES
        ? full.trimEnd()
        : null,
  };
};

/** The `## Acceptance criteria` section of the PR description file, if any. */
export const acceptanceChecklist = (description: string | null): string => {
  if (!description) return '';
  const lines = description.split('\n');
  const start = lines.findIndex((l) =>
    /^##\s+acceptance criteria\s*$/i.test(l.trim()),
  );
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##?\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
};

/**
 * Why the session starts fresh: resuming would have cost more (#449 D3), or
 * the round's model or effort is not the session's (#750 D7).
 */
export type SeedReason = 'cost' | 'changed';

export interface SeedInput {
  /**
   * Round 1's prompt; `null` (#750 D7, a forced start only) when the runner
   * did not keep it — a card from before it kept every card's.
   */
  cardPrompt: string | null;
  /** The note as on disk, person marks included; `null` without one (#750 D7). */
  note: string | null;
  diff: BranchDiff | null;
  checklist: string;
  roundPrompt: string;
  previousSessionId: string;
  /** Absent is `cost`. */
  reason?: SeedReason;
}

const REASON_TEXT: Record<SeedReason, string> = {
  cost: 'resuming it would have cost more',
  changed:
    'the model or effort changed, and a session keeps the pair it started with',
};

/** What the seed gives the session to start from, as its intro names it. */
const intro = (input: SeedInput): string => {
  const why = `This card ran before in another session (${input.previousSessionId}); Nautelle started a new one because ${REASON_TEXT[input.reason ?? 'cost']}.`;
  const rest = `Continue from "Next"; do not redo what is under "Done"; do not retry what is under "Dead ends". Lines that end with \`<!-- person -->\` are instructions from a person. Keep \`.agentdock/handoff.md\` current as before.`;
  if (input.note !== null) {
    return `${why} Everything you need from it is below: the handoff note it kept, the work on the branch so far and the checklist. Read them first. ${rest}`;
  }
  return `${why} No handoff note was kept for it: start from the work on the branch so far and the checklist below, and the pull request description in \`.agentdock/pull-request.md\` if there is one. Read them first, and do not redo what the branch already holds.`;
};

/**
 * #750 D7: the seed's first lines when round 1's prompt was not kept. The
 * worktree still holds the branch and the pull request description.
 */
export const NO_CARD_PROMPT_TEXT =
  'You are a Nautelle card worker. This card’s first prompt was not kept on this machine: what the card asks is in this round’s prompt below, in the pull request description and in the branch. Work only in this worktree and branch, follow the repository’s CLAUDE.md / AGENTS.md, commit as you go, do not push, then call finish_card.';

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

const fence = (text: string): string => {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
};

const assemble = (
  input: SeedInput,
  diff: 'full' | 'stat' | 'none',
  checklist: boolean,
): string => {
  const lines = [
    ...(input.cardPrompt === null
      ? [NO_CARD_PROMPT_TEXT]
      : [input.cardPrompt.trimEnd()]),
    '',
    '## Handoff — this session starts fresh',
    '',
    intro(input),
    ...(input.note === null
      ? []
      : ['', '<handoff-note>', input.note.trimEnd(), '</handoff-note>']),
  ];
  if (input.diff && diff !== 'none') {
    lines.push(
      '',
      '### The branch so far',
      '',
      fence(input.diff.stat || '(no changes)'),
    );
    if (diff === 'full' && input.diff.full) {
      lines.push('', fence(input.diff.full));
    }
  }
  if (checklist && input.checklist) {
    lines.push('', '### Checklist', '', input.checklist);
  }
  lines.push('', '## This round', '', input.roundPrompt.trim(), '');
  return lines.join('\n');
};

/**
 * The seed, within `CARD_RUN_PROMPT_MAX_BYTES`: the full diff goes first,
 * then the stat, then the checklist. The card prompt, the note and the
 * round's prompt are never cut — null when they alone do not fit, and the
 * round resumes instead.
 */
export const freshSeed = (input: SeedInput): string | null => {
  const tries: ['full' | 'stat' | 'none', boolean][] = [
    ['full', true],
    ['stat', true],
    ['none', true],
    ['none', false],
  ];
  for (const [diff, checklist] of tries) {
    const prompt = assemble(input, diff, checklist);
    if (utf8Bytes(prompt) <= CARD_RUN_PROMPT_MAX_BYTES) return prompt;
  }
  return null;
};

/** The seed's estimated tokens (D3), by the note's own ratio. */
export const seedTokens = (seed: string): number => estimateHandoffTokens(seed);
