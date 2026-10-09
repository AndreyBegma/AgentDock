import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { join } from 'node:path';
import { CommandFailure } from '../commands/failure';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { findRunnableSkill, listSkills } from './inventory';
import { skillsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS);

let fixture: Awaited<ReturnType<typeof skillsWorkspace>> | undefined;
afterEach(() => fixture?.cleanup());

const PROVENANCE = {
  source: 'acme/skills',
  skillId: 'fmt',
  commit: 'a'.repeat(40),
  contentHash: 'b'.repeat(64),
  installedAt: '2026-10-01T00:00:00.000Z',
};

/** The project (on origin/main), a profile, and a profile's code-sentinel plugin cache. */
const setup = async () => {
  const f = await skillsWorkspace();
  fixture = f;
  f.write(f.root, {
    '.claude/skills/fmt/SKILL.md':
      '---\ndescription: Formats.\nargument-hint: <path>\n---\n',
    '.claude/skills/fmt/.agentdock-skill.json': JSON.stringify(PROVENANCE),
    '.agents/skills/lint/SKILL.md': '---\ndescription: Lints.\n---\n',
  });
  await f.commitAll(f.root, 'skills');
  await f.run(f.root, 'push', '-q', 'origin', 'main');
  await f.run(f.root, 'fetch', '-q', 'origin');
  // In the working tree only: not on the base, so not listed.
  f.write(f.root, {
    '.claude/skills/draft/SKILL.md': '---\nname: draft\n---\n',
  });

  const cache = join(
    f.profileDir,
    'plugins',
    'cache',
    'code-sentinel',
    'code-sentinel',
    '3.2.0',
  );
  f.write(f.profileDir, {
    'skills/notes/SKILL.md': '---\ndescription: Takes notes.\n---\n',
    'skills/not-a-skill/README.md': 'no SKILL.md here',
    'plugins/installed_plugins.json': JSON.stringify({
      version: 2,
      plugins: {
        'code-sentinel@code-sentinel': [
          { scope: 'user', version: '3.2.0', installPath: cache },
        ],
      },
    }),
    'plugins/cache/code-sentinel/code-sentinel/3.2.0/skills/spec/SKILL.md':
      '---\nname: cs-spec\ndescription: Specs.\n---\n',
    'plugins/cache/code-sentinel/code-sentinel/3.2.0/skills/orchestrator/SKILL.md':
      '---\nname: cs-orchestrator\ndisable-model-invocation: true\n---\n',
    // A stale cached version that installed_plugins.json does not name.
    'plugins/cache/code-sentinel/code-sentinel/3.1.0/skills/old/SKILL.md':
      '---\n---\n',
  });
  return f;
};

describe('skill.list', () => {
  it('reports project, profile and plugin skills', async () => {
    const f = await setup();
    const { items } = await listSkills(
      { projectId: f.project.id, root: f.root },
      f.deps(f.git),
    );
    expect(items).toEqual([
      {
        scope: 'project',
        runtime: 'codex',
        name: 'lint',
        invocation: 'lint',
        path: '.agents/skills/lint',
        projectId: 'prj_widget',
        description: 'Lints.',
      },
      {
        scope: 'project',
        runtime: 'claude',
        name: 'fmt',
        invocation: 'fmt',
        path: '.claude/skills/fmt',
        projectId: 'prj_widget',
        description: 'Formats.',
        argumentHint: '<path>',
        source: 'acme/skills',
        commit: PROVENANCE.commit,
        contentHash: PROVENANCE.contentHash,
      },
      {
        scope: 'profile',
        runtime: 'claude',
        name: 'notes',
        invocation: 'notes',
        path: join(f.profileDir, 'skills', 'notes'),
        profileKey: 'claude-work',
        description: 'Takes notes.',
      },
      {
        scope: 'plugin',
        runtime: 'claude',
        name: 'orchestrator',
        invocation: 'code-sentinel:orchestrator',
        path: join(
          f.profileDir,
          'plugins/cache/code-sentinel/code-sentinel/3.2.0/skills/orchestrator',
        ),
        profileKey: 'claude-work',
        plugin: 'code-sentinel',
        pluginVersion: '3.2.0',
      },
      {
        scope: 'plugin',
        runtime: 'claude',
        name: 'spec',
        invocation: 'code-sentinel:spec',
        path: join(
          f.profileDir,
          'plugins/cache/code-sentinel/code-sentinel/3.2.0/skills/spec',
        ),
        profileKey: 'claude-work',
        plugin: 'code-sentinel',
        pluginVersion: '3.2.0',
        description: 'Specs.',
      },
    ]);
  });

  it('lists only profile and plugin skills without a project, and refuses an unwatched one', async () => {
    const f = await setup();
    const { items } = await listSkills({}, f.deps(f.git));
    expect(items.map((s) => s.invocation)).toEqual([
      'notes',
      'code-sentinel:orchestrator',
      'code-sentinel:spec',
    ]);
    const error = await listSkills(
      { projectId: 'prj_other', root: f.root },
      f.deps(f.git),
    ).catch((e) => e);
    expect((error as CommandFailure).code).toBe('path_not_allowed');
  });

  it('finds the skill a run names, on that profile', async () => {
    const f = await setup();
    const profile = f.profiles[0]!;
    const deps = f.deps(f.git);
    expect(
      (await findRunnableSkill('fmt', f.project, profile, deps))?.scope,
    ).toBe('project');
    expect(
      (await findRunnableSkill('notes', f.project, profile, deps))?.scope,
    ).toBe('profile');
    expect(
      (await findRunnableSkill('code-sentinel:spec', f.project, profile, deps))
        ?.scope,
    ).toBe('plugin');
    // A codex project skill does not load in a claude session; a draft is not on the base.
    expect(
      await findRunnableSkill('lint', f.project, profile, deps),
    ).toBeNull();
    expect(
      await findRunnableSkill('draft', f.project, profile, deps),
    ).toBeNull();
  });
});
