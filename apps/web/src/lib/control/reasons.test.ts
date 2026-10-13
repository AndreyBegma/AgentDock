import { describe, expect, test } from 'bun:test';
import {
  type ControlFacts,
  startDisabledReason,
  stopDisabledReason,
} from './reasons';

const facts = (over: Partial<ControlFacts> = {}): ControlFacts => ({
  projectId: 'p1',
  isAdmin: true,
  runnerOnline: true,
  runnerName: 'laptop',
  profileSet: true,
  settingsFailed: false,
  orchestrator: 'absent',
  ...over,
});

describe('startDisabledReason', () => {
  test('nothing in the way: no reason', () => {
    expect(startDisabledReason(facts())).toBeNull();
  });

  test('an offline runner links admins to Runners', () => {
    const reason = startDisabledReason(facts({ runnerOnline: false }));
    expect(reason?.text).toContain('laptop is offline');
    expect(reason?.href).toBe('/admin/runners');
  });

  test('an offline runner tells others to ask an administrator, with no link', () => {
    const reason = startDisabledReason(
      facts({ runnerOnline: false, isAdmin: false }),
    );
    expect(reason?.text).toContain('Ask an administrator');
    expect(reason?.href).toBeUndefined();
  });

  test('no profile links to the orchestrator settings of this project', () => {
    const reason = startDisabledReason(facts({ profileSet: false }));
    expect(reason?.href).toBe('/projects/p1/settings?tab=orchestrator');
  });

  test('settings that failed to load say so', () => {
    const reason = startDisabledReason(
      facts({ settingsFailed: true, profileSet: null }),
    );
    expect(reason?.text).toContain('could not be loaded');
  });

  test('a running or idle orchestrator is already running', () => {
    expect(
      startDisabledReason(facts({ orchestrator: 'running' }))?.text,
    ).toContain('already running');
    expect(
      startDisabledReason(facts({ orchestrator: 'idle' }))?.text,
    ).toContain('already running');
  });

  test('nothing is claimed before the runner is known', () => {
    expect(startDisabledReason(facts({ runnerOnline: null }))).toBeNull();
  });
});

describe('stopDisabledReason', () => {
  test('a running orchestrator can be stopped', () => {
    expect(stopDisabledReason(facts({ orchestrator: 'running' }))).toBeNull();
  });

  test('an absent orchestrator has nothing to stop', () => {
    expect(stopDisabledReason(facts())?.text).toContain('not running');
  });

  test('an offline runner wins over "not running"', () => {
    expect(stopDisabledReason(facts({ runnerOnline: false }))?.text).toContain(
      'offline',
    );
  });
});
