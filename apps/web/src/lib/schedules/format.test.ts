import { describe, expect, test } from 'bun:test';
import type { ScheduleView } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  describeSchedulesError,
  describeTarget,
  emptyScheduleForm,
  firingReasonLabel,
  formatFireTime,
  formFromSchedule,
  nextRunLabel,
  scheduleFormProblem,
  toScheduleRequest,
} from './format';

const schedule = (overrides: Partial<ScheduleView> = {}): ScheduleView => ({
  id: 's1',
  projectId: 'p1',
  name: 'Nightly security',
  target: {
    kind: 'skill',
    skill: 'cs-security',
    args: '',
    output: 'report',
    profileId: 'work',
    model: 'sonnet',
  },
  cron: '0 3 * * *',
  timezone: 'Europe/Kyiv',
  missedPolicy: 'skip',
  enabled: true,
  disabledReason: null,
  nextRunAt: '2026-10-10T00:00:00.000Z',
  lastRunAt: null,
  consecutiveFailures: 0,
  createdById: 'u1',
  updatedById: null,
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
  lastFiring: null,
  ...overrides,
});

const apiError = (status: number, code?: string) =>
  new ApiError(status, code as never, 'server message');

describe('describeTarget', () => {
  test('an orchestrator target names its mode', () => {
    expect(describeTarget({ kind: 'orchestrator', mode: 'next' })).toBe(
      'orchestrator next',
    );
  });

  test('a skill target is the skill, with its arguments squeezed and cut', () => {
    expect(
      describeTarget({
        kind: 'skill',
        skill: 'cs-security',
        args: '  --deep\n  src ',
        output: 'pr',
      }),
    ).toBe('cs-security --deep src');
    const long = describeTarget({
      kind: 'skill',
      skill: 'x',
      args: 'a'.repeat(100),
      output: 'report',
    });
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(70);
  });

  test('a skill without arguments is just its name', () => {
    expect(
      describeTarget({ kind: 'skill', skill: 'x', args: '', output: 'report' }),
    ).toBe('x');
  });
});

describe('formatFireTime / nextRunLabel', () => {
  test('shows the time in the schedule’s timezone', () => {
    // 2026-10-10T00:00Z is 03:00 in Kyiv (UTC+3 until 25 Oct).
    expect(formatFireTime('2026-10-10T00:00:00.000Z', 'Europe/Kyiv')).toContain(
      '03:00',
    );
    expect(formatFireTime('2026-10-10T00:00:00.000Z', 'UTC')).toContain(
      '00:00',
    );
  });

  test('a missing or broken date is a dash', () => {
    expect(formatFireTime(null, 'UTC')).toBe('—');
    expect(formatFireTime('nonsense', 'UTC')).toBe('—');
  });

  test('a disabled schedule has no next run to show', () => {
    expect(nextRunLabel(schedule({ enabled: false }))).toBe('disabled');
    expect(nextRunLabel(schedule())).toContain('03:00');
  });

  test('an unknown timezone falls back to the ISO string', () => {
    expect(formatFireTime('2026-10-10T00:00:00.000Z', 'Mars/Olympus')).toBe(
      '2026-10-10T00:00:00.000Z',
    );
  });
});

describe('firingReasonLabel', () => {
  test('known reasons become phrases, unknown ones pass through', () => {
    expect(firingReasonLabel('runner_offline')).toBe('the runner was offline');
    expect(firingReasonLabel('something_new')).toBe('something_new');
    expect(firingReasonLabel(null)).toBeNull();
  });
});

describe('scheduleFormProblem', () => {
  const valid = {
    ...emptyScheduleForm('Europe/Kyiv'),
    name: 'Nightly',
    skill: 'cs-security',
  };

  test('the default form with a name and a skill is fine', () => {
    expect(scheduleFormProblem(valid)).toBeNull();
  });

  test('name, skill, cron and timezone are required', () => {
    expect(scheduleFormProblem({ ...valid, name: '  ' })).toBe('name');
    expect(scheduleFormProblem({ ...valid, name: 'x'.repeat(101) })).toBe(
      'name_too_long',
    );
    expect(scheduleFormProblem({ ...valid, skill: '' })).toBe('skill');
    expect(scheduleFormProblem({ ...valid, cron: '' })).toBe('cron');
    expect(scheduleFormProblem({ ...valid, timezone: ' ' })).toBe('timezone');
  });

  test('an orchestrator target needs no skill', () => {
    expect(
      scheduleFormProblem({ ...valid, targetKind: 'orchestrator', skill: '' }),
    ).toBeNull();
  });

  test('six fields are refused here, macros are accepted', () => {
    expect(scheduleFormProblem({ ...valid, cron: '0 0 3 * * *' })).toBe(
      'cron_fields',
    );
    expect(scheduleFormProblem({ ...valid, cron: '@daily' })).toBeNull();
    expect(scheduleFormProblem({ ...valid, cron: '*/15 * * * *' })).toBeNull();
  });

  test('a model that is not an alias or id is refused', () => {
    expect(scheduleFormProblem({ ...valid, model: 'no spaces' })).toBe('model');
  });
});

describe('toScheduleRequest / formFromSchedule', () => {
  test('a skill form becomes a trimmed request; the profile only when set', () => {
    const form = {
      ...emptyScheduleForm('Europe/Kyiv'),
      name: ' Nightly ',
      skill: ' cs-security ',
      cron: ' 0 3 * * * ',
    };
    const request = toScheduleRequest(form);
    expect(request).toEqual({
      name: 'Nightly',
      target: {
        kind: 'skill',
        skill: 'cs-security',
        args: '',
        model: 'opus',
        output: 'report',
      },
      cron: '0 3 * * *',
      timezone: 'Europe/Kyiv',
      missedPolicy: 'skip',
      enabled: true,
    });
    expect(
      toScheduleRequest({ ...form, profileId: 'work' }).target,
    ).toMatchObject({ profileId: 'work' });
  });

  test('an orchestrator form carries only its mode', () => {
    const request = toScheduleRequest({
      ...emptyScheduleForm('UTC'),
      name: 'Hourly',
      targetKind: 'orchestrator',
      mode: 'next',
      skill: 'ignored',
    });
    expect(request.target).toEqual({ kind: 'orchestrator', mode: 'next' });
  });

  test('editing round-trips: the form of a schedule makes its own request', () => {
    const s = schedule();
    const request = toScheduleRequest(formFromSchedule(s));
    expect(request.target).toEqual(s.target);
    expect(request.cron).toBe(s.cron);
    expect(request.timezone).toBe(s.timezone);
    expect(request.name).toBe(s.name);
  });

  test('the form of an orchestrator schedule keeps its mode', () => {
    const form = formFromSchedule(
      schedule({ target: { kind: 'orchestrator', mode: 'start' } }),
    );
    expect(form.targetKind).toBe('orchestrator');
    expect(form.mode).toBe('start');
  });
});

describe('describeSchedulesError', () => {
  test('each 422 code gets its own sentence', () => {
    const texts = [
      'invalid_cron',
      'interval_too_short',
      'invalid_timezone',
      'invalid_target',
    ].map((code) => describeSchedulesError(apiError(422, code)));
    expect(new Set(texts).size).toBe(4);
    expect(texts[1]).toContain('5 minutes');
  });

  test('a viewer and a non-member get plain sentences', () => {
    expect(describeSchedulesError(apiError(403))).toContain('role');
    expect(describeSchedulesError(apiError(404))).toContain('no longer exists');
  });

  test('anything else falls back to the shared describer', () => {
    expect(describeSchedulesError(new Error('boom'))).toBe(
      'Could not reach the server.',
    );
  });
});
