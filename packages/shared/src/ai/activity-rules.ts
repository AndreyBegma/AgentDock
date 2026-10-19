import { type EventRule, fixed, int, str } from '../activity/rules';
import { API_EVENT_SOURCE } from '../protocol/envelope';
import {
  AI_DIGEST_EVENTS,
  aiDigestSentTitle,
  aiDigestSkippedTitle,
} from './contracts';

/**
 * `ai_digest.*` events the API records itself (#658, ADR-0014): actor
 * `system`, only from `source` `api`. Both link to the project's activity,
 * where the latest digest is shown in full. Internal to the package —
 * `activity/types` spreads it into the type map.
 */

const activityLink = (projectId: string | null): string | null =>
  projectId ? `/projects/${projectId}/activity` : null;

export const AI_DIGEST_EVENT_RULES: Record<string, EventRule> = {
  [AI_DIGEST_EVENTS.sent]: {
    category: 'fleet',
    severity: fixed('ok'),
    title: (ctx) =>
      aiDigestSentTitle({
        done: int(ctx.data, 'done') ?? 0,
        stuck: int(ctx.data, 'stuck') ?? 0,
        waiting: int(ctx.data, 'waiting') ?? 0,
      }),
    keep: ['digestId', 'done', 'stuck', 'waiting', 'delivered'],
    bySystem: true,
    sources: [API_EVENT_SOURCE],
    link: (ctx) => activityLink(ctx.projectId),
  },
  [AI_DIGEST_EVENTS.skipped]: {
    category: 'fleet',
    severity: fixed('warn'),
    title: (ctx) => aiDigestSkippedTitle(str(ctx.data, 'reason')),
    keep: ['reason', 'message'],
    bySystem: true,
    sources: [API_EVENT_SOURCE],
    link: (ctx) => activityLink(ctx.projectId),
  },
};
