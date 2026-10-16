import type { Role } from '../auth';

/**
 * Notification kinds (docs/specs/22-notifications-and-telegram.md D1). Closed
 * on purpose: a new kind is added here, with its source and defaults, where
 * review sees it. `runner.online` is the resolving item of a `runner.offline`
 * incident (spec 22 notes). `budget.threshold` and `budget.exceeded` come from
 * budgets (spec 28 D6) and have no project for a user budget.
 * `schedule.disabled` comes from an automatic schedule disable (spec 25 D10)
 * and goes to project admins and active admins only. `card.finished` and
 * `card.waiting` come from board card workers (issue #242 D15);
 * `card.background_stalled` from a card round waiting on its own background
 * task too long (#390).
 * `cards.suggested` comes from card capture (issue #244 D11): suggestions are
 * content-derived, so it goes to operators and admins only, and never quotes
 * content.
 */
export const NOTIFICATION_KINDS = [
  'person.needed',
  'slot.blocked',
  'pane.prompt',
  'quota.hit',
  'queue.dry',
  'pr.awaiting_approval',
  'runner.offline',
  'runner.online',
  'budget.exceeded',
  'budget.threshold',
  'schedule.disabled',
  'action.requested',
  'card.finished',
  'card.waiting',
  'card.background_stalled',
  'cards.suggested',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_CHANNELS = ['inApp', 'telegram'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Whether a kind is delivered on each channel. */
export type ChannelSwitches = Record<NotificationChannel, boolean>;

/**
 * - `project`: goes to every member of the project, admins included (D2);
 * - `admin`: goes to every active admin, whatever the project.
 */
export type NotificationScope = 'project' | 'admin';

export interface NotificationKindSpec {
  scope: NotificationScope;
  /** The event (or watcher) the kind comes from, for the UI's rules table. */
  source: string;
  /** Channels a user may turn the kind on for. */
  channels: readonly NotificationChannel[];
  /** D1 defaults for operators and admins. */
  defaults: ChannelSwitches;
  /** D1 defaults for a viewer, when they differ. */
  viewerDefaults?: ChannelSwitches;
  /** Only recipients whose role on the project is `admin` receive it. */
  adminsOnly?: true;
  /**
   * Only recipients whose role on the project is `operator` or `admin`
   * receive it, whatever a viewer's rules say: the kind is content-derived
   * (ADR-0021 §5).
   */
  operatorsOnly?: true;
  /** Declared, never emitted yet. */
  reserved?: true;
}

const BOTH: readonly NotificationChannel[] = NOTIFICATION_CHANNELS;
const ON_ON: ChannelSwitches = { inApp: true, telegram: true };
const ON_OFF: ChannelSwitches = { inApp: true, telegram: false };

export const NOTIFICATION_KIND_SPECS: Record<
  NotificationKind,
  NotificationKindSpec
> = {
  'person.needed': {
    scope: 'project',
    source: 'person.needed',
    channels: BOTH,
    defaults: ON_ON,
  },
  'slot.blocked': {
    scope: 'project',
    source: 'slot.checkpoint (blocked) · issue.blocked (person)',
    channels: BOTH,
    defaults: ON_ON,
  },
  'pane.prompt': {
    scope: 'project',
    source: 'pane.prompt',
    channels: BOTH,
    defaults: ON_ON,
  },
  'quota.hit': {
    scope: 'project',
    source: 'pane.quota_hit',
    channels: BOTH,
    defaults: ON_ON,
  },
  'queue.dry': {
    scope: 'project',
    source: 'round.decided',
    channels: BOTH,
    defaults: ON_OFF,
  },
  'pr.awaiting_approval': {
    scope: 'project',
    source: 'pr.awaiting_approval',
    channels: BOTH,
    defaults: ON_ON,
    viewerDefaults: ON_OFF,
  },
  'runner.offline': {
    scope: 'admin',
    source: 'runner status',
    channels: BOTH,
    defaults: ON_ON,
  },
  'runner.online': {
    scope: 'admin',
    source: 'runner status',
    channels: ['inApp'],
    defaults: ON_OFF,
  },
  'budget.exceeded': {
    scope: 'project',
    source: 'budgets (100 %)',
    channels: BOTH,
    defaults: ON_ON,
  },
  'budget.threshold': {
    scope: 'project',
    source: 'budgets (each threshold)',
    channels: BOTH,
    defaults: ON_ON,
  },
  'schedule.disabled': {
    scope: 'project',
    source: 'schedule.disabled',
    channels: BOTH,
    defaults: ON_ON,
    adminsOnly: true,
  },
  'action.requested': {
    scope: 'project',
    source: 'action_request.created (spec 201 D18)',
    channels: BOTH,
    defaults: ON_ON,
    viewerDefaults: { inApp: false, telegram: false },
  },
  'card.finished': {
    scope: 'project',
    source: 'card.finished (issue #242 D15)',
    channels: BOTH,
    defaults: ON_ON,
    viewerDefaults: { inApp: false, telegram: false },
  },
  'card.waiting': {
    scope: 'project',
    source: 'card.waiting (issue #242 D15)',
    channels: BOTH,
    defaults: ON_OFF,
  },
  'card.background_stalled': {
    scope: 'project',
    source: 'card.background_stalled (#390)',
    channels: BOTH,
    defaults: ON_OFF,
  },
  'cards.suggested': {
    scope: 'project',
    source: 'cards.suggested (issue #244 D11)',
    channels: BOTH,
    defaults: ON_OFF,
    viewerDefaults: { inApp: false, telegram: false },
    operatorsOnly: true,
  },
};

export const isNotificationKind = (value: string): value is NotificationKind =>
  (NOTIFICATION_KINDS as readonly string[]).includes(value);

/** Whether `kind` can be delivered on `channel` at all. */
export const kindAllowsChannel = (
  kind: NotificationKind,
  channel: NotificationChannel,
): boolean => NOTIFICATION_KIND_SPECS[kind].channels.includes(channel);

/**
 * What a user gets for `kind` when they never set a rule (D3: a missing row is
 * the default). `role` is the user's effective role where the notification
 * applies — on the project for a project kind.
 */
export const defaultChannels = (
  kind: NotificationKind,
  role: Role,
): ChannelSwitches => {
  const spec = NOTIFICATION_KIND_SPECS[kind];
  return role === 'viewer' && spec.viewerDefaults
    ? { ...spec.viewerDefaults }
    : { ...spec.defaults };
};

/** Kinds a user with global `role` can receive at all. */
export const kindsFor = (role: Role): NotificationKind[] =>
  NOTIFICATION_KINDS.filter(
    (kind) =>
      !NOTIFICATION_KIND_SPECS[kind].reserved &&
      (NOTIFICATION_KIND_SPECS[kind].scope === 'project' || role === 'admin'),
  );
