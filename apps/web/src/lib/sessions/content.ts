import type {
  ProjectMemberView,
  Role,
  SessionContentItem,
  SessionContentKind,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';

export const CONTENT_KIND_LABEL: Record<SessionContentKind, string> = {
  prompt: 'Prompt',
  tool_input: 'Tool input',
  tool_output: 'Tool output',
  response: 'Response',
};

/**
 * Every project member reads content (ADR-0050); the API answers 404 to a
 * non-member, so the page does not ask without a role.
 */
export const canReadContent = (role: Role | undefined): boolean =>
  role !== undefined;

/** `GET /projects/:projectId/sessions/:id/content`, with the cursor when paging. */
export const contentPath = (
  projectId: string,
  sessionId: string,
  cursor?: string | null,
): string => {
  const base = `/projects/${projectId}/sessions/${sessionId}/content`;
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
};

/**
 * The issue's page on GitHub, or null when the project's `repo` is not the
 * `owner/name` form (the link is never built from anything else).
 */
export const issueUrl = (
  repo: string | undefined,
  issue: number,
): string | null =>
  repo && /^[\w.-]+\/[\w.-]+$/.test(repo)
    ? `https://github.com/${repo}/issues/${issue}`
    : null;

/** "Tool input · Bash" — the tool name only where the row has one. */
export const contentTitle = (item: SessionContentItem): string =>
  item.toolName
    ? `${CONTENT_KIND_LABEL[item.kind]} · ${item.toolName}`
    : CONTENT_KIND_LABEL[item.kind];

/**
 * Who owns a manual session: "You" for the caller, the member's email, and the
 * start of the id for an owner who is no longer a member.
 */
export const ownerLabel = (
  ownerId: string,
  currentUserId: string,
  members: readonly Pick<ProjectMemberView, 'userId' | 'email'>[] | undefined,
): string => {
  if (ownerId === currentUserId) return 'You';
  const member = members?.find((m) => m.userId === ownerId);
  return member?.email ?? ownerId.slice(0, 8);
};

export function describeContentError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'This session, or its project, does not exist for you.';
    }
  }
  return describeError(error);
}
