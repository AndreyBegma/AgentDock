import type { PollableCollector } from '@agentdock/shared/protocol';

/**
 * D8: what a verified GitHub delivery asks AgentDock to do. Pure — the hook
 * service maps it to projects (D7) and sends the polls after the response.
 */
export type GitHubRouting =
  | {
      kind: 'poll';
      /** Lower-cased `repository.full_name`. */
      fullName: string;
      collectors: PollableCollector[];
      /** `push` only: the branch pushed; polled only where it is the project's base. */
      branch: string | null;
    }
  | { kind: 'resync' }
  | { kind: 'ping' }
  | { kind: 'ignore'; reason: string };

/** What the routing reads from a payload, narrowed from `unknown`. */
export interface GitHubPayloadFacts {
  action: string | null;
  fullName: string | null;
  installationId: number | null;
  number: number | null;
  sender: string | null;
  state: string | null;
  ref: string | null;
}

const ISSUE_ACTIONS: ReadonlySet<string> = new Set([
  'opened',
  'edited',
  'closed',
  'reopened',
  'labeled',
  'unlabeled',
  'assigned',
  'unassigned',
]);

const PR_ACTIONS: ReadonlySet<string> = new Set([
  'opened',
  'synchronize',
  'closed',
  'reopened',
  'ready_for_review',
  'edited',
  'labeled',
  'unlabeled',
]);

const REVIEW_ACTIONS: ReadonlySet<string> = new Set(['submitted', 'dismissed']);

/** Events that only ever touch pull requests' checks (D8): every action counts. */
const CHECK_EVENTS: ReadonlySet<string> = new Set([
  'check_suite',
  'check_run',
  'status',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

/** The few fields D8–D10 read; anything missing or mistyped is null. */
export const payloadFacts = (
  event: string,
  payload: unknown,
): GitHubPayloadFacts => {
  const fullName = str(field(field(payload, 'repository'), 'full_name'));
  const subject =
    event === 'issues'
      ? field(payload, 'issue')
      : event === 'pull_request' || event === 'pull_request_review'
        ? field(payload, 'pull_request')
        : event === 'check_run'
          ? field(payload, 'check_run')
          : event === 'check_suite'
            ? field(payload, 'check_suite')
            : undefined;
  const state =
    str(field(subject, 'state')) ??
    str(field(subject, 'conclusion')) ??
    str(field(subject, 'status')) ??
    (event === 'status' ? str(field(payload, 'state')) : null) ??
    (event === 'pull_request_review'
      ? str(field(field(payload, 'review'), 'state'))
      : null);
  return {
    action: str(field(payload, 'action')),
    fullName: fullName?.toLowerCase() ?? null,
    installationId: int(field(field(payload, 'installation'), 'id')),
    number: int(field(subject, 'number')),
    sender: str(field(field(payload, 'sender'), 'login')),
    state,
    ref: str(field(payload, 'ref')),
  };
};

const BRANCH_REF = 'refs/heads/';

/** D8's table. */
export const routeGitHubEvent = (
  event: string,
  facts: GitHubPayloadFacts,
): GitHubRouting => {
  if (event === 'ping') return { kind: 'ping' };
  if (event === 'installation' || event === 'installation_repositories')
    return { kind: 'resync' };

  const { fullName, action } = facts;
  if (!fullName) return { kind: 'ignore', reason: 'no_repository' };
  const poll = (
    collectors: PollableCollector[],
    branch: string | null = null,
  ): GitHubRouting => ({ kind: 'poll', fullName, collectors, branch });

  switch (event) {
    case 'issues':
      return action && ISSUE_ACTIONS.has(action)
        ? poll(['issues'])
        : { kind: 'ignore', reason: 'action' };
    case 'pull_request':
      return action && PR_ACTIONS.has(action)
        ? poll(['prs'])
        : { kind: 'ignore', reason: 'action' };
    case 'pull_request_review':
      return action && REVIEW_ACTIONS.has(action)
        ? poll(['prs'])
        : { kind: 'ignore', reason: 'action' };
    case 'push': {
      const ref = facts.ref;
      if (!ref?.startsWith(BRANCH_REF))
        return { kind: 'ignore', reason: 'not_a_branch' };
      return poll(['prs', 'worktrees'], ref.slice(BRANCH_REF.length));
    }
    default:
      return CHECK_EVENTS.has(event)
        ? poll(['prs'])
        : { kind: 'ignore', reason: 'event' };
  }
};

/** D9 (spec notes): the `events` row type — `github.<event>`, never a runner type. */
export const githubEventType = (event: string): string => `github.${event}`;

/** D9: the small `data` of that row. Payload bodies are not stored. */
export const githubEventData = (
  facts: GitHubPayloadFacts,
): Record<string, string | number> => {
  const data: Record<string, string | number> = {};
  if (facts.action) data.action = facts.action;
  if (facts.number !== null) data.number = facts.number;
  if (facts.sender) data.sender = facts.sender;
  if (facts.state) data.state = facts.state;
  if (facts.ref) data.ref = facts.ref;
  return data;
};
