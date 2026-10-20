import { describe, expect, test } from 'bun:test';
import {
  type InstalledSkillView,
  type ProjectRuntimeProfile,
  SKILLS_ERROR,
} from '@agentdock/shared';
import { ApiError } from '../api';
import {
  allowedToolsOf,
  COMMAND_UNAVAILABLE_TEXT,
  dedupeSkills,
  defaultProfileOptionLabel,
  describeSkillsError,
  EMPTY_RUN_FORM,
  formatBytes,
  groupBySkillScope,
  installOutcome,
  isActivePhase,
  isCommandUnavailable,
  parseTimeoutMinutes,
  permissionWarning,
  profileOptionLabel,
  profilesLabel,
  provenanceLabel,
  runFormProblem,
  runProfileReason,
  skillRunProfiles,
  skillRunsHref,
  skillToRun,
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

describe('skillToRun', () => {
  const items = [
    skill({ id: 'a', invocation: 'cs-review', runnable: true }),
    skill({ id: 'b', invocation: 'cs-orchestrator', runnable: false }),
    skill({
      id: 'c',
      invocation: 'cs-codex',
      runtime: 'codex',
      runnable: true,
    }),
  ];
  test('a ?run= link opens the named runnable Claude skill, slash or not', () => {
    expect(skillToRun(items, 'cs-review')?.id).toBe('a');
    expect(skillToRun(items, '/cs-review')?.id).toBe('a');
  });
  test('nothing to open for no name, an unknown, unrunnable or Codex skill', () => {
    expect(skillToRun(items, null)).toBeNull();
    expect(skillToRun(items, 'nope')).toBeNull();
    expect(skillToRun(items, 'cs-orchestrator')).toBeNull();
    expect(skillToRun(items, 'cs-codex')).toBeNull();
  });
});

describe('dedupeSkills', () => {
  const plugin = (profileKey: string, over: Partial<InstalledSkillView> = {}) =>
    skill({
      id: `plugin-${profileKey}`,
      scope: 'plugin',
      invocation: 'code-sentinel:spec',
      profileKey,
      contentHash: 'h1',
      ...over,
    });

  test('one plugin skill in five profiles is one row', () => {
    const rows = dedupeSkills(
      ['a', 'b', 'c', 'd', 'e'].map((key) => plugin(key)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.profiles).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('a different content or invocation stays a separate row', () => {
    const rows = dedupeSkills([
      plugin('a'),
      plugin('b', { contentHash: 'h2' }),
      plugin('c', { invocation: 'code-sentinel:test' }),
    ]);
    expect(rows).toHaveLength(3);
  });

  test('a project skill has no profiles', () => {
    const rows = dedupeSkills([skill({ scope: 'project' })]);
    expect(rows[0]?.profiles).toEqual([]);
  });

  test('the same profile twice is counted once', () => {
    expect(dedupeSkills([plugin('a'), plugin('a')])[0]?.profiles).toEqual([
      'a',
    ]);
  });
});

describe('profilesLabel', () => {
  test('reads for none, one and many', () => {
    expect(profilesLabel([])).toBe('');
    expect(profilesLabel(['work'])).toBe('profile work');
    expect(profilesLabel(['a', 'b', 'c'])).toBe('in 3 profiles');
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

describe('run dialog profiles', () => {
  const profile = (
    over: Partial<ProjectRuntimeProfile>,
  ): ProjectRuntimeProfile => ({
    key: 'work',
    runtime: 'claude',
    label: 'Work',
    authenticated: true,
    isDefault: false,
    ...over,
  });

  test('keeps only claude profiles, in the order the API gave', () => {
    const keys = skillRunProfiles([
      profile({ key: 'alpha' }),
      profile({ key: 'cx', runtime: 'codex' }),
      profile({ key: 'work' }),
    ]).map((p) => p.key);
    expect(keys).toEqual(['alpha', 'work']);
  });

  test('marks the project default', () => {
    expect(profileOptionLabel(profile({ isDefault: true }))).toBe(
      'work (project default)',
    );
    expect(profileOptionLabel(profile({}))).toBe('work');
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

  test('skillRunsHref filters History to skill runs', () => {
    expect(skillRunsHref('p1')).toBe(
      '/projects/p1/activity?tab=runs&kind=skill',
    );
  });

  describe('runProfileReason', () => {
    const profile = (key: string, isDefault: boolean) =>
      ({ key, isDefault }) as ProjectRuntimeProfile;

    test('a picked profile is always fine', () => {
      expect(runProfileReason('work', [], 'p1')).toBeNull();
    });

    test('no pick and a default exists: fine, and the option says "Project default"', () => {
      const profiles = [profile('work', true)];
      expect(runProfileReason('', profiles, 'p1')).toBeNull();
      expect(defaultProfileOptionLabel(profiles)).toBe('Project default');
    });

    test('no pick and no default: a reason that links to the settings', () => {
      const profiles = [profile('work', false)];
      const reason = runProfileReason('', profiles, 'p1');
      expect(reason?.href).toBe('/projects/p1/settings?tab=orchestrator');
      expect(defaultProfileOptionLabel(profiles)).toBe('(none set)');
    });

    test('profiles that failed to load are not read as "no default"', () => {
      const reason = runProfileReason('', [], 'p1', true);
      expect(reason?.text).toContain('could not be loaded');
      expect(reason?.href).toBeUndefined();
    });
  });

  test('an old runner is named and told to update, with no "yet"', () => {
    const text = describeSkillsError(
      new ApiError(503, SKILLS_ERROR.commandUnavailable as never, 'x'),
      'laptop',
    );
    expect(text).toContain('Update the Nautelle runner on laptop');
    expect(text).not.toContain('yet');
  });
});
