import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { estPrefixTokens } from '@nautelle/shared';
import { prefixMeasuredDataSchema } from '@nautelle/shared/protocol';
import type { ConfigProfile } from '../config';
import { tempDir } from '../testing/fixtures';
import {
  MCP_DEFERRED_SERVER_BYTES,
  measurePrefix,
  memoryImports,
  sha256Hex,
  skillListingLine,
  splitRulesBlock,
} from './measure';

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const RULES =
  '## Project coding rules\n\nThese are the rules.\n\n1. Bun only\n   Never npm.';

const setup = () => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const home = join(dir, 'home');
  const configDir = join(home, '.claude-p');
  const cwd = join(home, 'dev', '.wt-app-card-abc');
  const profile: ConfigProfile = {
    id: 'claude-work',
    runtime: 'claude',
    env: { CLAUDE_CONFIG_DIR: configDir },
    args: [],
  };
  write(join(configDir, 'CLAUDE.md'), '# user rules\n');
  write(
    join(configDir, 'skills', 'mine', 'SKILL.md'),
    '---\nname: mine\ndescription: My own skill.\n---\nbody',
  );
  write(join(home, 'dev', 'CLAUDE.md'), '# dev folder\n');
  write(
    join(cwd, 'CLAUDE.md'),
    '# Project\n\nSee @docs/rules.md for the rules.\n',
  );
  write(join(cwd, 'docs', 'rules.md'), '# rules\n');
  write(
    join(cwd, '.claude', 'skills', 'release', 'SKILL.md'),
    `---\nname: release\ndescription: ${'Cut a release. '.repeat(30)}\n---\nbody`,
  );
  return { home, cwd, profile, configDir };
};

describe('splitRulesBlock (#751 B1)', () => {
  it('cuts the rules section out of the prompt, to the next heading', () => {
    const prompt = `# Card\n\nDo it.\n\n${RULES}\n## Finish\n\nCall finish_card.`;
    const { rules, rest } = splitRulesBlock(prompt);
    expect(rules).toBe(`${RULES}\n`);
    expect(rest).toBe('# Card\n\nDo it.\n\n## Finish\n\nCall finish_card.');
  });

  it('is null without a rules section', () => {
    expect(splitRulesBlock('# Card').rules).toBeNull();
    expect(splitRulesBlock(RULES).rules).toBe(RULES);
  });
});

describe('memoryImports', () => {
  it('finds @ imports outside code', () => {
    expect(
      memoryImports(
        'See @docs/a.md and @~/x.md, not me@example or `@b.md`.\n```\n@c.md\n```\n@./d.md',
      ),
    ).toEqual(['docs/a.md', '~/x.md', './d.md']);
  });
});

describe('measurePrefix (#751 B1)', () => {
  it('reports the load chain, the rules, the prompt, skills, MCP and agents', () => {
    const { home, cwd, profile } = setup();
    const prompt = `# Card\n\n${RULES}`;
    const parts = measurePrefix({
      profile,
      home,
      cwd,
      prompt,
      agents: '{"scout":{}}',
      mcpServers: {
        nautelle: { command: '/bin/runner', args: ['mcp'] },
        github: { command: 'gh-mcp', env: { TOKEN: 'secret' } },
      },
    });
    const byName = new Map(parts.map((p) => [`${p.kind}:${p.name}`, p]));
    const claudeMd = byName.get('claude_md:CLAUDE.md');
    const original = '# Project\n\nSee @docs/rules.md for the rules.\n';
    expect(claudeMd).toEqual({
      kind: 'claude_md',
      name: 'CLAUDE.md',
      path: 'CLAUDE.md',
      origin: 'repo',
      bytes: original.length,
      estTokens: estPrefixTokens(original.length),
      sha256: sha256Hex(original),
    });
    expect(byName.get('claude_md:docs/rules.md')?.origin).toBe('repo');
    expect(byName.get('claude_md:~/.claude-p/CLAUDE.md')?.origin).toBe(
      'profile',
    );
    expect(byName.get('claude_md:~/dev/CLAUDE.md')?.origin).toBe('profile');
    expect(byName.get('rules:rules')?.bytes).toBe(RULES.length);
    expect(byName.get('nautelle:prompt')?.bytes).toBe('# Card\n\n'.length);
    const release = byName.get('skill:release');
    expect(release?.path).toBe('.claude/skills/release/SKILL.md');
    expect(release?.bytes).toBe(
      skillListingLine('release', 'Cut a release. '.repeat(30)).length,
    );
    expect(release?.bytes).toBeLessThan(220);
    expect(byName.get('skill:mine')?.origin).toBe('profile');
    expect(byName.get('mcp:github')).toMatchObject({
      origin: 'profile',
      bytes: MCP_DEFERRED_SERVER_BYTES,
    });
    expect(byName.get('mcp:nautelle')?.origin).toBe('nautelle');
    expect(byName.get('agents:agents')?.bytes).toBe('{"scout":{}}'.length);
    // What the API takes: unique, relative, no content.
    expect(
      prefixMeasuredDataSchema.safeParse({
        runId: 'run_1',
        launchKind: 'card',
        parts,
      }).success,
    ).toBe(true);
  });

  it('never hashes an MCP server’s env', () => {
    const { home, profile } = setup();
    const [a] = measurePrefix({
      profile,
      home,
      mcpServers: { github: { command: 'gh', env: { TOKEN: 'one' } } },
    }).filter((p) => p.kind === 'mcp');
    const [b] = measurePrefix({
      profile,
      home,
      mcpServers: { github: { command: 'gh', env: { TOKEN: 'two' } } },
    }).filter((p) => p.kind === 'mcp');
    expect(a?.sha256).toBe(b?.sha256 ?? '');
  });

  it('leaves out hidden skills and counts what the overlays load', () => {
    const { home, cwd, profile } = setup();
    const overlaySkill = '---\nname: release\ndescription: Short.\n---\nbody';
    const parts = measurePrefix({
      profile,
      home,
      cwd,
      skillsOff: ['mine', 'release'],
      overlays: {
        claudeMd: {
          path: join(cwd, 'CLAUDE.md'),
          text: '# P\n',
          originalSha256: 'a'.repeat(64),
        },
        skills: {
          release: { text: overlaySkill, originalSha256: 'b'.repeat(64) },
        },
      },
    });
    const byName = new Map(parts.map((p) => [`${p.kind}:${p.name}`, p]));
    expect(byName.has('skill:mine')).toBe(false);
    expect(byName.get('skill:release')).toMatchObject({
      bytes: skillListingLine('release', 'Short.').length,
      sha256: 'b'.repeat(64),
      origin: 'repo',
    });
    expect(byName.get('claude_md:CLAUDE.md')).toMatchObject({
      bytes: 4,
      sha256: 'a'.repeat(64),
    });
    // The overlay replaces the file, so its imports are not followed.
    expect(byName.has('claude_md:docs/rules.md')).toBe(false);
  });

  it('has no repo parts without a cwd', () => {
    const { home, profile } = setup();
    const parts = measurePrefix({ profile, home });
    expect(parts.every((p) => p.origin !== 'repo')).toBe(true);
  });
});
