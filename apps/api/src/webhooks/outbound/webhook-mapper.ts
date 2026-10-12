import type {
  WebhookDeliveryView,
  WebhookEnvelope,
  WebhookEventType,
  WebhookView,
} from '@agentdock/shared';
import type { Webhook, WebhookDelivery } from '@prisma/client';

/** The webhook columns a view is built from — never `secret`. */
export const WEBHOOK_VIEW_SELECT = {
  id: true,
  name: true,
  url: true,
  events: true,
  projectIds: true,
  enabled: true,
  circuitState: true,
  circuitOpenedAt: true,
  consecutiveFailures: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type WebhookViewRow = Omit<Webhook, 'secret'>;

type LastDelivery = Pick<
  WebhookDelivery,
  'status' | 'createdAt' | 'responseCode'
> | null;

/** A webhook as the admin API returns it (spec 26 "API"). The secret never leaves. */
export const toWebhookView = (
  row: WebhookViewRow,
  last: LastDelivery,
): WebhookView => ({
  id: row.id,
  name: row.name,
  url: row.url,
  events: row.events as WebhookEventType[],
  projectIds: row.projectIds,
  enabled: row.enabled,
  circuitState: row.circuitState,
  circuitOpenedAt: row.circuitOpenedAt?.toISOString() ?? null,
  consecutiveFailures: row.consecutiveFailures,
  createdById: row.createdById,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastDelivery: last
    ? {
        status: last.status,
        createdAt: last.createdAt.toISOString(),
        responseCode: last.responseCode,
      }
    : null,
});

/** The audit `before` / `after` of a webhook: what an admin set, no secret. */
export const webhookAuditState = (row: WebhookViewRow) => ({
  name: row.name,
  url: row.url,
  events: row.events,
  projectIds: row.projectIds,
  enabled: row.enabled,
});

export const toDeliveryView = (row: WebhookDelivery): WebhookDeliveryView => ({
  id: row.id,
  webhookId: row.webhookId,
  eventId: row.eventId === null ? null : row.eventId.toString(),
  eventType: row.eventType as WebhookEventType,
  payload: row.payload as unknown as WebhookEnvelope,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt.toISOString(),
  lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
  responseCode: row.responseCode,
  responseBody: row.responseBody,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
});
