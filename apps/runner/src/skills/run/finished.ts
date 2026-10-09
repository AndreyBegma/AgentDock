import {
  SKILL_RUN_CHANGED_FILES_MAX,
  SKILL_RUN_FINISHED_MAX_BYTES,
  SKILL_RUN_PATCH_MAX_BYTES,
  SKILL_RUN_REPORT_MAX_BYTES,
  type SkillRunChangedFile,
  type SkillRunFinishedData,
  type SkillRunTerminalPhase,
  skillRunChangedFileSchema,
  skillRunFinishedDataSchema,
} from '@agentdock/shared/protocol';
import { redact } from '../../pane/redact';

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The longest prefix of `text` within `max` UTF-8 bytes, never a split character. */
export const truncateUtf8 = (
  text: string,
  max: number,
): { text: string; truncated: boolean } => {
  if (bytes(text) <= max) return { text, truncated: false };
  let cut = Buffer.from(text, 'utf8')
    .subarray(0, Math.max(0, max))
    .toString('utf8');
  // A character split at the cut decodes as U+FFFD: drop it.
  while (cut.length > 0 && (cut.endsWith('�') || bytes(cut) > max)) {
    cut = cut.slice(0, -1);
  }
  return { text: cut, truncated: true };
};

/**
 * `git status --porcelain=v1 -z`: `XY path\0`, a rename or copy followed by
 * its old path. Paths the protocol cannot carry are counted, not listed.
 */
export const parsePorcelain = (
  stdout: string,
): { files: SkillRunChangedFile[]; total: number } => {
  const fields = stdout.split('\0');
  const files: SkillRunChangedFile[] = [];
  let total = 0;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status[0] === 'R' || status[0] === 'C') i++;
    total++;
    const parsed = skillRunChangedFileSchema.safeParse({ status, path });
    if (parsed.success && files.length < SKILL_RUN_CHANGED_FILES_MAX) {
      files.push(parsed.data);
    }
  }
  return { files, total };
};

export interface FinishedParts {
  runId: string;
  projectId: string;
  phase: SkillRunTerminalPhase;
  finishedAt: string;
  exitCode: number | null;
  reportText?: string | null;
  changedFiles?: SkillRunChangedFile[];
  changedFilesTotal?: number;
  patch?: string | null;
  pr?: { number: number; url: string };
  error?: string;
}

/**
 * `skill_run.finished` within its caps (spec 24, notes): report 32 KiB,
 * patch 128 KiB, 200 files, 224 KiB serialized — each cut flagged. The
 * report is redacted: it is the one stream text stored in the database.
 */
export const finishedData = (parts: FinishedParts): SkillRunFinishedData => {
  const report = parts.reportText
    ? truncateUtf8(
        redact(parts.reportText.split('\n')).join('\n'),
        SKILL_RUN_REPORT_MAX_BYTES,
      )
    : null;
  let patch = parts.patch
    ? truncateUtf8(parts.patch, SKILL_RUN_PATCH_MAX_BYTES)
    : null;
  const changedFiles = parts.changedFiles ?? [];
  const build = (): SkillRunFinishedData => ({
    runId: parts.runId,
    projectId: parts.projectId,
    phase: parts.phase,
    finishedAt: parts.finishedAt,
    exitCode: parts.exitCode,
    ...(report?.text ? { reportText: report.text } : {}),
    reportTruncated: report?.truncated ?? false,
    changedFiles,
    changedFilesTotal: Math.max(
      parts.changedFilesTotal ?? 0,
      changedFiles.length,
    ),
    ...(patch?.text ? { patch: patch.text } : {}),
    patchTruncated: patch?.truncated ?? false,
    ...(parts.pr ? { prNumber: parts.pr.number, prUrl: parts.pr.url } : {}),
    ...(parts.error ? { error: parts.error.slice(0, 500) } : {}),
  });
  let data = build();
  // JSON escaping can grow a patch past the whole-event cap: cut it further.
  for (
    let size = bytes(JSON.stringify(data));
    size > SKILL_RUN_FINISHED_MAX_BYTES && patch?.text;
  ) {
    const excess = size - SKILL_RUN_FINISHED_MAX_BYTES;
    patch = {
      text: truncateUtf8(
        patch.text,
        Math.max(0, bytes(patch.text) - excess - 1024),
      ).text,
      truncated: true,
    };
    data = build();
    size = bytes(JSON.stringify(data));
  }
  return skillRunFinishedDataSchema.parse(data);
};
