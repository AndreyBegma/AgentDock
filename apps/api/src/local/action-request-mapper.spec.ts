import type { ActionRequest } from '@prisma/client';
import {
  actionRequestBody,
  actionRequestTitle,
  toActionRequestView,
} from './action-request-mapper';

const HEAD = '0b6445a1'.padEnd(40, 'c');
const PR_ARGS = {
  pr: 51,
  headSha: HEAD,
  title: 'feat: widget',
  url: 'https://github.com/acme/widget/pull/51',
};

const row = (extra: Partial<ActionRequest> = {}): ActionRequest => ({
  id: 'ar_1',
  projectId: 'prj_1',
  runnerId: 'run_1',
  sessionId: null,
  requestedById: 'usr_1',
  kind: 'pr_approve',
  summary: 'Please approve',
  args: PR_ARGS,
  status: 'pending',
  decidedById: null,
  decidedAt: null,
  note: null,
  result: null,
  expiresAt: new Date('2026-10-18T10:00:00.000Z'),
  createdAt: new Date('2026-10-17T10:00:00.000Z'),
  ...extra,
});

describe('action-request mapper (C-110)', () => {
  it('carries the head and title a pr_approve request was bound to', () => {
    expect(toActionRequestView(row()).pr).toEqual({
      ...PR_ARGS,
      diffUrl: `https://github.com/acme/widget/pull/51/files/${HEAD}`,
    });
  });

  it('has no PR for another kind, or a request stored without a head', () => {
    expect(
      toActionRequestView(row({ kind: 'orchestrator_stop', args: {} })).pr,
    ).toBeNull();
    expect(toActionRequestView(row({ args: { pr: 51 } })).pr).toBeNull();
  });

  it('names the short head in the title and the PR and diff in the body', () => {
    expect(actionRequestTitle('pr_approve', PR_ARGS)).toBe(
      'A session asks to approve PR #51 at 0b6445a',
    );
    expect(actionRequestTitle('pr_approve', { pr: 51 })).toBe(
      'A session asks to approve PR #51',
    );
    expect(actionRequestBody('pr_approve', PR_ARGS, 'Please approve')).toBe(
      `feat: widget · https://github.com/acme/widget/pull/51/files/${HEAD} · Please approve`,
    );
    expect(actionRequestBody('tool_use', { toolName: 'Bash' }, 'Hi')).toBe(
      'Hi',
    );
  });
});
