import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  skillInspectArgsSchema,
  skillInstallMinRole,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { sha256 } from './discover';
import { inspectSkills, installSkill, uninstallSkill } from './install';
import { skillsWorkspace, withFakeGh } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS);

let fixture: Awaited<ReturnType<typeof skillsWorkspace>> | undefined;
afterEach(() => fixture?.cleanup());

const setup = async () => {
  fixture = await skillsWorkspace();
  return fixture;
};

const codeOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandFailure);
  return (error as CommandFailure).code;
};

describe('skill.inspect', () => {
  it('returns both skills of the fixture with file hashes and contentHash', async () => {
    const f = await setup();
    const result = await inspectSkills(
      { source: 'acme/skills' },
      f.deps(f.git),
    );
    expect(result.commit).toBe(f.sourceCommit);
    expect(result.skills.map((s) => s.skillId)).toEqual(['estimate', 'review']);
    const estimate = result.skills[0]!;
    expect(estimate.path).toBe('skills/estimate');
    expect(estimate.frontmatter).toEqual({
      name: 'estimate',
      description: 'Estimates effort.',
      'argument-hint': '<issue>',
      'allowed-tools': ['Read'],
    });
    expect(estimate.files.map((x) => [x.path, x.sha256])).toEqual([
      [
        'SKILL.md',
        sha256(readFileSync(join(f.source, 'skills/estimate/SKILL.md'))),
      ],
      ['scripts/size.sh', sha256('echo 3\n')],
    ]);
    expect(estimate.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // The temp clone is gone.
    expect(readdirSync(f.ws).filter((n) => n.startsWith('agentdock-'))).toEqual(
      [],
    );
  });

  it('narrows to one skill, and answers not_found for a missing skill or repository', async () => {
    const f = await setup();
    const one = await inspectSkills(
      { source: 'acme/skills', skillId: 'review' },
      f.deps(f.git),
    );
    expect(one.skills.map((s) => s.skillId)).toEqual(['review']);
    expect(
      await codeOf(
        inspectSkills(
          { source: 'acme/skills', skillId: 'nope' },
          f.deps(f.git),
        ),
      ),
    ).toBe('not_found');
    expect(
      await codeOf(inspectSkills({ source: 'acme/gone' }, f.deps(f.git))),
    ).toBe('not_found');
  });

  it('refuses a source with "..", a URL or another host', () => {
    for (const source of [
      'acme/../etc',
      'https://github.com/acme/skills',
      'gitlab.com/acme/skills',
      'acme/skills/extra',
      '-acme/skills',
      'git@evil.example:acme/skills',
    ]) {
      expect(skillInspectArgsSchema.safeParse({ source }).success).toBe(false);
    }
    expect(
      skillInspectArgsSchema.safeParse({ source: 'acme/skills', host: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('skill.install', () => {
  const previewOf = async (f: Awaited<ReturnType<typeof skillsWorkspace>>) => {
    const inspected = await inspectSkills(
      { source: 'acme/skills', skillId: 'estimate' },
      f.deps(f.git),
    );
    return {
      source: 'acme/skills',
      skillId: 'estimate',
      commit: inspected.commit,
      contentHash: inspected.skills[0]!.contentHash,
    };
  };

  it('fails with changed_since_preview when the repository changed after the preview, writing nothing', async () => {
    const f = await setup();
    const preview = await previewOf(f);
    // The previewed commit is rewritten away: the history now holds other content.
    f.write(f.source, {
      'skills/estimate/SKILL.md': '---\nname: estimate\n---\nexfiltrate\n',
    });
    await f.run(f.source, 'add', '-A');
    await f.run(f.source, 'commit', '-q', '--amend', '-m', 'skills');
    await f.run(f.source, 'reflog', 'expire', '--expire=now', '--all');
    await f.run(f.source, 'gc', '-q', '--prune=now');

    const profileTarget = {
      scope: 'profile' as const,
      profileKey: 'claude-work',
      runtime: 'claude' as const,
    };
    expect(
      await codeOf(
        installSkill({ ...preview, target: profileTarget }, f.deps(f.git)),
      ),
    ).toBe('changed_since_preview');
    expect(existsSync(join(f.profileDir, 'skills'))).toBe(false);

    const { exec, calls } = withFakeGh(f.git, f.root);
    const projectTarget = {
      scope: 'project' as const,
      projectId: f.project.id,
      root: f.root,
      base: 'main',
      runtime: 'claude' as const,
    };
    expect(
      await codeOf(
        installSkill({ ...preview, target: projectTarget }, f.deps(exec)),
      ),
    ).toBe('changed_since_preview');
    expect(calls).toEqual([]);
    expect(await f.run(f.root, 'branch', '--list', 'skills/*')).toBe('');
    expect(await f.run(f.origin, 'branch', '--list', 'skills/*')).toBe('');
  });

  it('fails with changed_since_preview when the content no longer matches the preview hash', async () => {
    const f = await setup();
    const preview = await previewOf(f);
    const target = {
      scope: 'profile' as const,
      profileKey: 'claude-work',
      runtime: 'claude' as const,
    };
    expect(
      await codeOf(
        installSkill(
          { ...preview, contentHash: 'f'.repeat(64), target },
          f.deps(f.git),
        ),
      ),
    ).toBe('changed_since_preview');
    expect(existsSync(join(f.profileDir, 'skills'))).toBe(false);
  });

  it('opens a PR on skills/<name> without touching the main checkout or adding a trailer', async () => {
    const f = await setup();
    const preview = await previewOf(f);
    const headBefore = await f.run(f.root, 'rev-parse', 'HEAD');
    const branchBefore = await f.run(f.root, 'branch', '--show-current');
    const { exec, calls } = withFakeGh(f.git, f.root);

    const result = await installSkill(
      {
        ...preview,
        target: {
          scope: 'project',
          projectId: f.project.id,
          root: f.root,
          base: 'main',
          runtime: 'claude',
        },
      },
      f.deps(exec),
    );
    expect(result).toEqual({
      path: '.claude/skills/estimate',
      prUrl: 'https://github.com/acme/widget/pull/7',
    });

    // The main checkout: same HEAD, same branch, clean tree, no skill on disk.
    expect(await f.run(f.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await f.run(f.root, 'branch', '--show-current')).toBe(branchBefore);
    expect(await f.run(f.root, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(f.root, '.claude'))).toBe(false);
    // The worktree and the local branch are gone; the pushed branch stays.
    expect(existsSync(join(f.ws, '.wt-widget-skill-abc12345'))).toBe(false);
    expect(await f.run(f.root, 'branch', '--list', 'skills/*')).toBe('');
    const tree = await f.run(
      f.origin,
      'ls-tree',
      '-r',
      '--name-only',
      'skills/estimate',
    );
    expect(tree.split('\n')).toEqual([
      '.claude/skills/estimate/.agentdock-skill.json',
      '.claude/skills/estimate/SKILL.md',
      '.claude/skills/estimate/scripts/size.sh',
      'README.md',
      'src/app.txt',
    ]);
    const provenance = JSON.parse(
      await f.run(
        f.origin,
        'show',
        'skills/estimate:.claude/skills/estimate/.agentdock-skill.json',
      ),
    );
    expect(provenance).toEqual({
      ...preview,
      installedAt: '2026-10-09T12:00:00.000Z',
    });
    const message = await f.run(
      f.origin,
      'log',
      '-1',
      '--format=%B',
      'skills/estimate',
    );
    expect(message).toBe('feat(skills): install estimate from acme/skills');
    expect(message).not.toMatch(/Co-Authored-By|Claude-Session/i);
    expect(await f.run(f.origin, 'rev-parse', 'skills/estimate~1')).toBe(
      headBefore,
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.args.slice(0, 10)).toEqual([
      'pr',
      'create',
      '--repo',
      'acme/widget',
      '--base',
      'main',
      '--head',
      'skills/estimate',
      '--title',
      'feat(skills): install estimate',
    ]);
    expect(call!.body).toContain(preview.commit);
    expect(call!.body).toContain(preview.contentHash);
    expect(call!.body).toContain('`scripts/size.sh`');
    expect(call!.body).not.toMatch(/Claude|Generated with/);
  });

  it('refuses a second install of the same skill into the project', async () => {
    const f = await setup();
    const preview = await previewOf(f);
    const { exec } = withFakeGh(f.git, f.root);
    const args = {
      ...preview,
      target: {
        scope: 'project' as const,
        projectId: f.project.id,
        root: f.root,
        base: 'main',
        runtime: 'claude' as const,
      },
    };
    await installSkill(args, f.deps(exec));
    expect(await codeOf(installSkill(args, f.deps(exec)))).toBe(
      'already_exists',
    );
  });

  it('refuses a project the runner does not watch', async () => {
    const f = await setup();
    const preview = await previewOf(f);
    const { exec } = withFakeGh(f.git, f.root);
    expect(
      await codeOf(
        installSkill(
          {
            ...preview,
            target: {
              scope: 'project',
              projectId: 'prj_other',
              root: f.root,
              base: 'main',
              runtime: 'claude',
            },
          },
          f.deps(exec),
        ),
      ),
    ).toBe('path_not_allowed');
  });

  it('writes a profile install into that profile only, and needs admin', async () => {
    const f = await setup();
    const preview = await previewOf(f);
    const target = {
      scope: 'profile' as const,
      profileKey: 'claude-work',
      runtime: 'claude' as const,
    };
    expect(skillInstallMinRole({ target })).toBe('admin');
    const result = await installSkill({ ...preview, target }, f.deps(f.git));
    const dest = join(f.profileDir, 'skills', 'estimate');
    expect(result).toEqual({ path: dest });
    expect(readdirSync(dest).sort()).toEqual([
      '.agentdock-skill.json',
      'SKILL.md',
      'scripts',
    ]);
    expect(readdirSync(join(f.profileDir, 'skills'))).toEqual(['estimate']);
    expect(existsSync(f.codexDir)).toBe(false);
    expect(existsSync(join(f.ws, '.claude'))).toBe(false);
    expect(await f.run(f.root, 'status', '--porcelain')).toBe('');

    expect(
      await codeOf(installSkill({ ...preview, target }, f.deps(f.git))),
    ).toBe('already_exists');
    expect(
      await codeOf(
        installSkill(
          { ...preview, target: { ...target, runtime: 'codex' } },
          f.deps(f.git),
        ),
      ),
    ).toBe('unsupported_runtime');
    expect(
      await codeOf(
        installSkill(
          { ...preview, target: { ...target, profileKey: 'nope' } },
          f.deps(f.git),
        ),
      ),
    ).toBe('unknown_profile');
  });
});

describe('skill.uninstall', () => {
  it('removes a profile skill, and answers not_found for a missing one', async () => {
    const f = await setup();
    const inspected = await inspectSkills(
      { source: 'acme/skills', skillId: 'review' },
      f.deps(f.git),
    );
    const target = {
      scope: 'profile' as const,
      profileKey: 'claude-work',
      runtime: 'claude' as const,
    };
    await installSkill(
      {
        source: 'acme/skills',
        skillId: 'review',
        commit: inspected.commit,
        contentHash: inspected.skills[0]!.contentHash,
        target,
      },
      f.deps(f.git),
    );
    const args = {
      profileKey: 'claude-work',
      runtime: 'claude' as const,
      name: 'review',
    };
    expect(uninstallSkill(args, f.deps(f.git))).toEqual({ removed: true });
    expect(existsSync(join(f.profileDir, 'skills', 'review'))).toBe(false);
    expect(
      await codeOf(
        Promise.resolve().then(() => uninstallSkill(args, f.deps(f.git))),
      ),
    ).toBe('not_found');
  });
});
