import type {
  InstalledSkillView,
  SkillPreviewView,
  SkillRunView,
} from '@agentdock/shared';
import {
  isRunnableSkill,
  type SkillFile,
  type SkillFrontmatter,
  type SkillRunChangedFile,
  skillPhaseToRunStatus,
} from '@agentdock/shared/protocol';
import type {
  InstalledSkill,
  Prisma,
  SkillInstallPreview,
  SkillRun,
} from '@prisma/client';

export const toInstalledSkillView = (
  row: InstalledSkill,
): InstalledSkillView => ({
  id: row.id,
  scope: row.scope,
  runtime: row.runtime,
  name: row.name,
  invocation: row.invocation,
  path: row.path,
  projectId: row.projectId,
  profileKey: row.profileKey,
  description: row.description,
  argumentHint: row.argumentHint,
  source: row.source,
  commit: row.commit,
  contentHash: row.contentHash,
  pluginVersion: row.pluginVersion,
  runnable: isRunnableSkill(row.invocation),
  seenAt: row.seenAt.toISOString(),
});

/** What inspect stored: `files` and `frontmatter` were validated before they were written. */
export interface PreviewPayload {
  path: string;
  files: SkillFile[];
}

export const toPreviewView = (row: SkillInstallPreview): SkillPreviewView => {
  const payload = row.files as unknown as PreviewPayload;
  return {
    previewId: row.id,
    runnerId: row.runnerId,
    projectId: row.projectId,
    source: row.source,
    skillId: row.skillId,
    path: payload.path,
    commit: row.commit,
    contentHash: row.contentHash,
    frontmatter: row.frontmatter as SkillFrontmatter,
    files: payload.files,
    expiresAt: row.expiresAt.toISOString(),
  };
};

export const toSkillRunView = (
  row: SkillRun,
  projectId: string,
): SkillRunView => ({
  runId: row.runId,
  projectId,
  skill: row.skill,
  args: row.args,
  profileKey: row.profileKey,
  model: row.model,
  permissionMode: row.permissionMode,
  output: row.output,
  phase: row.phase,
  status: skillPhaseToRunStatus(row.phase),
  worktree: row.worktree,
  branch: row.branch,
  tmuxSession: row.tmuxSession,
  timeoutSec: row.timeoutSec,
  exitCode: row.exitCode,
  reportText: row.reportText,
  reportTruncated: row.reportTruncated,
  changedFiles: row.changedFiles as SkillRunChangedFile[] | null,
  changedFilesTotal: row.changedFilesTotal,
  patch: row.patch,
  patchTruncated: row.patchTruncated,
  error: row.error,
  prNumber: row.prNumber,
  prUrl: row.prUrl,
  queuedAt: row.queuedAt.toISOString(),
  startedAt: row.startedAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

export const asJson = (value: object): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;
