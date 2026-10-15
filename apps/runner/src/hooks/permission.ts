import {
  ACTION_REQUEST_HOOK_WAIT_MS,
  ACTION_REQUEST_POLL_MS,
  ACTION_REQUEST_SUMMARY_MAX,
  type ActionRequestSummary,
} from '@agentdock/shared';
import type { LocalErrorCode } from '@agentdock/shared/protocol';
import type { LocalClient } from '../local/client';

/**
 * The `PermissionRequest` hook's output (spec 201 D17), as documented under
 * "PermissionRequest decision control" at https://code.claude.com/docs/en/hooks
 * (read 2026-10-14): `hookSpecificOutput.decision.behavior` is `allow` or
 * `deny`; `message` is for `deny` only and tells Claude why. Printing
 * nothing leaves the permission flow unchanged: the local dialog shows.
 */
export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

export const permissionOutput = (decision: PermissionDecision): string =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });

/** The deny message when the approver left no note. */
export const DEFAULT_DENY_MESSAGE = 'Denied remotely in AgentDock.';

/** Polling errors in a row after which the hook gives up and the dialog shows. */
export const MAX_POLL_FAILURES = 3;

const TRANSIENT: ReadonlySet<LocalErrorCode> = new Set([
  'runner_offline',
  'timeout',
  'internal',
]);

export interface PermissionDeps {
  client: LocalClient;
  cwd: string;
  sessionId: string;
  toolName: string;
  /** The raw tool input; the daemon drops or redacts it (D17). */
  toolInput?: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const summaryFor = (toolName: string): string =>
  `Allow ${toolName} in an unattended Claude Code session`.slice(
    0,
    ACTION_REQUEST_SUMMARY_MAX,
  );

const decisionOf = (
  request: ActionRequestSummary,
): PermissionDecision | 'wait' | null => {
  switch (request.status) {
    case 'approved':
    case 'executed':
      return { behavior: 'allow' };
    case 'denied':
      return {
        behavior: 'deny',
        message: request.note?.trim() || DEFAULT_DENY_MESSAGE,
      };
    case 'pending':
      return 'wait';
    case 'expired':
    case 'failed':
      return null;
  }
};

/**
 * Away mode (D17): files a `tool_use` action request and polls its status
 * every `ACTION_REQUEST_POLL_MS` for up to `ACTION_REQUEST_HOOK_WAIT_MS`.
 * Approved → allow; denied → deny with the note; expired, offline, or no
 * answer in time → null, and the local dialog shows.
 */
export const awaitRemoteDecision = async (
  deps: PermissionDeps,
): Promise<PermissionDecision | null> => {
  const context = {
    via: 'hook' as const,
    cwd: deps.cwd,
    sessionId: deps.sessionId,
  };
  const created = await deps.client.request(
    'action.request',
    {
      kind: 'tool_use',
      args: {
        toolName: deps.toolName,
        ...(deps.toolInput ? { input: deps.toolInput } : {}),
      },
      summary: summaryFor(deps.toolName),
    },
    context,
  );
  if (!created.ok) return null;
  const first = decisionOf(created.data);
  if (first !== 'wait') return first;

  const deadline = deps.now() + ACTION_REQUEST_HOOK_WAIT_MS;
  let failures = 0;
  while (deps.now() + ACTION_REQUEST_POLL_MS <= deadline) {
    await deps.sleep(ACTION_REQUEST_POLL_MS);
    const status = await deps.client.request(
      'action.status',
      { id: created.data.id },
      context,
    );
    if (!status.ok) {
      if (!TRANSIENT.has(status.error.code)) return null;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) return null;
      continue;
    }
    failures = 0;
    const decision = decisionOf(status.data);
    if (decision !== 'wait') return decision;
  }
  return null;
};
