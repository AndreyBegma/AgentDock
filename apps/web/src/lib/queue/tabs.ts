/**
 * The Queue page's tabs (C-284): the queue itself and the approvals that wait
 * on a person, which used to be a page of their own. `?tab=` names the tab;
 * the first one is the default and leaves the parameter out.
 */
export const QUEUE_TABS = ['queue', 'approvals'] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

/** Where a link to a project's approvals goes: the Queue page's Approvals tab. */
export const approvalsHref = (projectId: string): string =>
  `/projects/${projectId}/queue?tab=approvals`;

/**
 * Where the old `/projects/:id/approvals` sends a visitor. Every parameter it
 * carried is kept (a notification's `actionRequest`), except the old page's
 * own `tab`, whose values the Approvals tab no longer has.
 */
export function approvalsRedirectTarget(
  projectId: string,
  search: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams({ tab: 'approvals' });
  for (const [key, value] of Object.entries(search)) {
    if (key === 'tab' || value === undefined) continue;
    for (const each of Array.isArray(value) ? value : [value]) {
      params.append(key, each);
    }
  }
  return `/projects/${encodeURIComponent(projectId)}/queue?${params}`;
}
