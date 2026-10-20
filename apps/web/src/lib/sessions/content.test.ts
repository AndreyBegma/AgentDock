import { describe, expect, test } from 'bun:test';
import {
  canReadContent,
  contentPath,
  contentTitle,
  issueUrl,
  ownerLabel,
} from './content';

describe('canReadContent', () => {
  test('every member reads (ADR-0050); an unknown role does not', () => {
    expect(canReadContent('operator')).toBe(true);
    expect(canReadContent('admin')).toBe(true);
    expect(canReadContent('viewer')).toBe(true);
    expect(canReadContent(undefined)).toBe(false);
  });
});

describe('contentPath', () => {
  test('adds the cursor only when there is one, encoded', () => {
    expect(contentPath('p1', 's1')).toBe('/projects/p1/sessions/s1/content');
    expect(contentPath('p1', 's1', 'a b')).toBe(
      '/projects/p1/sessions/s1/content?cursor=a%20b',
    );
  });
});

describe('contentTitle', () => {
  const item = {
    id: '1',
    kind: 'tool_input' as const,
    toolUseId: 't',
    toolName: 'Bash',
    at: '2026-10-14T10:00:00.000Z',
    text: 'ls',
    truncated: false,
  };
  test('names the tool when the row has one', () => {
    expect(contentTitle(item)).toBe('Tool input · Bash');
    expect(contentTitle({ ...item, kind: 'prompt', toolName: null })).toBe(
      'Prompt',
    );
  });
});

describe('ownerLabel', () => {
  const members = [{ userId: 'u2', email: 'ann@example.com' }];
  test('You, the member email, then the short id', () => {
    expect(ownerLabel('u1', 'u1', members)).toBe('You');
    expect(ownerLabel('u2', 'u1', members)).toBe('ann@example.com');
    expect(ownerLabel('abcdefghijkl', 'u1', members)).toBe('abcdefgh');
    expect(ownerLabel('abcdefghijkl', 'u1', undefined)).toBe('abcdefgh');
  });
});

describe('issueUrl', () => {
  test('only for an owner/name repo', () => {
    expect(issueUrl('AndreyBegma/Nautelle', 201)).toBe(
      'https://github.com/AndreyBegma/Nautelle/issues/201',
    );
    expect(issueUrl('javascript:alert(1)', 1)).toBeNull();
    expect(issueUrl(undefined, 1)).toBeNull();
  });
});
