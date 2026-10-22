import { describe, expect, it } from 'bun:test';
import {
  cardBranchSchema,
  isProtectedPath,
  PROTECTED_PATHS,
} from './branch-policy';

describe('card branch policy (C-148)', () => {
  it('takes card/, feat/ and fix/ branches only', () => {
    expect(cardBranchSchema.safeParse('card/c1-x').success).toBe(true);
    expect(cardBranchSchema.safeParse('feat/2-x').success).toBe(true);
    expect(cardBranchSchema.safeParse('fix/2-x').success).toBe(true);
    expect(cardBranchSchema.safeParse('main').success).toBe(false);
    expect(cardBranchSchema.safeParse('card/').success).toBe(false);
    expect(cardBranchSchema.safeParse('card/../main').success).toBe(false);
  });
});

describe('protected paths (C-148, D-12)', () => {
  it('covers CI, deploy and plugin paths', () => {
    expect(isProtectedPath('.woodpecker/pipeline.yml')).toBe(true);
    expect(isProtectedPath('.woodpecker.yml')).toBe(true);
    expect(isProtectedPath('deploy/README.md')).toBe(true);
    expect(isProtectedPath('plugins/nautelle/plugin.json')).toBe(true);
    expect(isProtectedPath('.claude-plugin/marketplace.json')).toBe(true);
    expect(isProtectedPath('.github/CODEOWNERS')).toBe(true);
  });

  it('leaves other paths alone', () => {
    expect(isProtectedPath('apps/api/src/main.ts')).toBe(false);
    expect(isProtectedPath('docs/deploy/x.md')).toBe(false);
    expect(isProtectedPath('deployment.md')).toBe(false);
    expect(isProtectedPath('a/.woodpecker.yml')).toBe(false);
  });

  it('lists every path the CODEOWNERS file names', () => {
    for (const p of ['.woodpecker/', 'deploy/', 'plugins/', '.claude-plugin/']) {
      expect(PROTECTED_PATHS).toContain(p);
    }
  });
});
