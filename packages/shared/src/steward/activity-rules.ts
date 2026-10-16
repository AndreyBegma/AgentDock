import {
  type EventContext,
  type EventRule,
  fixed,
  int,
  str,
} from '../activity/rules';
import { API_EVENT_SOURCE } from '../protocol/envelope';
import {
  STEWARD_ACTION_RESULTS,
  STEWARD_ACTIONS,
  STEWARD_INCIDENT_KINDS,
  type StewardAction,
  type StewardActionResult,
  type StewardIncidentKind,
} from './contracts';
import {
  STEWARD_INCIDENT_EVENTS,
  type StewardIncidentEventType,
  stewardIncidentTitle,
} from './events';

/**
 * `steward_incident.*` events the API records itself (#447 D13, D15,
 * ADR-0014): actor `system`, only from `source` `api` — a runner can never
 * forge one. The runner's own `steward.observed` / `steward.acted` are not
 * feed items: the incident is. Internal to the package — `activity/types`
 * spreads it into the type map.
 */

const oneOf = <T extends string>(
  values: readonly T[],
  value: string | null,
): T | undefined =>
  value !== null && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

const titleOf =
  (type: StewardIncidentEventType) =>
  (ctx: EventContext): string => {
    const kind = oneOf<StewardIncidentKind>(
      STEWARD_INCIDENT_KINDS,
      str(ctx.data, 'kind'),
    );
    const reason = str(ctx.data, 'reason');
    if (!kind || !reason) return 'Steward incident';
    return stewardIncidentTitle(type, {
      subjectLabel: str(ctx.data, 'subjectLabel') ?? undefined,
      kind,
      reason,
      action: oneOf<StewardAction>(STEWARD_ACTIONS, str(ctx.data, 'action')),
      result: oneOf<StewardActionResult>(
        STEWARD_ACTION_RESULTS,
        str(ctx.data, 'result'),
      ),
      attempt: int(ctx.data, 'attempt') ?? undefined,
    });
  };

const KEEP = [
  'incidentId',
  'subjectKind',
  'subjectId',
  'subjectLabel',
  'cardNumber',
  'kind',
  'reason',
  'action',
  'result',
  'attempt',
] as const;

/** The card on the Board, the Fleet for a slot, else nothing. */
const linkOf = (ctx: EventContext): string | null => {
  if (!ctx.projectId) return null;
  const number = int(ctx.data, 'cardNumber');
  if (number !== null) return `/projects/${ctx.projectId}/board?card=${number}`;
  return str(ctx.data, 'subjectKind') === 'fleet_slot'
    ? `/projects/${ctx.projectId}/fleet`
    : null;
};

const rule = (
  type: StewardIncidentEventType,
  severity: EventRule['severity'],
): EventRule => ({
  category: 'fleet',
  severity,
  title: titleOf(type),
  keep: KEEP,
  bySystem: true,
  sources: [API_EVENT_SOURCE],
  link: linkOf,
});

export const STEWARD_EVENT_RULES: Record<string, EventRule> = {
  [STEWARD_INCIDENT_EVENTS.opened]: rule(
    STEWARD_INCIDENT_EVENTS.opened,
    fixed('warn'),
  ),
  [STEWARD_INCIDENT_EVENTS.acted]: rule(STEWARD_INCIDENT_EVENTS.acted, (ctx) =>
    str(ctx.data, 'result') === 'failed' ? 'warn' : 'info',
  ),
  [STEWARD_INCIDENT_EVENTS.escalated]: rule(
    STEWARD_INCIDENT_EVENTS.escalated,
    fixed('danger'),
  ),
  [STEWARD_INCIDENT_EVENTS.resolved]: rule(
    STEWARD_INCIDENT_EVENTS.resolved,
    fixed('ok'),
  ),
};
