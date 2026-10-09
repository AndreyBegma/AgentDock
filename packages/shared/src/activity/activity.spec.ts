import { describe, expect, it } from 'bun:test';
import { AUDIT_ACTIONS } from '../audit';
import { EVENTS_DUPLICATE_EVENT } from '../protocol';
import { ACTIVITY_DATA_MAX_BYTES } from './contracts';
import {
  ACTIVITY_AUDIT_ACTIONS,
  ACTIVITY_EVENT_TYPES,
  type ActivityAuditSource,
  type ActivityEventSource,
  activityFromAudit,
  activityFromEvent,
  boundActivityData,
} from './types';

const event = (
  type: string,
  data: unknown = {},
  extra: Partial<ActivityEventSource> = {},
): ActivityEventSource => ({
  runnerId: 'r1',
  type,
  source: 'runner',
  slot: 'i21-api',
  issue: 21,
  data,
  ...extra,
});

const audit = (
  action: string,
  extra: Partial<ActivityAuditSource> = {},
): ActivityAuditSource => ({
  actorType: 'user',
  actorUserId: 'admin-1',
  actorRunnerId: null,
  action,
  targetType: 'user',
  targetId: 'u2',
  result: 'ok',
  ...extra,
});

/** Data that makes every curated type produce an item. */
const SAMPLE: Record<string, unknown> = {
  'pr.checks_changed': { number: 7, branch: 'b', checks: 'red' },
  'session.vanished': { name: 'cs-i21-api' },
};

describe('the curated event map (spec 21 D3)', () => {
  it('maps every curated type to an item', () => {
    for (const type of ACTIVITY_EVENT_TYPES) {
      const item = activityFromEvent(event(type, SAMPLE[type] ?? {}), 'p1');
      expect(item?.type).toBe(type);
      expect(item?.title.length).toBeGreaterThan(0);
    }
  });

  it('covers the spec’s initial set', () => {
    expect([...ACTIVITY_EVENT_TYPES].sort()).toEqual(
      [
        'orchestrator.started',
        'orchestrator.stopped',
        'round.started',
        'slot.dispatched',
        'slot.resumed',
        'slot.redispatched',
        'slot.checkpoint',
        'slot.stopped',
        'slot.message_sent',
        'slot.fence_widened',
        'pr.opened',
        'pr.checks_changed',
        'pr.merged',
        'pr.closed',
        'issue.blocked',
        'person.needed',
        'pane.prompt',
        'pane.quota_hit',
        'session.vanished',
        'commit.trailer_found',
        'runner.spool_truncated',
      ].sort(),
    );
  });

  it('skips unmapped, duplicate and unparsed events', () => {
    for (const type of [
      'llm.request',
      'tool.call',
      'pane.idle',
      'pane.busy',
      'worktree.changed',
      'events.unparsed',
      EVENTS_DUPLICATE_EVENT,
      'something.new',
    ]) {
      expect(activityFromEvent(event(type), 'p1')).toBeNull();
    }
  });

  it('skips the plugin’s echoes of what the runner observes', () => {
    const echo = { source: 'code-sentinel' };
    expect(activityFromEvent(event('pane.prompt', {}, echo), 'p1')).toBeNull();
    expect(
      activityFromEvent(
        event('commit.trailer_found', { sha: 'abc1234' }, echo),
        'p1',
      ),
    ).toBeNull();
    expect(
      activityFromEvent(
        event('slot.checkpoint', { checkpoint: 'pr_open' }, echo),
        'p1',
      ),
    ).not.toBeNull();
  });

  it('shows pr.checks_changed only on red or green', () => {
    const checks = (value: string) =>
      activityFromEvent(
        event('pr.checks_changed', { number: 3, checks: value }),
        'p1',
      );
    expect(checks('pending')).toBeNull();
    expect(checks('red')?.severity).toBe('danger');
    expect(checks('green')?.severity).toBe('ok');
    expect(checks('green')?.prNumber).toBe(3);
  });

  it('shows session.vanished only for cs- sessions', () => {
    expect(
      activityFromEvent(event('session.vanished', { name: 'scratch' }), 'p1'),
    ).toBeNull();
    expect(
      activityFromEvent(event('session.vanished', { name: 'cs-i21-api' }), 'p1')
        ?.severity,
    ).toBe('warn');
  });

  it('makes the runner the actor, and the orchestrator for person.needed and issue.blocked (D5)', () => {
    expect(activityFromEvent(event('slot.dispatched'), 'p1')).toMatchObject({
      actorType: 'runner',
      actorId: 'r1',
      slot: 'i21-api',
      issue: 21,
    });
    for (const type of ['person.needed', 'issue.blocked']) {
      expect(
        activityFromEvent(event(type, { question: 'which?' }), 'p1'),
      ).toMatchObject({
        actorType: 'orchestrator',
        actorId: null,
      });
    }
  });

  it('never keeps the text of a slot message', () => {
    const item = activityFromEvent(
      event('slot.message_sent', { text: 'token=abc' }),
      'p1',
    );
    expect(item?.data).toEqual({});
  });

  it('keeps checkpoint fields and severity by kind', () => {
    const item = activityFromEvent(
      event('slot.checkpoint', {
        checkpoint: 'blocked',
        heading: 'blocked',
        summary: 'needs a grant',
        position: 3,
      }),
      'p1',
    );
    expect(item).toMatchObject({
      category: 'fleet',
      severity: 'warn',
      title: 'i21-api: blocked',
      data: {
        checkpoint: 'blocked',
        heading: 'blocked',
        summary: 'needs a grant',
      },
      link: '/projects/p1/fleet',
    });
  });

  it('has no fleet link for a project-less event', () => {
    expect(
      activityFromEvent(event('orchestrator.started'), null)?.link,
    ).toBeNull();
    expect(
      activityFromEvent(
        event('runner.spool_truncated', { fromSeq: 1, toSeq: 9 }),
        null,
      ),
    ).toMatchObject({
      category: 'runner',
      link: '/admin/runners',
      title: 'Runner spool full: events 1–9 dropped',
    });
  });
});

describe('the curated audit map (spec 21 D3)', () => {
  it('only names actions of the audit union', () => {
    for (const action of ACTIVITY_AUDIT_ACTIONS) {
      expect(AUDIT_ACTIONS as readonly string[]).toContain(action);
    }
  });

  it('shows user.approve as audit with the admin as actor', () => {
    expect(activityFromAudit(audit('user.approve'), null)).toMatchObject({
      category: 'audit',
      type: 'user.approve',
      actorType: 'user',
      actorId: 'admin-1',
      link: '/admin/audit',
    });
  });

  it('hides a successful sign-in and shows a refused one', () => {
    expect(activityFromAudit(audit('auth.login'), null)).toBeNull();
    expect(
      activityFromAudit(
        audit('auth.login', {
          result: 'denied',
          actorType: 'anonymous',
          actorUserId: null,
        }),
        null,
      ),
    ).toMatchObject({ severity: 'warn', actorType: 'user', actorId: null });
  });

  it('skips actions outside the curated set', () => {
    for (const action of [
      'auth.logout',
      'runner.command',
      'pane.watch_started',
      'prices.recompute',
    ]) {
      expect(activityFromAudit(audit(action), null)).toBeNull();
    }
  });

  it('names a slot target and links a project', () => {
    const item = activityFromAudit(
      audit('slot.stop', {
        targetType: 'slot',
        targetId: 'i21-api',
        result: 'error',
      }),
      'p1',
    );
    expect(item).toMatchObject({
      slot: 'i21-api',
      severity: 'danger',
      title: 'Slot stop requested (failed)',
      link: '/projects/p1',
    });
  });

  it('maps runner and system actors', () => {
    expect(
      activityFromAudit(
        audit('runner.pair', { actorType: 'runner', actorRunnerId: 'r9' }),
        null,
      ),
    ).toMatchObject({ actorType: 'runner', actorId: 'r9' });
    expect(
      activityFromAudit(audit('user.update', { actorType: 'system' }), null),
    ).toMatchObject({
      actorType: 'system',
      actorId: null,
    });
  });
});

describe('boundActivityData', () => {
  it('drops trailing keys until the JSON fits', () => {
    const big = 'x'.repeat(3000);
    const bounded = boundActivityData({ a: 1, b: big, c: big });
    expect(Object.keys(bounded)).toEqual(['a', 'b']);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
      ACTIVITY_DATA_MAX_BYTES,
    );
  });
});
