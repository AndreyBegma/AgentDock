import { describe, expect, test } from 'bun:test';
import { type InstalledSkillView, SKILLS_ERROR } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  allowedToolsOf,
  COMMAND_UNAVAILABLE_TEXT,
  describeSkillsError,
  EMPTY_RUN_FORM,
  formatBytes,
  groupBySkillScope,
  installOutcome,
  isActivePhase,
  isCommandUnavailable,
  parseTimeoutMinutes,
  permissionWarning,
  profileKeysFrom,
  provenanceLabel,
  runFormProblem,
  toRunRequest,
} from './format';

const skill = (over: Partial<InstalledSkillView>): InstalledSkillView => ({
  id: 'id',
  scope: 'project',
  runtime: 'claude',
  name: 'estimate',
  invocation: 'estimate',
  path: '.claude/skills/estimate',
  projectId: 'p1',
  profileKey: null,
  description: null,
  argumentHint: null,
  source: null,
  commit: null,
  contentHash: null,
  pluginVersion: null,
  runnable: true,
  seenAt: '2026-10-09T00:00:00.000Z',
  ...over,
});

const apiError = (status: number, code: string) =>
  new ApiError(status, code as never, 'm', undefined, { error: code });

describe('groupBySkillScope', () => {
  test('orders scopes and drops empty ones', () => {
    const groups = groupBySkillScope([
      skill({ scope: 'plugin', invocation: 'code-sentinel:spec' }),
      skill({ scope: 'project', invocation: 'b' }),
      skill({ scope: 'project', invocation: 'a' }),
    ]);
    expect(groups.map((g) => g.scope)).toEqual(['project', 'plugin']);
    expect(groups[0]?.items.map((i) => i.invocation)).toEqual(['a', 'b']);
  });
});

describe('provenanceLabel', () => {
  test('source with a short commit', () => {
    expect(
      provenanceLabel(skill({ source: 'o/r', commit: 'abcdef0123456' })),
    ).toBe('o/r@abcdef0');
  });
  test('plugin version, then a dash', () => {
    expect(provenanceLabel(skill({ pluginVersion: '1.2.0' }))).toBe(
      'plugin 1.2.0',
    );
    expect(provenanceLabel(skill({}))).toBe('—');
  });
});

describe('profileKeysFrom', () => {
  test('default plus claude profile keys, deduplicated and sorted', () => {
    const keys = profileKeysFrom(
      [
        skill({ scope: 'profile', profileKey: 'work' }),
        skill({ scope: 'profile', profileKey: 'work' }),
        skill({ scope: 'profile', profileKey: 'cx', runtime: 'codex' }),
        skill({ scope: 'project', profileKey: null }),
      ],
      'alpha',
    );
    expect(keys).toEqual(['alpha', 'work']);
  });
});

describe('run form', () => {
  test('timeout is whole minutes within bounds', () => {
    expect(parseTimeoutMinutes('')).toBeUndefined();
    expect(parseTimeoutMinutes('60')).toBe(3600);
    expect(parseTimeoutMinutes('0')).toBeNull();
    expect(parseTimeoutMinutes('361')).toBeNull();
    expect(parseTimeoutMinutes('1.5')).toBeNull();
  });

  test('problems', () => {
    expect(runFormProblem(EMPTY_RUN_FORM)).toBeNull();
    expect(runFormProblem({ ...EMPTY_RUN_FORM, args: 'x'.repeat(4097) })).toBe(
      'args_too_long',
    );
    expect(runFormProblem({ ...EMPTY_RUN_FORM, timeoutMinutes: '9999' })).toBe(
      'timeout',
    );
    expect(runFormProblem({ ...EMPTY_RUN_FORM, model: '--flag' })).toBe(
      'model',
    );
  });

  test('request carries only what was set', () => {
    expect(toRunRequest('estimate', EMPTY_RUN_FORM)).toEqual({
      skill: 'estimate',
      args: '',
      model: 'sonnet',
      output: 'report',
    });
    expect(
      toRunRequest('code-sentinel:spec', {
        ...EMPTY_RUN_FORM,
        profileKey: 'work',
        permissionMode: 'acceptEdits',
        output: 'pr',
        timeoutMinutes: '10',
      }),
    ).toEqual({
      skill: 'code-sentinel:spec',
      args: '',
      model: 'sonnet',
      output: 'pr',
      profileKey: 'work',
      permissionMode: 'acceptEdits',
      timeoutSec: 600,
    });
  });

  test('warning for every mode but auto', () => {
    expect(permissionWarning('')).toBeNull();
    expect(permissionWarning('auto')).toBeNull();
    expect(permissionWarning('bypassPermissions')).toContain('off');
  });
});

describe('misc helpers', () => {
  test('active phases', () => {
    expect(isActivePhase('queued')).toBe(true);
    expect(isActivePhase('collecting')).toBe(true);
    expect(isActivePhase('timed_out')).toBe(false);
  });
  test('bytes', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
  test('allowed-tools as a string or a list', () => {
    expect(allowedToolsOf({})).toEqual([]);
    expect(
      allowedToolsOf({ 'allowed-tools': 'Read, Bash(git:*) Edit' }),
    ).toEqual(['Read', 'Bash(git:*)', 'Edit']);
    expect(allowedToolsOf({ 'allowed-tools': ['Read'] })).toEqual(['Read']);
  });
});

describe('installOutcome', () => {
  test('pending while requested', () => {
    expect(
      installOutcome({ status: 'requested', result: null, error: null }).state,
    ).toBe('pending');
  });
  test('ok with a pull request link; a non-https link is dropped', () => {
    const ok = installOutcome({
      status: 'ok',
      result: { path: 'p', prUrl: 'https://github.com/o/r/pull/1' },
      error: null,
    });
    expect(ok.state).toBe('done');
    expect(ok.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(
      installOutcome({
        status: 'ok',
        result: { prUrl: 'javascript:alert(1)' },
        error: null,
      }).prUrl,
    ).toBeNull();
  });
  test('a runner code in the message gets its sentence', () => {
    const failed = installOutcome({
      status: 'error',
      result: null,
      error: { code: 'runner_error', message: 'changed_since_preview' },
    });
    expect(failed.state).toBe('failed');
    expect(failed.text).toContain('nothing was written');
  });
  test('unknown outcome is a failure that says so', () => {
    const unknown = installOutcome({
      status: 'unknown',
      result: null,
      error: null,
    });
    expect(unknown.state).toBe('failed');
    expect(unknown.text).toContain('unknown');
  });
});

describe('errors', () => {
  test('command_unavailable is recognised and explained', () => {
    const error = apiError(503, SKILLS_ERROR.commandUnavailable);
    expect(isCommandUnavailable(error)).toBe(true);
    expect(describeSkillsError(error)).toBe(COMMAND_UNAVAILABLE_TEXT);
  });
  test('changed_since_preview tells that nothing was written', () => {
    expect(
      describeSkillsError(apiError(409, SKILLS_ERROR.changedSincePreview)),
    ).toContain('nothing was written');
  });
  test('a 403 and a 404 without a code', () => {
    expect(describeSkillsError(new ApiError(403, undefined, 'x'))).toContain(
      'role',
    );
    expect(describeSkillsError(new ApiError(404, undefined, 'x'))).toContain(
      'member',
    );
  });
});
