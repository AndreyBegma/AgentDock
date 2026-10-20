import { describe, expect, test } from 'bun:test';
import { findOldBrand } from './check-brand';

describe('findOldBrand', () => {
  test('finds the old name in a message', () => {
    expect(
      findOldBrand("ok\nnot_linked: 'This chat is not linked to AgentDock.',"),
    ).toEqual([
      { line: 2, text: "not_linked: 'This chat is not linked to AgentDock.'," },
    ]);
  });

  test('passes the new name', () => {
    expect(findOldBrand('Open in Nautelle')).toEqual([]);
  });

  test('allows the legacy names and the ones a later card renames', () => {
    const text = [
      "signature: 'X-AgentDock-Signature',",
      "export const LEGACY_CARD_PR_MARKER = 'AgentDock-Card';",
      "'https://github.com/AndreyBegma/AgentDock/blob/main/apps/runner/README.md'",
      "root: '/home/dev/AgentDock', cwd: '/home/dev/.wt-AgentDock-i42'",
    ].join('\n');
    expect(findOldBrand(text)).toEqual([]);
  });

  test('finds the old webhook User-Agent (ADR-0073)', () => {
    expect(
      findOldBrand("const USER_AGENT = 'AgentDock-Webhooks/1';"),
    ).toHaveLength(1);
  });

  test('still finds the brand next to an allowed name', () => {
    expect(
      findOldBrand('AgentDock signs it with X-AgentDock-Signature'),
    ).toHaveLength(1);
  });
});
