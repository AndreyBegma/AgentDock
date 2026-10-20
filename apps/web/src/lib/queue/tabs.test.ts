import { describe, expect, test } from 'bun:test';
import { approvalsHref, approvalsRedirectTarget } from './tabs';

describe('approvalsRedirectTarget (C-284)', () => {
  test('sends the bare old URL to the Approvals tab', () => {
    expect(approvalsRedirectTarget('p1', {})).toBe(
      '/projects/p1/queue?tab=approvals',
    );
    expect(approvalsRedirectTarget('p1', {})).toBe(approvalsHref('p1'));
  });

  test('keeps a notification’s action request', () => {
    expect(approvalsRedirectTarget('p1', { actionRequest: 'ar_1' })).toBe(
      '/projects/p1/queue?tab=approvals&actionRequest=ar_1',
    );
  });

  test('keeps every other parameter, repeated ones too', () => {
    expect(
      approvalsRedirectTarget('p1', { a: ['1', '2'], b: 'x y', c: undefined }),
    ).toBe('/projects/p1/queue?tab=approvals&a=1&a=2&b=x+y');
  });

  test('drops the old page’s own tab', () => {
    expect(
      approvalsRedirectTarget('p1', { tab: 'action-requests', x: '1' }),
    ).toBe('/projects/p1/queue?tab=approvals&x=1');
  });
});
