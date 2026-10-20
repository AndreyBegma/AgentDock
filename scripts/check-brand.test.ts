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

  test('allows the names later cards rename', () => {
    const text = [
      "signature: 'X-AgentDock-Signature',",
      "export const CARD_PR_MARKER = 'AgentDock-Card';",
      "const USER_AGENT = 'AgentDock-Webhooks/1';",
      "'https://github.com/AndreyBegma/AgentDock/blob/main/apps/runner/README.md'",
      "root: '/home/dev/AgentDock', cwd: '/home/dev/.wt-AgentDock-i42'",
    ].join('\n');
    expect(findOldBrand(text)).toEqual([]);
  });

  test('still finds the brand next to an allowed name', () => {
    expect(
      findOldBrand('AgentDock signs it with X-AgentDock-Signature'),
    ).toHaveLength(1);
  });
});
