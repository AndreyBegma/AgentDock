import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { skillContentHashInput } from '@agentdock/shared/protocol';
import { tempDir } from '../testing/fixtures';
import {
  copySkillFiles,
  discoverSkills,
  listSkillFiles,
  sha256,
} from './discover';
import { parseFrontmatter } from './frontmatter';

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const tree = (files: Record<string, string>): string => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

describe('parseFrontmatter', () => {
  it('reads the D2 keys and leaves the rest out', () => {
    expect(
      parseFrontmatter(
        [
          '---',
          'name: estimate',
          'description: >',
          '  Estimate effort',
          '  from evidence.',
          'allowed-tools: [Read, Bash]',
          'argument-hint: "<issue>"',
          'user-invocable: true',
          'disable-model-invocation: false',
          'model: opus',
          '---',
          '# Estimate',
        ].join('\n'),
      ),
    ).toEqual({
      name: 'estimate',
      description: 'Estimate effort from evidence.\n',
      'allowed-tools': ['Read', 'Bash'],
      'argument-hint': '<issue>',
      'user-invocable': true,
      'disable-model-invocation': false,
    });
  });

  it('drops a value of the wrong type and survives garbage', () => {
    expect(
      parseFrontmatter('---\nname: [1, 2]\nuser-invocable: yes please\n---\n'),
    ).toEqual({});
    expect(parseFrontmatter('---\n: : :\n  - [\n---\n')).toEqual({});
    expect(parseFrontmatter('no frontmatter at all')).toEqual({});
  });
});

describe('discoverSkills', () => {
  it('finds two skills with their file hashes and contentHash', () => {
    const repo = tree({
      'README.md': '# repo',
      'skills/estimate/SKILL.md': '---\nname: estimate\n---\nbody\n',
      'skills/estimate/scripts/run.sh': 'echo hi\n',
      'skills/review/SKILL.md':
        '---\nname: review\ndescription: Reviews.\n---\n',
      'skills/review/nested/SKILL.md': '---\nname: inner\n---\n',
      'a/b/c/d/SKILL.md': '---\nname: too-deep\n---\n',
    });
    const { skills, oversized } = discoverSkills(repo);
    expect(oversized).toEqual([]);
    expect(skills.map((s) => [s.skillId, s.path])).toEqual([
      ['estimate', 'skills/estimate'],
      ['review', 'skills/review'],
    ]);
    const estimate = skills[0]!;
    const files = [
      {
        path: 'SKILL.md',
        size: 28,
        sha256: sha256('---\nname: estimate\n---\nbody\n'),
      },
      { path: 'scripts/run.sh', size: 8, sha256: sha256('echo hi\n') },
    ];
    expect(estimate.files).toEqual(files);
    expect(estimate.contentHash).toBe(sha256(skillContentHashInput(files)));
    expect(skills[1]!.files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'nested/SKILL.md',
    ]);
  });

  it('finds agent directories and names a skill by its directory when the name is unusable', () => {
    const repo = tree({
      '.claude/skills/fmt/SKILL.md': '---\nname: ../evil\n---\n',
      'SKILL.md': '---\nname: root\n---\n',
    });
    expect(discoverSkills(repo).skills.map((s) => [s.skillId, s.path])).toEqual(
      [['fmt', '.claude/skills/fmt']],
    );
  });

  it('never follows or lists a symlink', () => {
    const outside = tree({ 'secret.txt': 'TOKEN' });
    const repo = tree({ 'skills/x/SKILL.md': '---\nname: x\n---\n' });
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'skills/x/leak.txt'));
    symlinkSync(outside, join(repo, 'skills/x/dir'));
    const walk = listSkillFiles(join(repo, 'skills/x'));
    expect(walk.ok && walk.files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('leaves out the provenance file and reports an oversized skill', () => {
    const files: Record<string, string> = {
      'skills/big/SKILL.md': '---\nname: big\n---\n',
      'skills/ok/SKILL.md': '---\nname: ok\n---\n',
      'skills/ok/.agentdock-skill.json': '{}',
    };
    for (let i = 0; i < 501; i++) files[`skills/big/f${i}.txt`] = 'x';
    const { skills, oversized } = discoverSkills(tree(files));
    expect(skills.map((s) => s.skillId)).toEqual(['ok']);
    expect(skills[0]!.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(oversized).toEqual([
      { skillId: 'big', path: 'skills/big', reason: 'more than 500 files' },
    ]);
  });
});

describe('copySkillFiles', () => {
  it('copies only the listed files and keeps the executable bit', () => {
    const repo = tree({
      'skills/x/SKILL.md': 'a',
      'skills/x/run.sh': 'b',
      'skills/x/unlisted.txt': 'c',
    });
    chmodSync(join(repo, 'skills/x/run.sh'), 0o755);
    const dest = join(tree({}), 'out');
    copySkillFiles(
      join(repo, 'skills/x'),
      [
        { path: 'SKILL.md', size: 1, sha256: sha256('a') },
        { path: 'run.sh', size: 1, sha256: sha256('b') },
      ],
      dest,
    );
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('a');
    expect(statSync(join(dest, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, 'SKILL.md')).mode & 0o777).toBe(0o644);
    expect(existsSync(join(dest, 'unlisted.txt'))).toBe(false);
  });
});
