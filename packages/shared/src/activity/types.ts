import type { AuditActorType, AuditResult } from '../audit/actions';
import type {
  ActivityActorType,
  ActivityCategory,
  ActivitySeverity,
} from './contracts';
import { ACTIVITY_DATA_MAX_BYTES } from './contracts';

/**
 * The curated type map (docs/specs/21 D3): which runner events and audit
 * actions become feed items, and how. A type absent from it is skipped, never
 * shown raw. Pure — the API's projector applies it to stored rows, so the same
 * row always gives the same item.
 */

/** A stored `events` row, as the projector reads it. */
export interface ActivityEventSource {
  runnerId: string;
  type: string;
  source: string;
  slot: string | null;
  issue: number | null;
  data: unknown;
}

/** A stored `audit_records` row, as the projector reads it. */
export interface ActivityAuditSource {
  actorType: AuditActorType;
  actorUserId: string | null;
  actorRunnerId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  result: AuditResult;
}

/** An item before it is stored: everything but its id, ts, project and source. */
export interface ActivityDraft {
  category: ActivityCategory;
  type: string;
  severity: ActivitySeverity;
  title: string;
  actorType: ActivityActorType;
  actorId: string | null;
  slot: string | null;
  issue: number | null;
  prNumber: number | null;
  link: string | null;
  data: Record<string, unknown>;
}

type Data = Record<string, unknown>;

const record = (value: unknown): Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Data)
    : {};

const str = (data: Data, key: string): string | null => {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const int = (data: Data, key: string): number | null => {
  const value = data[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
};

/** At most `max` characters, with an ellipsis when cut. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const TITLE_MAX = 200;
const TEXT_MAX = 500;

/** Keeps the listed keys that are present; long strings are clipped. */
const pick = (data: Data, keys: readonly string[]): Data => {
  const out: Data = {};
  for (const key of keys) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? clip(value, TEXT_MAX) : value;
  }
  return out;
};

/** Drops keys from the end until the JSON fits `ACTIVITY_DATA_MAX_BYTES`. */
export const boundActivityData = (data: Data): Data => {
  const out = { ...data };
  const keys = Object.keys(out);
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  while (keys.length > 0 && size() > ACTIVITY_DATA_MAX_BYTES) {
    delete out[keys.pop() as string];
  }
  return out;
};

interface EventContext {
  event: ActivityEventSource;
  data: Data;
  /** The envelope slot, else `data.slot`. */
  slot: string | null;
  projectId: string | null;
}

interface EventRule {
  category: ActivityCategory;
  severity: (ctx: EventContext) => ActivitySeverity;
  title: (ctx: EventContext) => string;
  /** Safe fields kept in `data`. */
  keep: readonly string[];
  /** true: this occurrence is not worth an item. */
  skip?: (ctx: EventContext) => boolean;
  /** The orchestrator, not the runner, is the actor (D5). */
  byOrchestrator?: boolean;
  prNumber?: (ctx: EventContext) => number | null;
  link?: (ctx: EventContext) => string | null;
}

const fixed = (severity: ActivitySeverity) => (): ActivitySeverity => severity;

const who = (ctx: EventContext): string => ctx.slot ?? 'orchestrator';
const prOf = (ctx: EventContext) => int(ctx.data, 'number');
const prTitle = (ctx: EventContext, verb: string): string => {
  const number = prOf(ctx);
  return `PR ${number === null ? '' : `#${number} `}${verb}`;
};

const CHECKPOINT_SEVERITY: Record<string, ActivitySeverity> = {
  implementation_done: 'ok',
  pr_open: 'ok',
  blocked: 'warn',
  misclassified: 'warn',
};

const fleetLink = (ctx: EventContext): string | null =>
  ctx.projectId ? `/projects/${ctx.projectId}/fleet` : null;

/** Fleet events (D3). */
const EVENT_RULES: Record<string, EventRule> = {
  'orchestrator.started': {
    category: 'fleet',
    severity: fixed('ok'),
    title: () => 'Orchestrator started',
    keep: ['session'],
  },
  'orchestrator.stopped': {
    category: 'fleet',
    severity: fixed('info'),
    title: (ctx) => {
      const reason = str(ctx.data, 'reason');
      return reason
        ? `Orchestrator stopped: ${reason}`
        : 'Orchestrator stopped';
    },
    keep: ['session', 'reason'],
  },
  'round.started': {
    category: 'fleet',
    severity: fixed('info'),
    title: (ctx) => {
      const round = str(ctx.data, 'round');
      const free = int(ctx.data, 'free');
      const max = int(ctx.data, 'max');
      const slots =
        free !== null && max !== null ? ` — ${free} of ${max} slots free` : '';
      return `Round ${round ?? ''} started${slots}`.replace('  ', ' ');
    },
    keep: ['date', 'round', 'occupied', 'max', 'free'],
  },
  'slot.dispatched': {
    category: 'fleet',
    severity: fixed('info'),
    title: (ctx) => {
      const model = str(ctx.data, 'model');
      return `${who(ctx)} dispatched${model ? ` on ${model}` : ''}`;
    },
    keep: ['runtime', 'model', 'branch', 'lead'],
  },
  'slot.resumed': {
    category: 'fleet',
    severity: fixed('info'),
    title: (ctx) => `${who(ctx)} resumed`,
    keep: ['reason'],
  },
  'slot.redispatched': {
    category: 'fleet',
    severity: fixed('warn'),
    title: (ctx) => {
      const model = str(ctx.data, 'toModel');
      return `${who(ctx)} re-dispatched${model ? ` on ${model}` : ''}`;
    },
    keep: ['fromModel', 'toModel', 'reason'],
  },
  'slot.checkpoint': {
    category: 'fleet',
    severity: (ctx) =>
      CHECKPOINT_SEVERITY[str(ctx.data, 'checkpoint') ?? ''] ?? 'info',
    title: (ctx) => {
      const heading =
        str(ctx.data, 'heading') ?? str(ctx.data, 'checkpoint') ?? 'checkpoint';
      return `${who(ctx)}: ${heading}`;
    },
    keep: ['checkpoint', 'heading', 'summary', 'prUrl', 'prNumber'],
    prNumber: (ctx) => int(ctx.data, 'prNumber'),
  },
  'slot.stopped': {
    category: 'fleet',
    severity: fixed('warn'),
    title: (ctx) => `${who(ctx)} stopped`,
    keep: ['by'],
  },
  // The message text stays in `command_runs` (spec 17 D10); never here.
  'slot.message_sent': {
    category: 'fleet',
    severity: fixed('info'),
    title: (ctx) => `Message sent to ${who(ctx)}`,
    keep: [],
  },
  'slot.fence_widened': {
    category: 'fleet',
    severity: fixed('warn'),
    title: (ctx) => `${who(ctx)}: fence widened`,
    keep: ['added'],
  },
  'pr.opened': {
    category: 'fleet',
    severity: fixed('info'),
    title: (ctx) => {
      const title = str(ctx.data, 'title');
      return `${prTitle(ctx, 'opened')}${title ? `: ${title}` : ''}`;
    },
    keep: ['number', 'url', 'title', 'branch', 'checks'],
    prNumber: prOf,
  },
  // `pending` is the start of every run of the checks, not news (D3).
  'pr.checks_changed': {
    category: 'fleet',
    severity: (ctx) => (str(ctx.data, 'checks') === 'red' ? 'danger' : 'ok'),
    title: (ctx) => prTitle(ctx, `checks ${str(ctx.data, 'checks')}`),
    keep: ['number', 'branch', 'checks', 'mergeable'],
    skip: (ctx) => {
      const checks = str(ctx.data, 'checks');
      return checks !== 'red' && checks !== 'green';
    },
    prNumber: prOf,
  },
  'pr.merged': {
    category: 'fleet',
    severity: fixed('ok'),
    title: (ctx) => prTitle(ctx, 'merged'),
    keep: ['number', 'branch', 'method'],
    prNumber: prOf,
  },
  'pr.closed': {
    category: 'fleet',
    severity: (ctx) => (ctx.data.merged === false ? 'warn' : 'info'),
    title: (ctx) =>
      prTitle(
        ctx,
        ctx.data.merged === true
          ? 'closed (merged)'
          : ctx.data.merged === false
            ? 'closed without merge'
            : 'closed',
      ),
    keep: ['number', 'branch', 'merged'],
    prNumber: prOf,
  },
  'issue.blocked': {
    category: 'fleet',
    severity: fixed('warn'),
    title: (ctx) => {
      const issue = ctx.event.issue ?? int(ctx.data, 'issue');
      const why = str(ctx.data, 'why');
      return `Issue ${issue === null ? '' : `#${issue} `}blocked${why ? `: ${why}` : ''}`;
    },
    keep: ['kind', 'why'],
    byOrchestrator: true,
  },
  'person.needed': {
    category: 'fleet',
    severity: fixed('danger'),
    title: (ctx) => {
      const question = str(ctx.data, 'question');
      return question ? `Person needed: ${question}` : 'Person needed';
    },
    keep: ['question', 'recommendation'],
    byOrchestrator: true,
  },
  'pane.prompt': {
    category: 'fleet',
    severity: fixed('warn'),
    title: (ctx) =>
      `${who(ctx)} waits on a ${str(ctx.data, 'dialog') ?? 'launch'} prompt`,
    keep: ['target', 'dialog'],
  },
  'pane.quota_hit': {
    category: 'fleet',
    severity: fixed('danger'),
    title: (ctx) => `${who(ctx)} hit the quota`,
    keep: ['target'],
  },
  // Only Code Sentinel's own `cs-*` sessions are fleet news (D3).
  'session.vanished': {
    category: 'fleet',
    severity: fixed('warn'),
    title: (ctx) => `${who(ctx)} session vanished`,
    keep: ['name'],
    skip: (ctx) => !(str(ctx.data, 'name') ?? '').startsWith('cs-'),
  },
  'commit.trailer_found': {
    category: 'fleet',
    severity: fixed('info'),
    title: (ctx) =>
      `${who(ctx)}: agent commit ${(str(ctx.data, 'sha') ?? '').slice(0, 7)}`.trimEnd(),
    keep: ['sha'],
  },
  'runner.spool_truncated': {
    category: 'runner',
    severity: fixed('danger'),
    title: (ctx) => {
      const from = int(ctx.data, 'fromSeq');
      const to = int(ctx.data, 'toSeq');
      return from !== null && to !== null
        ? `Runner spool full: events ${from}–${to} dropped`
        : 'Runner spool full: events dropped';
    },
    keep: ['fromSeq', 'toSeq', 'bytes'],
    link: () => '/admin/runners',
  },
};

/** Every event type the feed shows — the projector's `type IN (…)` filter. */
export const ACTIVITY_EVENT_TYPES: readonly string[] = Object.keys(EVENT_RULES);

/**
 * Plugin copies of what the runner observes itself (`data.via: "watch"`),
 * stored only — the fleet projector skips them too (spec 16).
 */
export const PLUGIN_ECHOED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.appeared',
  'session.vanished',
  'pane.prompt',
  'pane.idle',
  'pane.quota_hit',
  'pane.busy',
  'worktree.changed',
  'commit.trailer_found',
]);

/**
 * Types both Code Sentinel's `events.jsonl` and the markdown scraper report.
 * Once a project's plugin channel is live (spec 16 D8), the `scraped` copy is
 * a duplicate.
 */
export const SCRAPED_SHADOWED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'round.started',
  'slot.dispatched',
  'slot.checkpoint',
]);

/**
 * The item for a stored event resolved to `projectId` (null: no project),
 * or null when the feed does not show it.
 */
export const activityFromEvent = (
  event: ActivityEventSource,
  projectId: string | null,
): ActivityDraft | null => {
  const rule = EVENT_RULES[event.type];
  if (!rule) return null;
  if (
    event.source === 'code-sentinel' &&
    PLUGIN_ECHOED_EVENT_TYPES.has(event.type)
  ) {
    return null;
  }
  const data = record(event.data);
  const ctx: EventContext = {
    event,
    data,
    slot: event.slot ?? str(data, 'slot'),
    projectId,
  };
  if (rule.skip?.(ctx)) return null;
  return {
    category: rule.category,
    type: event.type,
    severity: rule.severity(ctx),
    title: clip(rule.title(ctx), TITLE_MAX),
    actorType: rule.byOrchestrator ? 'orchestrator' : 'runner',
    actorId: rule.byOrchestrator ? null : event.runnerId,
    slot: ctx.slot,
    issue: event.issue ?? int(data, 'issue'),
    prNumber: rule.prNumber?.(ctx) ?? null,
    link: rule.link ? rule.link(ctx) : fleetLink(ctx),
    data: boundActivityData(pick(data, rule.keep)),
  };
};

/** Titles of the audit actions the feed shows (D3): user, registration, runner and project actions. */
const AUDIT_TITLES: Record<string, string> = {
  'auth.register': 'User registered',
  'auth.login': 'Sign-in refused',
  'user.create': 'User created',
  'user.approve': 'User approved',
  'user.reject': 'User rejected',
  'user.update': 'User updated',
  'user.delete': 'User deleted',
  'settings.registration': 'Registration settings changed',
  'runner.create': 'Runner created',
  'runner.pairing_code': 'Runner pairing code issued',
  'runner.pair': 'Runner paired',
  'runner.rename': 'Runner renamed',
  'runner.revoke': 'Runner revoked',
  'project.connect': 'Project connected',
  'project.delete': 'Project deleted',
  'project.update': 'Project settings changed',
  'project.member_add': 'Member added',
  'project.member_update': 'Member role changed',
  'project.member_remove': 'Member removed',
  'project.docs_source_override': 'Docs source overridden',
  'project.docs_source_reset': 'Docs source reset',
  'issue.create': 'Issue created',
  'orchestrator.start': 'Orchestrator start requested',
  'orchestrator.stop': 'Orchestrator stop requested',
  'orchestrator.settings': 'Orchestrator settings changed',
  'slot.stop': 'Slot stop requested',
  'slot.message': 'Message sent to a slot',
};

/** Every audit action the feed shows — the projector's `action IN (…)` filter. */
export const ACTIVITY_AUDIT_ACTIONS: readonly string[] =
  Object.keys(AUDIT_TITLES);

const RESULT_SEVERITY: Record<AuditResult, ActivitySeverity> = {
  ok: 'info',
  requested: 'info',
  denied: 'warn',
  error: 'danger',
};

const RESULT_SUFFIX: Record<AuditResult, string> = {
  ok: '',
  requested: '',
  denied: ' (denied)',
  error: ' (failed)',
};

/**
 * The item for an audit record of `projectId` (null: user- or runner-level,
 * or a project that no longer exists), or null when the feed does not show it.
 * A successful sign-in is never news (D3).
 */
export const activityFromAudit = (
  audit: ActivityAuditSource,
  projectId: string | null,
): ActivityDraft | null => {
  const title = AUDIT_TITLES[audit.action];
  if (!title) return null;
  if (audit.action === 'auth.login' && audit.result === 'ok') return null;
  const actor: Pick<ActivityDraft, 'actorType' | 'actorId'> =
    audit.actorType === 'runner'
      ? { actorType: 'runner', actorId: audit.actorRunnerId }
      : audit.actorType === 'system'
        ? { actorType: 'system', actorId: null }
        : // `anonymous` is a refused sign-in: a user, not known by id.
          { actorType: 'user', actorId: audit.actorUserId };
  return {
    category: 'audit',
    type: audit.action,
    severity: RESULT_SEVERITY[audit.result],
    title:
      audit.action === 'auth.login'
        ? title
        : `${title}${RESULT_SUFFIX[audit.result]}`,
    ...actor,
    slot: audit.targetType === 'slot' ? audit.targetId : null,
    issue: null,
    prNumber: null,
    link: projectId ? `/projects/${projectId}` : '/admin/audit',
    data: boundActivityData(
      pick(audit as unknown as Data, ['targetType', 'targetId', 'result']),
    ),
  };
};
