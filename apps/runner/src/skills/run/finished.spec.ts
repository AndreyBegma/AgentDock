import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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

describe('finishedData — patch redaction (C-128, D-15)', () => {
  const envPatch = [
    'diff --git a/.env b/.env',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/.env',
    '@@ -0,0 +1,2 @@',
    '+DATABASE_URL=postgres://u:pw@h/db',
    '+PORT=3000',
    '',
  ].join('\n');
  const files = [{ status: 'A ', path: '.env' }];

  it('ships a patch that adds .env with DATABASE_URL masked', () => {
    const data = finishedData({
      ...base,
      changedFiles: files,
      patch: envPatch,
    });
    expect(data.patch).toBeDefined();
    expect(data.patch).not.toContain('pw@h');
    expect(data.patch).toContain('+DATABASE_URL=•••');
    expect(data.patch).toContain('+++ b/.env');
    expect(data.patchSha256).toBeUndefined();
  });

  it('with keepPatchLocal sends the file list and the hash, never the body', () => {
    const data = finishedData({
      ...base,
      changedFiles: files,
      changedFilesTotal: 1,
      patch: envPatch,
      keepPatchLocal: true,
    });
    expect(data.patch).toBeUndefined();
    expect(data.patchTruncated).toBe(false);
    expect(data.changedFiles).toEqual(files);
    expect(data.patchSha256).toBe(
      createHash('sha256').update(envPatch).digest('hex'),
    );
    expect(JSON.stringify(data)).not.toContain('DATABASE_URL');
  });

  it('with keepPatchLocal and no patch sends no hash', () => {
    const data = finishedData({ ...base, patch: null, keepPatchLocal: true });
    expect(data.patchSha256).toBeUndefined();
  });
});
