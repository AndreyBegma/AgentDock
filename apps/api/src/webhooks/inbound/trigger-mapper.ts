import {
  type InboundDeliveryView,
  type InboundTriggerAction,
  type InboundTriggerView,
  inboundHookPath,
} from '@agentdock/shared';
import type { InboundDelivery, InboundTrigger } from '@prisma/client';

export const toDeliveryView = (row: InboundDelivery): InboundDeliveryView => ({
  id: row.id.toString(),
  deliveryId: row.deliveryId,
  receivedAt: row.receivedAt.toISOString(),
  status: row.status,
  reason: row.reason,
  renderedArgs: row.renderedArgs ?? null,
  runId: row.runId,
  commandRunId: row.commandRunId,
  sourceIp: row.sourceIp,
});

/** A trigger as the admin API shows it: never `secret` or `previousSecret` (D17). */
export const toTriggerView = (
  row: InboundTrigger,
  lastDelivery: InboundDelivery | null,
): InboundTriggerView => ({
  id: row.id,
  publicId: row.publicId,
  path: inboundHookPath(row.publicId),
  name: row.name,
  projectId: row.projectId,
  // Written only through `parseAction`.
  action: row.action as unknown as InboundTriggerAction,
  allowedPaths: row.allowedPaths,
  valuePattern: row.valuePattern,
  enabled: row.enabled,
  disabledReason: row.disabledReason,
  previousSecretUntil:
    row.previousSecretUntil && row.previousSecretUntil > new Date()
      ? row.previousSecretUntil.toISOString()
      : null,
  createdById: row.createdById,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastDelivery: lastDelivery
    ? {
        status: lastDelivery.status,
        receivedAt: lastDelivery.receivedAt.toISOString(),
      }
    : null,
});

/** The fields the audit log shows of a trigger — no secret, no bucket. */
export const auditable = (row: InboundTrigger) => ({
  name: row.name,
  projectId: row.projectId,
  action: row.action,
  allowedPaths: row.allowedPaths,
  valuePattern: row.valuePattern,
  enabled: row.enabled,
  disabledReason: row.disabledReason,
});
