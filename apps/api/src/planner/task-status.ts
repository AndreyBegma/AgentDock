import type { PlanTaskLiveStatus } from '@nautelle/shared';

/** What the issue cache (#19) holds about an issued task's issue. */
export interface CachedIssueFacts {
  state: 'open' | 'closed';
  labels: readonly string[];
  closedBy: 'pr' | 'manual' | null;
  closingPr: number | null;
}

/** An open pull request that says `Closes #n` for the task's issue. */
export interface ClosingPullRequest {
  number: number;
  url: string;
}

export interface LiveStatusInput {
  /** Null while the cache has not seen the issue yet. */
  issue: CachedIssueFacts | null;
  readyLabel: string;
  /** #19 D3's state of the issue, when computed. */
  queueState: string | null;
  openPr: ClosingPullRequest | null;
  /** When the planner labelled it (D10); the cache may lag behind. */
  queuedAt: Date | null;
}

export interface LiveStatus {
  status: PlanTaskLiveStatus | null;
  /** The pull request the status refers to: the open one, or the one that merged it. */
  prNumber: number | null;
}

/**
 * An issued task's live status (spec "Data / Schema"), never stored. Null:
 * issued but not queued yet — a feature waiting for its docs pull request.
 * The most advanced fact wins: merged, closed, PR open, in flight, queued.
 */
export const liveStatusOf = (input: LiveStatusInput): LiveStatus => {
  const { issue } = input;
  if (issue?.state === 'closed') {
    return issue.closedBy === 'pr'
      ? { status: 'merged', prNumber: issue.closingPr }
      : { status: 'closed', prNumber: null };
  }
  if (input.openPr) {
    return { status: 'pr_open', prNumber: input.openPr.number };
  }
  if (input.queueState === 'in_flight') {
    return { status: 'in_flight', prNumber: null };
  }
  // The cache, once it has the issue, says whether the label is still there.
  const queued = issue
    ? issue.labels.includes(input.readyLabel)
    : input.queuedAt !== null;
  if (queued) {
    return { status: 'queued', prNumber: null };
  }
  return { status: null, prNumber: null };
};
