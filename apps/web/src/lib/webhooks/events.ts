import type { WebhookEventType } from '@agentdock/shared';

/** What each outbound event means, in one line, beside its checkbox (spec 26 D9). */
export const EVENT_DESCRIPTION: Record<WebhookEventType, string> = {
  'orchestrator.started': 'A project’s orchestrator started.',
  'orchestrator.stopped': 'A project’s orchestrator stopped.',
  'slot.dispatched': 'The orchestrator handed an issue to a worker session.',
  'slot.checkpoint':
    'A worker reported progress: plan ready, done, pull request open, blocked.',
  'slot.stopped': 'A worker session ended.',
  'pr.opened': 'A worker opened a pull request.',
  'pr.checks_changed': 'A pull request’s checks passed, failed or restarted.',
  'pr.merged': 'A pull request was merged.',
  'pr.closed': 'A pull request was closed without merging.',
  'issue.blocked': 'A worker stopped on an issue it cannot finish alone.',
  'person.needed': 'An agent is waiting for a person to answer.',
  'pane.prompt': 'A session shows a prompt only a person can answer.',
  'pane.quota_hit': 'A session hit its model provider’s usage limit.',
  'schedule.failed': 'A scheduled run failed.',
  'schedule.disabled':
    'A schedule turned itself off, e.g. after five failed runs in a row.',
  'webhook.test': 'Sent only by Test, to check the receiver.',
};

/**
 * The absolute URL a caller posts a trigger to. The API is reached through
 * the web app's `/api` rewrite, so it lives under this page's origin.
 */
export const triggerUrl = (origin: string, path: string): string =>
  `${origin.replace(/\/+$/, '')}/api${path}`;
