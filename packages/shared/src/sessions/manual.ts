import { z } from 'zod';
import {
  HOOK_CONTENT_MAX_CHARS,
  HOOK_PERMISSION_REQUESTED_EVENT,
  HOOK_PROMPT_SUBMITTED_EVENT,
  HOOK_SESSION_ENDED_EVENT,
  HOOK_SESSION_STARTED_EVENT,
  HOOK_STOPPED_EVENT,
  type HookEventType,
} from '../protocol/events/hooks';

/**
 * Sessions started by hand and seen through the `agentdock` Claude Code plugin
 * (docs/specs/201-claude-code-integration.md D14, ADR-0021).
 */

/**
 * Where a session came from, set on ingest: `worker` has a slot, `run` is
 * claimed by a Run, `manual` sent a `hook.*` event and is neither, `unknown`
 * is everything else (transcript only).
 */
export const sessionOriginSchema = z.enum([
  'unknown',
  'worker',
  'run',
  'manual',
]);
export type SessionOrigin = z.infer<typeof sessionOriginSchema>;
export const SESSION_ORIGINS = sessionOriginSchema.options;

/** What the session is doing now, from its latest hook event. */
export const sessionLiveStateSchema = z.enum([
  'idle',
  'working',
  'waiting',
  'ended',
]);
export type SessionLiveState = z.infer<typeof sessionLiveStateSchema>;

/**
 * The live state a hook event moves the session to, or null when the event
 * does not change it (tool results, notifications).
 */
export const liveStateAfter = (
  type: HookEventType,
): SessionLiveState | null => {
  switch (type) {
    case HOOK_SESSION_STARTED_EVENT:
    case HOOK_STOPPED_EVENT:
      return 'idle';
    case HOOK_PROMPT_SUBMITTED_EVENT:
      return 'working';
    case HOOK_PERMISSION_REQUESTED_EVENT:
      return 'waiting';
    case HOOK_SESSION_ENDED_EVENT:
      return 'ended';
    default:
      return null;
  }
};

/**
 * Picks the origin from what ingest knows. A slot always wins, so a fleet
 * worker that also fires the plugin's hooks stays `worker`.
 */
export const sessionOriginOf = (args: {
  slotName: string | null;
  claimedByRun: boolean;
  sawHookEvent: boolean;
}): SessionOrigin => {
  if (args.slotName) return 'worker';
  if (args.claimedByRun) return 'run';
  if (args.sawHookEvent) return 'manual';
  return 'unknown';
};

/** `feat/184-grill-rounds` → 184: the repository's branch convention. */
const BRANCH_ISSUE = /^[a-z]+\/(\d+)-/;

/** The issue a branch names, or null. */
export const issueFromBranch = (
  branch: string | null | undefined,
): number | null => {
  if (!branch) return null;
  const match = BRANCH_ISSUE.exec(branch);
  if (!match) return null;
  const issue = Number(match[1]);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : null;
};

// Content (ADR-0021)

export const sessionContentKindSchema = z.enum([
  'prompt',
  'response',
  'tool_input',
  'tool_output',
]);
export type SessionContentKind = z.infer<typeof sessionContentKindSchema>;

/** Characters of one content text after redaction; longer is cut and marked. */
export const SESSION_CONTENT_MAX_CHARS = HOOK_CONTENT_MAX_CHARS;

export const SESSION_CONTENT_RETENTION_DAYS = {
  min: 1,
  max: 365,
  default: 30,
} as const;

/** One stored content row, as `GET …/sessions/:id/content` returns it. */
export interface SessionContentItem {
  id: string;
  kind: SessionContentKind;
  toolUseId: string | null;
  toolName: string | null;
  at: string;
  text: string;
  truncated: boolean;
}

export interface SessionContentPage {
  items: SessionContentItem[];
  nextCursor: string | null;
}

export const SESSION_CONTENT_PAGE_LIMIT = 200;
