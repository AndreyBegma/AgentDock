import type { CheckpointKind, PrChecks } from '../protocol';

/**
 * One entry of `gh pr list --json statusCheckRollup`: a check run
 * (`status` + `conclusion`) or a commit status context (`state`).
 */
export interface CheckRollupEntry {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const WAITING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS']);

const verdict = (entry: CheckRollupEntry): 'pass' | 'wait' | 'fail' => {
  const status = entry.status?.toUpperCase();
  if (status && status !== 'COMPLETED') return 'wait';
  const outcome = (entry.conclusion ?? entry.state)?.toUpperCase();
  if (!outcome || WAITING.has(outcome)) return 'wait';
  return PASSING.has(outcome) ? 'pass' : 'fail';
};

/**
 * Rolls a PR's checks up (spec 11 D3): `red` when any check failed (a
 * failure, error, cancellation, timeout, …), else `pending` while any has not
 * finished, else `green` — every conclusion success, neutral or skipped. A PR
 * with no checks at all is `green`.
 */
export const rollupChecks = (
  entries: readonly CheckRollupEntry[],
): PrChecks => {
  let waiting = false;
  for (const entry of entries) {
    const v = verdict(entry);
    if (v === 'fail') return 'red';
    if (v === 'wait') waiting = true;
  }
  return waiting ? 'pending' : 'green';
};

const HEADINGS: readonly [RegExp, CheckpointKind][] = [
  [/^picked up\b/i, 'picked_up'],
  [/^plan ready\b/i, 'plan_ready'],
  [/^implementation done\b/i, 'implementation_done'],
  [/^pull request open\b/i, 'pr_open'],
  [/^blocked\b/i, 'blocked'],
  [/^misclassified\b/i, 'misclassified'],
];

const URL_PATTERN = /https?:\/\/\S+/;

/**
 * Maps a `.orchestrator-reply.md` heading (without `## `) to its checkpoint
 * (spec 11 D5). `pull request open — <url>` also yields the URL. A heading
 * that names no checkpoint is `other`.
 */
export const checkpointFromHeading = (
  heading: string,
): { checkpoint: CheckpointKind; prUrl?: string } => {
  const text = heading.trim();
  const match = HEADINGS.find(([pattern]) => pattern.test(text));
  if (!match) return { checkpoint: 'other' };
  const checkpoint = match[1];
  if (checkpoint !== 'pr_open') return { checkpoint };
  const url = URL_PATTERN.exec(text)?.[0];
  return url ? { checkpoint, prUrl: url } : { checkpoint };
};
