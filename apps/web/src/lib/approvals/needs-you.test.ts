import { describe, expect, test } from 'bun:test';
import type {
  ActionRequestSummary,
  ApprovalItemView,
  ApprovalsView,
} from '@nautelle/shared';
import { needsYouItems, pendingApprovalCount } from './needs-you';

const request = (
  over: Partial<ActionRequestSummary>,
): ActionRequestSummary => ({
  id: 'a',
  projectId: 'p',
  runnerId: 'r',
  sessionId: null,
  requestedById: null,
  kind: 'tool_use',
  summary: '',
  args: { toolName: 'Bash' },
  status: 'pending',
  decidedById: null,
  decidedAt: null,
  note: null,
  expiresAt: '2026-10-14T10:05:00.000Z',
  createdAt: '2026-10-14T10:00:00.000Z',
  ...over,
});

const pr = (n: number, waitingSince: string): ApprovalItemView =>
  ({ id: `m${n}`, pr: n, waitingSince }) as ApprovalItemView;

const view = (waiting: ApprovalItemView[]): ApprovalsView =>
  ({ waiting, recent: [] }) as unknown as ApprovalsView;

describe('needsYouItems (C-284)', () => {
  test('lists pending requests by expiry, then pull requests oldest first', () => {
    const items = needsYouItems(
      view([
        pr(2, '2026-10-14T10:00:00.000Z'),
        pr(1, '2026-10-14T09:00:00.000Z'),
      ]),
      [
        request({ id: 'late', expiresAt: '2026-10-14T11:00:00.000Z' }),
        request({ id: 'done', status: 'denied' }),
        request({ id: 'soon', expiresAt: '2026-10-14T10:01:00.000Z' }),
      ],
    );
    expect(items.map((item) => item.key)).toEqual([
      'request:soon',
      'request:late',
      'pr:1',
      'pr:2',
    ]);
  });

  test('works while either side is still loading', () => {
    expect(needsYouItems(undefined, undefined)).toEqual([]);
    expect(needsYouItems(undefined, [request({})])).toHaveLength(1);
  });
});

describe('pendingApprovalCount', () => {
  test('counts waiting pull requests and pending requests', () => {
    expect(
      pendingApprovalCount(view([pr(1, '2026-10-14T09:00:00.000Z')]), [
        request({}),
        request({ id: 'b', status: 'executed' }),
      ]),
    ).toBe(2);
    expect(pendingApprovalCount(undefined, undefined)).toBe(0);
  });
});
