import type { RunDetail, RunStatus } from '../history/contracts';
import type {
  OrchestratorPermissionMode,
  Runtime,
  SkillCatalogItem,
  SkillFile,
  SkillFrontmatter,
  SkillRunChangedFile,
  SkillRunOutput,
  SkillRunPhase,
  SkillScope,
} from '../protocol';

/**
 * HTTP contracts of skills (docs/specs/24-skills.md "API"): the catalog,
 * inspect and install, the inventory, and skill runs.
 */

/** D2: how long an inspected skill stays installable. */
export const SKILL_PREVIEW_TTL_MS = 15 * 60 * 1000;

/** `GET /skills/catalog?q=&runnerId=`. */
export interface SkillCatalogView {
  items: SkillCatalogItem[];
}

/** `POST /skills/inspect` body. `projectId` binds the previews to one project. */
export interface SkillInspectRequest {
  runnerId: string;
  source: string;
  skillId?: string;
  ref?: string;
  projectId?: string;
}

/** One inspected skill, installable through its `previewId` until `expiresAt`. */
export interface SkillPreviewView {
  previewId: string;
  runnerId: string;
  projectId: string | null;
  source: string;
  skillId: string;
  /** The skill directory in the repository (`skills/estimate`). */
  path: string;
  commit: string;
  contentHash: string;
  frontmatter: SkillFrontmatter;
  files: SkillFile[];
  expiresAt: string;
}

/** `POST /skills/inspect` answer: one preview per skill the repository holds. */
export interface SkillInspectView {
  commit: string;
  previews: SkillPreviewView[];
}

/** Body of both install routes. */
export interface SkillInstallRequest {
  previewId: string;
  runtime: Runtime;
}

/** `POST /runners/:id/profiles/:key/skills/install` answer. */
export interface SkillProfileInstallView {
  path: string;
}

/** One row of the inventory (D6). */
export interface InstalledSkillView {
  id: string;
  scope: SkillScope;
  runtime: Runtime;
  name: string;
  /** What a run sends as `/<invocation> <args>` (D8). */
  invocation: string;
  path: string;
  projectId: string | null;
  profileKey: string | null;
  description: string | null;
  argumentHint: string | null;
  source: string | null;
  commit: string | null;
  contentHash: string | null;
  pluginVersion: string | null;
  /** False for the orchestrator and worker skills (D8). */
  runnable: boolean;
  seenAt: string;
}

/**
 * `GET /projects/:projectId/skills`: this project's skills and the profile
 * and plugin skills of its runner. `scannedAt` is the last scan, null if none.
 */
export interface InstalledSkillsView {
  items: InstalledSkillView[];
  scannedAt: string | null;
}

/**
 * `POST /projects/:projectId/skill-runs` body. Defaults: the project's
 * default profile (#10), the project's orchestrator permission mode (#17 D3),
 * `SKILL_RUN_DEFAULT_TIMEOUT_SEC`.
 */
export interface SkillRunRequest {
  skill: string;
  args: string;
  profileKey?: string;
  /** A model alias or id (`opus`, `sonnet`, `haiku`, `fable`, `claude-opus-5-5`). */
  model: string;
  permissionMode?: OrchestratorPermissionMode;
  output: SkillRunOutput;
  timeoutSec?: number;
}

/** A skill run: its `skill_runs` row and its #21 status. */
export interface SkillRunView {
  runId: string;
  projectId: string;
  skill: string;
  args: string;
  profileKey: string;
  model: string;
  permissionMode: OrchestratorPermissionMode;
  output: SkillRunOutput;
  phase: SkillRunPhase;
  /** `runs.status`, mapped from `phase` (D12). */
  status: RunStatus;
  worktree: string | null;
  branch: string | null;
  tmuxSession: string | null;
  timeoutSec: number;
  exitCode: number | null;
  reportText: string | null;
  reportTruncated: boolean;
  changedFiles: SkillRunChangedFile[] | null;
  changedFilesTotal: number | null;
  /** At most 128 KiB; the full patch stays on the runner. */
  patch: string | null;
  patchTruncated: boolean;
  error: string | null;
  prNumber: number | null;
  prUrl: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** `GET /projects/:projectId/skill-runs/:runId`. */
export interface SkillRunDetail extends SkillRunView {
  run: RunDetail;
}

/**
 * Live event on `run:<projectId>:<runId>` when the phase changes; the log
 * itself arrives as `RUN_LOG_LIVE_EVENTS`. `run.updated` on `project:<id>`
 * is published too (#21).
 */
export const SKILL_RUN_PHASE_LIVE_EVENT = 'skill_run.phase';

export interface SkillRunPhaseLiveChange {
  runId: string;
  phase: SkillRunPhase;
  status: RunStatus;
}

/** Stable codes in the `error` field of a skills route's error body. */
export const SKILLS_ERROR = {
  notFound: 'not_found',
  forbidden: 'forbidden',
  invalidArgs: 'invalid_args',
  /** The invocation is not in this project's inventory. */
  skillNotFound: 'skill_not_found',
  /** The preview is unknown, another user's, or for another runner or project. */
  previewNotFound: 'preview_not_found',
  previewExpired: 'preview_expired',
  previewConsumed: 'preview_consumed',
  /** The skill content moved since the preview (D3); nothing was written. */
  changedSincePreview: 'changed_since_preview',
  /** The install branch or directory already exists. */
  alreadyExists: 'already_exists',
  /** The skill is over the runner's file or size cap. */
  tooLarge: 'too_large',
  /** skills.sh or GitHub did not answer the runner. */
  upstreamUnavailable: 'upstream_unavailable',
  /** The orchestrator or a worker skill (D8); nothing was sent. */
  notRunnable: 'not_runnable',
  /** A `codex` profile (out of scope until M4); nothing was sent. */
  unsupportedRuntime: 'unsupported_runtime',
  /** Neither the request nor the project names a profile. */
  noProfile: 'no_profile',
  /** The profile is not on the project's runner, or is missing there. */
  unknownProfile: 'unknown_profile',
  /** The run already reached a terminal phase. */
  runFinished: 'run_finished',
  /** The runner command is not wired yet, or the runner is unreachable. */
  commandUnavailable: 'command_unavailable',
  /** The runner answered with an error not mapped to its own code. */
  commandFailed: 'command_failed',
  /** The command was sent and no result came back in time. */
  runnerTimeout: 'runner_timeout',
} as const;
export type SkillsErrorCode = (typeof SKILLS_ERROR)[keyof typeof SKILLS_ERROR];

export interface SkillsErrorBody {
  statusCode: number;
  error: SkillsErrorCode;
  message: string;
  /** The run, when one was created before the failure. */
  runId?: string;
}
