import { describe, expect, it } from 'bun:test';
import {
  APPROVAL_NOTE_MAX_BYTES,
  approvalCommands,
  commands,
  PR_INSPECT_FILES_MAX,
  type PrInspection,
  prApproveArgsSchema,
  prInspectArgsSchema,
  prInspectionSchema,
  prRequestChangesArgsSchema,
  prVoidApprovalArgsSchema,
} from '../index';

const target = { projectId: 'prj_widget', root: '/srv/dev/widget', pr: 51 };
const HEAD = 'a'.repeat(40);
const decision = {
  ...target,
  headSha: HEAD,
  by: 'ada@example.com',
  at: '2026-10-08T10:00:00.000Z',
};

const inspection: PrInspection = {
  number: 51,
  url: 'https://github.com/acme/widget/pull/51',
  title: 'feat: widget',
  body: 'Closes #42',
  state: 'open',
  headSha: HEAD,
  additions: 120,
  deletions: 4,
  changedFiles: 3,
  files: [{ path: 'src/widget.ts', additions: 100, deletions: 2 }],
  filesTruncated: false,
  checks: 'green',
  checkList: [{ name: 'ci', state: 'pass' }],
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  fetchedAt: '2026-10-08T10:00:00.000Z',
};

describe('approval commands', () => {
  it('are all in the allowlist, registered together with the runner handlers', () => {
    for (const [name, definition] of Object.entries(approvalCommands)) {
      expect(Object.hasOwn(commands, name)).toBe(true);
      expect(commands[name as keyof typeof commands]).toBe(definition);
    }
  });

  it('let a viewer inspect and only an operator decide (D9)', () => {
    expect(approvalCommands['pr.inspect'].minRole).toBe('viewer');
    expect(approvalCommands['pr.approve'].minRole).toBe('operator');
    expect(approvalCommands['pr.requestChanges'].minRole).toBe('operator');
    expect(approvalCommands['pr.voidApproval'].minRole).toBe('operator');
  });
});

describe('pr.inspect', () => {
  it('takes a project and a positive PR number', () => {
    expect(prInspectArgsSchema.safeParse(target).success).toBe(true);
    expect(prInspectArgsSchema.safeParse({ ...target, pr: 0 }).success).toBe(
      false,
    );
    expect(
      prInspectArgsSchema.safeParse({ ...target, root: 'widget' }).success,
    ).toBe(false);
    expect(
      prInspectArgsSchema.safeParse({ ...target, extra: true }).success,
    ).toBe(false);
  });

  it('returns the head a decision binds to', () => {
    expect(prInspectionSchema.safeParse(inspection).success).toBe(true);
    expect(
      prInspectionSchema.safeParse({ ...inspection, headSha: 'abc' }).success,
    ).toBe(false);
  });

  it(`caps the file list at ${PR_INSPECT_FILES_MAX}`, () => {
    const files = Array.from({ length: PR_INSPECT_FILES_MAX + 1 }, (_, i) => ({
      path: `f${i}`,
      additions: 1,
      deletions: 0,
    }));
    expect(prInspectionSchema.safeParse({ ...inspection, files }).success).toBe(
      false,
    );
  });
});

describe('decisions', () => {
  it('bind to a full lower-case commit id', () => {
    expect(prApproveArgsSchema.safeParse(decision).success).toBe(true);
    for (const headSha of ['A'.repeat(40), 'a'.repeat(39), 'g'.repeat(40)]) {
      expect(
        prApproveArgsSchema.safeParse({ ...decision, headSha }).success,
      ).toBe(false);
    }
  });

  it('need a note to request changes, at most 4 KB (D7)', () => {
    expect(prRequestChangesArgsSchema.safeParse(decision).success).toBe(false);
    expect(
      prRequestChangesArgsSchema.safeParse({ ...decision, note: '  \n' })
        .success,
    ).toBe(false);
    expect(
      prRequestChangesArgsSchema.safeParse({
        ...decision,
        note: 'é'.repeat(APPROVAL_NOTE_MAX_BYTES / 2),
      }).success,
    ).toBe(true);
    expect(
      prRequestChangesArgsSchema.safeParse({
        ...decision,
        note: `${'é'.repeat(APPROVAL_NOTE_MAX_BYTES / 2)}x`,
      }).success,
    ).toBe(false);
  });

  it('void an approval by the head that was approved (D6)', () => {
    const { by: _by, ...voided } = decision;
    expect(prVoidApprovalArgsSchema.safeParse(voided).success).toBe(true);
    expect(prVoidApprovalArgsSchema.safeParse(decision).success).toBe(false);
  });
});
