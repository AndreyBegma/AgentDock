import { describe, expect, it } from 'bun:test';
import {
  SKILL_RUN_FINISHED_MAX_BYTES,
  SKILL_RUN_PATCH_MAX_BYTES,
  SKILL_RUN_REPORT_MAX_BYTES,
} from '@agentdock/shared/protocol';
import { finishedData, parsePorcelain, truncateUtf8 } from './finished';

const base = {
  runId: 'run_1',
  projectId: 'prj_1',
  phase: 'succeeded' as const,
  finishedAt: '2026-10-09T12:00:00.000Z',
  exitCode: 0,
};

describe('truncateUtf8', () => {
  it('never splits a character', () => {
    expect(truncateUtf8('héllo', 2)).toEqual({ text: 'h', truncated: true });
    expect(truncateUtf8('héllo', 3)).toEqual({ text: 'hé', truncated: true });
    expect(truncateUtf8('héllo', 100)).toEqual({
      text: 'héllo',
      truncated: false,
    });
  });
});

describe('parsePorcelain', () => {
  it('reads -z entries, renames included, and counts paths it cannot carry', () => {
    const out = [
      ' M src/app.txt',
      '?? notes.md',
      'R  new.txt',
      'old.txt',
      '?? bad\u0001name',
      '',
    ].join('\0');
    expect(parsePorcelain(out)).toEqual({
      files: [
        { status: ' M', path: 'src/app.txt' },
        { status: '??', path: 'notes.md' },
        { status: 'R ', path: 'new.txt' },
      ],
      total: 4,
    });
    expect(parsePorcelain('')).toEqual({ files: [], total: 0 });
  });
});

describe('finishedData', () => {
  it('caps the report, the patch and the file list, and flags each cut', () => {
    const files = Array.from({ length: 250 }, (_, i) => ({
      status: ' M',
      path: `f${i}.txt`,
    }));
    const data = finishedData({
      ...base,
      reportText: 'r'.repeat(SKILL_RUN_REPORT_MAX_BYTES + 10),
      patch: 'p'.repeat(SKILL_RUN_PATCH_MAX_BYTES + 10),
      changedFiles: files.slice(0, 200),
      changedFilesTotal: 250,
    });
    expect(data.reportTruncated).toBe(true);
    expect(data.reportText?.length).toBe(SKILL_RUN_REPORT_MAX_BYTES);
    expect(data.patchTruncated).toBe(true);
    expect(data.patch?.length).toBe(SKILL_RUN_PATCH_MAX_BYTES);
    expect(data.changedFiles).toHaveLength(200);
    expect(data.changedFilesTotal).toBe(250);
  });

  it('cuts a patch that JSON escaping grows past the whole-event cap', () => {
    const data = finishedData({
      ...base,
      reportText: '"'.repeat(SKILL_RUN_REPORT_MAX_BYTES),
      patch: '\n"'.repeat(SKILL_RUN_PATCH_MAX_BYTES / 2),
    });
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(
      SKILL_RUN_FINISHED_MAX_BYTES,
    );
    expect(data.patchTruncated).toBe(true);
  });

  it('redacts the report, the one stream text stored', () => {
    const data = finishedData({
      ...base,
      reportText: `key sk-${'a'.repeat(30)}`,
    });
    expect(data.reportText).toBe('key •••');
  });

  it('carries the PR and the error', () => {
    const data = finishedData({
      ...base,
      phase: 'failed',
      exitCode: 1,
      pr: { number: 7, url: 'https://github.com/acme/widget/pull/7' },
      error: 'x'.repeat(600),
    });
    expect(data.prNumber).toBe(7);
    expect(data.prUrl).toBe('https://github.com/acme/widget/pull/7');
    expect(data.error).toHaveLength(500);
    expect(data.reportText).toBeUndefined();
    expect(data.patch).toBeUndefined();
  });
});
