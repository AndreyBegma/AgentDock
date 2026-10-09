import { describe, expect, it } from 'bun:test';
import {
  isSkillRunEventType,
  SKILL_RUN_CHANGED_FILES_MAX,
  SKILL_RUN_PATCH_MAX_BYTES,
  SKILL_RUN_REPORT_MAX_BYTES,
  skillRunFinishedDataSchema,
  skillRunPhaseChangedDataSchema,
} from '../index';

const finished = {
  runId: 'cmg1run0001',
  projectId: 'prj_1',
  phase: 'succeeded',
  finishedAt: '2026-10-08T12:00:00.000Z',
  exitCode: 0,
  reportText: 'Estimate: M',
  reportTruncated: false,
  changedFiles: [
    { status: ' M', path: 'src/a.ts' },
    { status: '??', path: 'notes.md' },
  ],
  changedFilesTotal: 2,
  patch: 'diff --git a/src/a.ts b/src/a.ts\n',
  patchTruncated: false,
} as const;

describe('skill run events', () => {
  it('knows its two types', () => {
    expect(isSkillRunEventType('skill_run.phase_changed')).toBe(true);
    expect(isSkillRunEventType('skill_run.finished')).toBe(true);
    expect(isSkillRunEventType('skill_run.log')).toBe(false);
  });

  it('parses a phase change', () => {
    expect(
      skillRunPhaseChangedDataSchema.safeParse({
        runId: 'r1',
        projectId: 'p',
        phase: 'running',
        at: '2026-10-08T12:00:00.000Z',
        tmuxSession: 'agentdock-run-a1b2c3',
        worktree: '/home/dev/.wt-repo-run-a1b2c3',
        branch: 'run/a1b2c3-estimate',
      }).success,
    ).toBe(true);
  });

  it('parses a finished report run and a killed run', () => {
    expect(skillRunFinishedDataSchema.safeParse(finished).success).toBe(true);
    expect(
      skillRunFinishedDataSchema.safeParse({
        ...finished,
        phase: 'timed_out',
        exitCode: null,
        reportText: undefined,
        patch: undefined,
        changedFiles: [],
        changedFilesTotal: 0,
      }).success,
    ).toBe(true);
  });

  it('parses a pr run', () => {
    expect(
      skillRunFinishedDataSchema.safeParse({
        ...finished,
        prNumber: 81,
        prUrl: 'https://github.com/acme/repo/pull/81',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a non-terminal phase', { ...finished, phase: 'running' }],
    [
      'a patch over the cap',
      { ...finished, patch: 'x'.repeat(SKILL_RUN_PATCH_MAX_BYTES + 1) },
    ],
    [
      'a report over the cap',
      { ...finished, reportText: 'x'.repeat(SKILL_RUN_REPORT_MAX_BYTES + 1) },
    ],
    [
      'too many files',
      {
        ...finished,
        changedFiles: Array.from(
          { length: SKILL_RUN_CHANGED_FILES_MAX + 1 },
          (_, i) => ({ status: ' M', path: `f${i}` }),
        ),
        changedFilesTotal: 999,
      },
    ],
    ['a total below the list', { ...finished, changedFilesTotal: 1 }],
    [
      'an escaping path',
      { ...finished, changedFiles: [{ status: ' M', path: '../x' }] },
    ],
    [
      'a bad status',
      { ...finished, changedFiles: [{ status: 'ZZ', path: 'x' }] },
    ],
    [
      'a pr url without a number',
      { ...finished, prUrl: 'https://github.com/a/b/pull/1' },
    ],
    [
      'an http pr url',
      { ...finished, prNumber: 1, prUrl: 'http://github.com/a/b/pull/1' },
    ],
  ])('rejects %s', (_, data) => {
    expect(skillRunFinishedDataSchema.safeParse(data).success).toBe(false);
  });

  it('keeps the whole data under the event budget', () => {
    const files = Array.from(
      { length: SKILL_RUN_CHANGED_FILES_MAX },
      (_, i) => ({
        status: ' M',
        path: `${'d'.repeat(500)}/${i}`,
      }),
    );
    expect(
      skillRunFinishedDataSchema.safeParse({
        ...finished,
        reportText: 'r'.repeat(SKILL_RUN_REPORT_MAX_BYTES),
        patch: 'p'.repeat(SKILL_RUN_PATCH_MAX_BYTES),
        changedFiles: files,
        changedFilesTotal: files.length,
      }).success,
    ).toBe(false);
  });
});
