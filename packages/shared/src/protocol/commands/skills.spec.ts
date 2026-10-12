import { describe, expect, it } from 'bun:test';
import {
  commands,
  gitRefSchema,
  installedSkillSchema,
  isRunnableSkill,
  parseCommand,
  SKILL_RUN_ARGS_MAX_BYTES,
  SKILL_TIMEOUTS_MS,
  skillCancelArgsSchema,
  skillCommands,
  skillContentHashInput,
  skillFilePathSchema,
  skillInspectArgsSchema,
  skillInspectResultSchema,
  skillInstallArgsSchema,
  skillInstallBranch,
  skillInstallMinRole,
  skillInvocationSchema,
  skillListArgsSchema,
  skillNameSchema,
  skillPhaseToRunStatus,
  skillRunArgsSchema,
  skillRunBranch,
  skillRunPhaseSchema,
  skillRunResultSchema,
  skillRunSessionName,
  skillSearchArgsSchema,
  skillSearchResultSchema,
  skillSourceSchema,
  skillUninstallArgsSchema,
} from '../index';

const sha = (c: string) => c.repeat(64);
const commit = 'a'.repeat(40);

const runArgs = {
  runId: 'cmg1run0001',
  projectId: 'prj_1',
  root: '/home/dev/repo',
  base: 'develop',
  skill: 'code-sentinel:estimate',
  args: '#24 --deep',
  profileKey: 'blacktoorroot',
  model: 'opus',
  permissionMode: 'auto',
  output: 'report',
  timeoutSec: 3600,
} as const;

const install = {
  source: 'vercel-labs/agent-skills',
  skillId: 'estimate',
  commit,
  contentHash: sha('b'),
  target: {
    scope: 'project',
    projectId: 'prj_1',
    root: '/home/dev/repo',
    base: 'main',
    runtime: 'claude',
  },
} as const;

describe('skill commands', () => {
  it('are in the allowlist, registered with their runner handlers', () => {
    for (const [name, definition] of Object.entries(skillCommands)) {
      expect(Object.hasOwn(commands, name)).toBe(true);
      expect(commands[name as keyof typeof commands]).toBe(definition);
      const parsed = parseCommand(name, { unexpected: true });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe('invalid_args');
    }
  });

  it('carry D14 roles and per-command timeouts', () => {
    expect(
      Object.fromEntries(
        Object.entries(skillCommands).map(([n, d]) => [n, d.minRole]),
      ),
    ).toEqual({
      'skill.search': 'operator',
      'skill.inspect': 'operator',
      'skill.install': 'operator',
      'skill.uninstall': 'admin',
      'skill.list': 'viewer',
      'skill.run': 'operator',
      'skill.cancel': 'operator',
    });
    expect(skillCommands['skill.inspect'].timeoutMs).toBe(
      SKILL_TIMEOUTS_MS.inspect,
    );
  });

  it('needs admin for a profile install', () => {
    expect(skillInstallMinRole(install)).toBe('operator');
    expect(
      skillInstallMinRole({
        target: { scope: 'profile', profileKey: 'p1', runtime: 'claude' },
      }),
    ).toBe('admin');
  });
});

describe('skill.search', () => {
  it('parses a query', () => {
    expect(skillSearchArgsSchema.parse({ query: ' estimate ' })).toEqual({
      query: 'estimate',
    });
  });

  it.each([
    ['a host', { query: 'estimate', host: 'evil.example' }],
    ['a url', { query: 'estimate', url: 'https://evil.example/api' }],
    ['an empty query', { query: '  ' }],
    ['a long query', { query: 'q'.repeat(101) }],
    ['a control character', { query: 'a\nb' }],
  ])('rejects %s', (_, args) => {
    expect(skillSearchArgsSchema.safeParse(args).success).toBe(false);
  });

  it('accepts mapped items of a recorded skills.sh response', () => {
    // GET https://skills.sh/api/search?q=estimate, mapped as D1 says.
    const recorded = {
      query: 'estimate',
      skills: [
        {
          id: 'acme/skills/estimate',
          source: 'acme/skills',
          skillId: 'estimate',
          name: 'estimate',
          installs: 412,
        },
        {
          id: 'someone/agent.tools/cost-estimate',
          source: 'someone/agent.tools',
          skillId: 'cost-estimate',
          name: 'Cost estimate',
          installs: 0,
        },
      ],
      count: 2,
    };
    const items = recorded.skills.map(
      ({ id, source, skillId, name, installs }) => ({
        id,
        source,
        skillId,
        name,
        installs,
      }),
    );
    expect(skillSearchResultSchema.parse({ items }).items).toHaveLength(2);
  });
});

describe('primitives', () => {
  it.each([
    'vercel-labs/skills',
    'a/b',
    'Owner1/repo.name_x',
    'o/_r',
  ])('source accepts %s', (s) => {
    expect(skillSourceSchema.safeParse(s).success).toBe(true);
  });

  it.each([
    '',
    'owner',
    'owner/',
    '/repo',
    'owner/repo/extra',
    'owner/..',
    'owner/.',
    'owner/re..po',
    '../repo',
    '-owner/repo',
    'https://github.com/owner/repo',
    'github.com/owner/repo',
    'git@github.com:owner/repo',
    'gitlab.com/owner/repo',
    'owner/repo?x=1',
    'own er/repo',
  ])('source rejects %p', (s) => {
    expect(skillSourceSchema.safeParse(s).success).toBe(false);
  });

  it.each(['estimate', 'cs-spec', 'a.b_c', 'X1'])('name accepts %s', (s) => {
    expect(skillNameSchema.safeParse(s).success).toBe(true);
  });

  it.each([
    '',
    '-x',
    '.hidden',
    'a..b',
    'a/b',
    'a:b',
    'a b',
    'n'.repeat(65),
  ])('name rejects %p', (s) => {
    expect(skillNameSchema.safeParse(s).success).toBe(false);
  });

  it.each(['estimate', 'code-sentinel:spec'])('invocation accepts %s', (s) => {
    expect(skillInvocationSchema.safeParse(s).success).toBe(true);
  });

  it.each([
    '',
    ':spec',
    'a:',
    'a:b:c',
    '/spec',
    '-p',
    'a..b:c',
    'a b',
  ])('invocation rejects %p', (s) => {
    expect(skillInvocationSchema.safeParse(s).success).toBe(false);
  });

  it.each([
    'main',
    'develop',
    'release/1.2',
    'v1.0.0',
    'feat/24-skills',
  ])('ref accepts %s', (s) => {
    expect(gitRefSchema.safeParse(s).success).toBe(true);
  });

  it.each([
    '',
    '-main',
    '--upload-pack=x',
    '/main',
    'a..b',
    'a//b',
    'a/.b',
    'a/',
    'a.',
    'a.lock',
    'a@{1}',
    'a b',
    'a~1',
    'a^',
    'a:b',
  ])('ref rejects %p', (s) => {
    expect(gitRefSchema.safeParse(s).success).toBe(false);
  });

  it.each([
    'SKILL.md',
    'scripts/run.sh',
    'a/b/c.txt',
    '.hidden',
  ])('file path accepts %s', (p) => {
    expect(skillFilePathSchema.safeParse(p).success).toBe(true);
  });

  it.each([
    '',
    '/etc/passwd',
    '../x',
    'a/../b',
    'a/./b',
    'a//b',
    'a\\b',
    'a/',
  ])('file path rejects %p', (p) => {
    expect(skillFilePathSchema.safeParse(p).success).toBe(false);
  });
});

describe('skill.inspect', () => {
  it('parses a source with an optional skill and ref', () => {
    expect(
      skillInspectArgsSchema.safeParse({
        source: 'acme/skills',
        skillId: 'estimate',
        ref: 'main',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a url source', { source: 'https://github.com/acme/skills' }],
    ['another host', { source: 'gitlab.com/acme/skills' }],
    ['..', { source: 'acme/..' }],
    ['a host key', { source: 'acme/skills', host: 'gitlab.com' }],
    ['a flag ref', { source: 'acme/skills', ref: '--depth=999' }],
  ])('rejects %s', (_, args) => {
    expect(skillInspectArgsSchema.safeParse(args).success).toBe(false);
  });

  it('parses a two-skill result', () => {
    const skill = (id: string) => ({
      skillId: id,
      path: `skills/${id}`,
      frontmatter: {
        name: id,
        description: 'd',
        'allowed-tools': ['Read', 'Grep'],
        'disable-model-invocation': true,
      },
      files: [{ path: 'SKILL.md', size: 120, sha256: sha('c') }],
      contentHash: sha('d'),
    });
    expect(
      skillInspectResultSchema.safeParse({
        commit,
        skills: [skill('one'), skill('two')],
      }).success,
    ).toBe(true);
  });

  it('rejects an escaping file path in a result', () => {
    expect(
      skillInspectResultSchema.safeParse({
        commit,
        skills: [
          {
            skillId: 'x',
            path: 'skills/x',
            frontmatter: {},
            files: [{ path: '../../.bashrc', size: 1, sha256: sha('c') }],
            contentHash: sha('d'),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('fixes the contentHash input: sorted path:hash lines', () => {
    expect(
      skillContentHashInput([
        { path: 'b.md', sha256: '2' },
        { path: 'SKILL.md', sha256: '1' },
        { path: 'a/c.sh', sha256: '3' },
      ]),
    ).toBe('SKILL.md:1\na/c.sh:3\nb.md:2\n');
  });
});

describe('skill.install', () => {
  it('parses a project and a profile target', () => {
    expect(skillInstallArgsSchema.safeParse(install).success).toBe(true);
    expect(
      skillInstallArgsSchema.safeParse({
        ...install,
        target: { scope: 'profile', profileKey: 'work', runtime: 'claude' },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a short commit', { ...install, commit: 'abc123' }],
    ['an upper-case hash', { ...install, contentHash: 'B'.repeat(64) }],
    ['a path-like skillId', { ...install, skillId: '../../x' }],
    [
      'a target path',
      { ...install, target: { ...install.target, path: '/x' } },
    ],
    [
      'a project target without base',
      { ...install, target: { ...install.target, base: undefined } },
    ],
    [
      'a profile target with a root',
      {
        ...install,
        target: {
          scope: 'profile',
          profileKey: 'p',
          runtime: 'claude',
          root: '/x',
        },
      },
    ],
    ['an unknown scope', { ...install, target: { scope: 'global' } }],
  ])('rejects %s', (_, args) => {
    expect(skillInstallArgsSchema.safeParse(args).success).toBe(false);
  });

  it('names the install branch', () => {
    expect(skillInstallBranch('estimate')).toBe('skills/estimate');
    expect(() => skillInstallBranch('../x')).toThrow();
  });

  it('uninstalls by profile, runtime and name only', () => {
    expect(
      skillUninstallArgsSchema.safeParse({
        profileKey: 'p',
        runtime: 'codex',
        name: 'estimate',
      }).success,
    ).toBe(true);
    expect(
      skillUninstallArgsSchema.safeParse({
        profileKey: 'p',
        runtime: 'claude',
        name: '..',
      }).success,
    ).toBe(false);
  });
});

describe('skill.list', () => {
  it('takes both projectId and root, or neither', () => {
    expect(skillListArgsSchema.safeParse({}).success).toBe(true);
    expect(
      skillListArgsSchema.safeParse({ projectId: 'p', root: '/r' }).success,
    ).toBe(true);
    expect(skillListArgsSchema.safeParse({ projectId: 'p' }).success).toBe(
      false,
    );
  });

  it('reports a plugin skill as <plugin>:<name>', () => {
    const plugin = {
      scope: 'plugin',
      runtime: 'claude',
      name: 'spec',
      invocation: 'code-sentinel:spec',
      path: '/home/u/.claude/plugins/cache/cs/skills/spec',
      profileKey: 'default',
      plugin: 'code-sentinel',
      pluginVersion: '3.2.0',
    };
    expect(installedSkillSchema.safeParse(plugin).success).toBe(true);
    expect(
      installedSkillSchema.safeParse({ ...plugin, invocation: 'spec' }).success,
    ).toBe(false);
  });

  it('ties project skills to a project and profile skills to a profile', () => {
    const project = {
      scope: 'project',
      runtime: 'claude',
      name: 'estimate',
      invocation: 'estimate',
      path: '.claude/skills/estimate',
      projectId: 'prj_1',
      source: 'acme/skills',
      commit,
      contentHash: sha('e'),
    };
    expect(installedSkillSchema.safeParse(project).success).toBe(true);
    expect(
      installedSkillSchema.safeParse({ ...project, projectId: undefined })
        .success,
    ).toBe(false);
    expect(
      installedSkillSchema.safeParse({
        ...project,
        scope: 'profile',
        projectId: undefined,
      }).success,
    ).toBe(false);
  });
});

describe('skill.run', () => {
  it('parses a run', () => {
    expect(skillRunArgsSchema.safeParse(runArgs).success).toBe(true);
  });

  it.each([
    ['a flag model', { ...runArgs, model: '--dangerously-skip-permissions' }],
    ['an unknown permission mode', { ...runArgs, permissionMode: 'yolo' }],
    ['a NUL in args', { ...runArgs, args: 'a\u0000b' }],
    [
      'oversized args',
      { ...runArgs, args: 'x'.repeat(SKILL_RUN_ARGS_MAX_BYTES + 1) },
    ],
    ['a short timeout', { ...runArgs, timeoutSec: 59 }],
    ['a long timeout', { ...runArgs, timeoutSec: 21_601 }],
    ['a path-like runId', { ...runArgs, runId: '../etc' }],
    ['a flag base', { ...runArgs, base: '-b' }],
    ['a relative root', { ...runArgs, root: 'repo' }],
    ['an unknown output', { ...runArgs, output: 'email' }],
    ['a shell key', { ...runArgs, command: 'sh -c id' }],
  ])('rejects %s', (_, args) => {
    expect(skillRunArgsSchema.safeParse(args).success).toBe(false);
  });

  it('allows args with spaces and newlines: they are one argv element', () => {
    expect(
      skillRunArgsSchema.safeParse({ ...runArgs, args: '$(id); `x`\nnext' })
        .success,
    ).toBe(true);
  });

  it('names the session agentdock-run-*, never cs-*', () => {
    expect(skillRunSessionName('a1b2c3')).toBe('agentdock-run-a1b2c3');
    expect(() => skillRunSessionName('A1;rm')).toThrow();
    expect(
      skillRunResultSchema.safeParse({
        phase: 'preparing',
        tmuxSession: 'cs-a1b2c3',
      }).success,
    ).toBe(false);
  });

  it('names the run branch without a plugin colon', () => {
    expect(skillRunBranch('a1b2c3', 'code-sentinel:spec')).toBe(
      'run/a1b2c3-code-sentinel-spec',
    );
    expect(gitRefSchema.safeParse(skillRunBranch('a1b2c3', 'x')).success).toBe(
      true,
    );
  });

  it('cancels by run and project', () => {
    expect(skillCancelArgsSchema.safeParse({ runId: 'r1' }).success).toBe(
      false,
    );
    expect(
      skillCancelArgsSchema.safeParse({ runId: 'r1', projectId: 'p' }).success,
    ).toBe(true);
  });

  it.each([
    'code-sentinel:orchestrator',
    'code-sentinel:worker',
    'code-sentinel:cs-orchestrator',
    'code-sentinel:cs-worker',
    'cs-orchestrator',
    'cs-worker',
  ])('refuses %s as not runnable', (skill) => {
    expect(isRunnableSkill(skill)).toBe(false);
  });

  it.each([
    'code-sentinel:estimate',
    'code-sentinel:spec',
    'worker',
    'x:worker',
  ])('runs %s', (skill) => {
    expect(isRunnableSkill(skill)).toBe(true);
  });

  it('maps every phase onto a #21 run status (D12)', () => {
    expect(
      Object.fromEntries(
        skillRunPhaseSchema.options.map((p) => [p, skillPhaseToRunStatus(p)]),
      ),
    ).toEqual({
      queued: 'running',
      preparing: 'running',
      running: 'running',
      collecting: 'running',
      succeeded: 'succeeded',
      failed: 'failed',
      cancelled: 'abandoned',
      timed_out: 'failed',
    });
  });
});
