import { describe, expect, it } from 'bun:test';
import { configMergeApproval, mergeApprovalMismatch } from './contracts';

describe('configMergeApproval (D1)', () => {
  it('reads orchestrator.mergeApproval', () => {
    expect(configMergeApproval({ orchestrator: { mergeApproval: true } })).toBe(
      true,
    );
    expect(configMergeApproval({ orchestrator: {} })).toBe(false);
    expect(configMergeApproval({})).toBe(false);
  });

  it('knows nothing without a parsed snapshot', () => {
    expect(configMergeApproval(null)).toBeNull();
    expect(
      configMergeApproval({
        orchestrator: { mergeApproval: true },
        error: 'bad JSON',
      }),
    ).toBeNull();
  });
});

describe('mergeApprovalMismatch (D1)', () => {
  const project = (mergeApproval: boolean, config: boolean | null) => ({
    mergeApproval,
    codeSentinelConfig:
      config === null ? null : { orchestrator: { mergeApproval: config } },
  });

  it('flags the flags disagreeing either way', () => {
    expect(mergeApprovalMismatch(project(true, false))).toBe(true);
    expect(mergeApprovalMismatch(project(false, true))).toBe(true);
    expect(mergeApprovalMismatch(project(true, true))).toBe(false);
    expect(mergeApprovalMismatch(project(false, false))).toBe(false);
  });

  it('flags an unread config only when AgentDock expects approval', () => {
    expect(mergeApprovalMismatch(project(true, null))).toBe(true);
    expect(mergeApprovalMismatch(project(false, null))).toBe(false);
  });
});
