import { describe, expect, it } from 'bun:test';
import { cardTokenSaverSchema } from '../protocol/commands/cards';
import { prefixProposeArgsSchema } from '../protocol/commands/prefix';
import { prefixMeasuredDataSchema } from '../protocol/events/prefix';
import {
  cardPrefixSchema,
  cardTypeOf,
  estPrefixTokens,
  mcpByTypeSchema,
  overlayPartOf,
  overlayPartSchema,
  ruleAppliesTo,
  rulesVersionText,
  skillOfPart,
} from './contracts';

const SHA = 'a'.repeat(64);

describe('cardTypeOf (#751 B4)', () => {
  it('is ci_fix first, then ui for an approved design, else the kind', () => {
    expect(cardTypeOf({ ciFix: true, approvedDesign: true, kind: 'bug' })).toBe(
      'ci_fix',
    );
    expect(
      cardTypeOf({ ciFix: false, approvedDesign: true, kind: 'bug' }),
    ).toBe('ui');
    expect(
      cardTypeOf({ ciFix: false, approvedDesign: false, kind: 'bug' }),
    ).toBe('bug');
    expect(
      cardTypeOf({ ciFix: false, approvedDesign: false, kind: 'feature' }),
    ).toBe('feature');
  });
});

describe('rules (#751 B5, B6)', () => {
  it('applies a rule with no types to every type, else to its own', () => {
    expect(ruleAppliesTo([], 'bug')).toBe(true);
    expect(ruleAppliesTo(['bug'], 'bug')).toBe(true);
    expect(ruleAppliesTo(['feature', 'ui'], 'bug')).toBe(false);
  });

  it('versions the ordered rules, ignoring the order of appliesTo', () => {
    const a = {
      id: 'r1',
      title: 'T',
      description: 'D',
      appliesTo: ['bug', 'ui'],
    };
    const b = { id: 'r2', title: 'U', description: '', appliesTo: [] };
    expect(rulesVersionText([a, b])).toBe(rulesVersionText([b, a].reverse()));
    expect(rulesVersionText([{ ...a, appliesTo: ['ui', 'bug'] }, b])).toBe(
      rulesVersionText([a, b]),
    );
    expect(rulesVersionText([b, a])).not.toBe(rulesVersionText([a, b]));
    expect(rulesVersionText([{ ...a, description: 'E' }, b])).not.toBe(
      rulesVersionText([a, b]),
    );
  });
});

describe('overlay parts (#751 B7)', () => {
  it('takes claude_md, rules and skill:<name>, and nothing else', () => {
    for (const part of ['claude_md', 'rules', 'skill:cs-feature']) {
      expect(overlayPartSchema.safeParse(part).success).toBe(true);
    }
    for (const part of ['skill:', 'skill:../x', 'skill:a/b', 'agents', '']) {
      expect(overlayPartSchema.safeParse(part).success).toBe(false);
    }
    expect(skillOfPart('skill:cs-feature')).toBe('cs-feature');
    expect(skillOfPart('claude_md')).toBeNull();
  });

  it('maps a measured repo part to its overlay part, never a profile one', () => {
    expect(
      overlayPartOf({
        kind: 'claude_md',
        name: 'CLAUDE.md',
        path: 'CLAUDE.md',
        origin: 'repo',
      }),
    ).toBe('claude_md');
    expect(
      overlayPartOf({
        kind: 'skill',
        name: 'release',
        path: '.claude/skills/release/SKILL.md',
        origin: 'repo',
      }),
    ).toBe('skill:release');
    expect(
      overlayPartOf({
        kind: 'claude_md',
        name: 'CLAUDE.md',
        path: '~/.claude/CLAUDE.md',
        origin: 'profile',
      }),
    ).toBeNull();
    expect(
      overlayPartOf({
        kind: 'claude_md',
        name: 'docs.md',
        path: 'docs/guide.md',
        origin: 'repo',
      }),
    ).toBeNull();
  });

  it('a proposal is for a file part only, never the rules', () => {
    const args = {
      runId: 'run_1',
      projectId: 'prj',
      root: '/srv/app',
      sessionId: '6f1c0f2e-6a3b-4c1d-9e2f-1a2b3c4d5e6f',
      profileKey: 'default',
      model: 'sonnet',
      timeoutSec: 120,
    };
    expect(
      prefixProposeArgsSchema.safeParse({ ...args, part: 'claude_md' }).success,
    ).toBe(true);
    expect(
      prefixProposeArgsSchema.safeParse({ ...args, part: 'rules' }).success,
    ).toBe(false);
  });
});

describe('the launch prefix (#751 "API")', () => {
  const prefix = {
    cardType: 'bug',
    mcpAllow: ['github'],
    skillsOff: ['plugin:cs-seo'],
    overlays: [
      { id: 'ov_1', part: 'claude_md', originalSha256: SHA, content: '# x' },
    ],
  };

  it('rides on card.run tokenSaver', () => {
    expect(cardPrefixSchema.safeParse(prefix).success).toBe(true);
    expect(
      cardTokenSaverSchema.safeParse({ enabled: true, mcpAllow: [], prefix })
        .success,
    ).toBe(true);
  });

  it('refuses a rules overlay and an unknown key', () => {
    expect(
      cardPrefixSchema.safeParse({
        ...prefix,
        overlays: [{ ...prefix.overlays[0], part: 'rules' }],
      }).success,
    ).toBe(false);
    expect(cardPrefixSchema.safeParse({ ...prefix, extra: 1 }).success).toBe(
      false,
    );
  });

  it('keys the per-type settings by card type only', () => {
    expect(mcpByTypeSchema.safeParse({ bug: ['github'] }).success).toBe(true);
    expect(mcpByTypeSchema.safeParse({ chore: ['github'] }).success).toBe(
      false,
    );
  });
});

describe('prefix.measured (#751 B1)', () => {
  const part = {
    kind: 'claude_md',
    name: 'CLAUDE.md',
    path: 'CLAUDE.md',
    origin: 'repo',
    bytes: 4000,
    estTokens: estPrefixTokens(4000),
    sha256: SHA,
  };

  it('takes sizes and hashes of the parts', () => {
    expect(estPrefixTokens(4001)).toBe(1001);
    expect(
      prefixMeasuredDataSchema.safeParse({
        runId: 'run_1',
        launchKind: 'card',
        parts: [part, { ...part, kind: 'mcp', name: 'github', path: '' }],
      }).success,
    ).toBe(true);
  });

  it('refuses a duplicate part, an absolute path and content', () => {
    const base = { runId: 'run_1', launchKind: 'card' };
    expect(
      prefixMeasuredDataSchema.safeParse({ ...base, parts: [part, part] })
        .success,
    ).toBe(false);
    expect(
      prefixMeasuredDataSchema.safeParse({
        ...base,
        parts: [{ ...part, path: '/etc/passwd' }],
      }).success,
    ).toBe(false);
    expect(
      prefixMeasuredDataSchema.safeParse({
        ...base,
        parts: [{ ...part, content: '# secret' }],
      }).success,
    ).toBe(false);
  });
});
