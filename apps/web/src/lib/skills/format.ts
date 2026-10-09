import {
  type InstalledSkillView,
  SKILLS_ERROR,
  type SkillRunRequest,
} from '@agentdock/shared';
import {
  isTerminalSkillRunPhase,
  type OrchestratorPermissionMode,
  SKILL_RUN_ARGS_MAX_BYTES,
  SKILL_RUN_MAX_TIMEOUT_SEC,
  SKILL_RUN_MIN_TIMEOUT_SEC,
  type SkillFile,
  type SkillFrontmatter,
  type SkillRunPhase,
  type SkillScope,
} from '@agentdock/shared/protocol';
import { ApiError, describeError } from '../api';
import { safeHttpsUrl } from '../fleet/format';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const SKILL_PHASE_LABEL: Record<SkillRunPhase, string> = {
  queued: 'queued',
  preparing: 'preparing',
  running: 'running',
  collecting: 'collecting',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timed out',
};

export const SKILL_PHASE_TONE: Record<SkillRunPhase, Tone> = {
  queued: 'neutral',
  preparing: 'warn',
  running: 'ok',
  collecting: 'warn',
  succeeded: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
  timed_out: 'danger',
};

/** True while the runner still works on the run (spinner, live log, cancel). */
export const isActivePhase = (phase: SkillRunPhase): boolean =>
  !isTerminalSkillRunPhase(phase);

export const SCOPE_ORDER: readonly SkillScope[] = [
  'project',
  'profile',
  'plugin',
];

export const SCOPE_LABEL: Record<SkillScope, string> = {
  project: 'Project',
  profile: 'Runtime profile',
  plugin: 'Plugin',
};

export interface SkillGroup {
  scope: SkillScope;
  items: InstalledSkillView[];
}

/** The inventory by scope, in a fixed order, empty scopes left out. */
export function groupBySkillScope(items: InstalledSkillView[]): SkillGroup[] {
  return SCOPE_ORDER.map((scope) => ({
    scope,
    items: items
      .filter((item) => item.scope === scope)
      .sort((a, b) => a.invocation.localeCompare(b.invocation)),
  })).filter((group) => group.items.length > 0);
}

/** Where a skill came from: `owner/repo@abc1234`, the plugin version, or a dash. */
export function provenanceLabel(item: InstalledSkillView): string {
  if (item.source) {
    return item.commit
      ? `${item.source}@${item.commit.slice(0, 7)}`
      : item.source;
  }
  if (item.pluginVersion) return `plugin ${item.pluginVersion}`;
  return '—';
}

/** Claude runtime profile keys seen in the inventory; the operator's only list (plan, question 1). */
export function profileKeysFrom(
  items: InstalledSkillView[],
  defaultProfileId: string | null,
): string[] {
  const keys = new Set<string>();
  if (defaultProfileId) keys.add(defaultProfileId);
  for (const item of items) {
    if (
      item.scope === 'profile' &&
      item.runtime === 'claude' &&
      item.profileKey
    ) {
      keys.add(item.profileKey);
    }
  }
  return [...keys].sort();
}

export const SKILL_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export const SKILL_OUTPUT_LABEL = {
  report: 'Report — nothing is pushed',
  pr: 'Pull request — changes go to a PR',
} as const;

export const PERMISSION_MODE_WARNING: Partial<
  Record<OrchestratorPermissionMode, string>
> = {
  acceptEdits:
    'Edits are accepted without asking. The skill can change any file in the run worktree.',
  manual:
    'A headless run cannot answer permission prompts, so anything that needs one will fail.',
  bypassPermissions:
    'All permission checks are off. The skill can run any command with this profile’s credentials.',
};

/** The warning for a mode other than `auto` (spec UI); null for `auto` and for "project default". */
export const permissionWarning = (
  mode: OrchestratorPermissionMode | '',
): string | null =>
  mode === '' ? null : (PERMISSION_MODE_WARNING[mode] ?? null);

export const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

export interface RunForm {
  args: string;
  profileKey: string;
  model: string;
  permissionMode: OrchestratorPermissionMode | '';
  output: 'report' | 'pr';
  /** Minutes, as typed. Empty = the runner default. */
  timeoutMinutes: string;
}

export const EMPTY_RUN_FORM: RunForm = {
  args: '',
  profileKey: '',
  model: 'sonnet',
  permissionMode: '',
  output: 'report',
  timeoutMinutes: '',
};

/** Minutes as typed → seconds; undefined when empty, null when invalid or out of range. */
export function parseTimeoutMinutes(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed) * 60;
  return seconds >= SKILL_RUN_MIN_TIMEOUT_SEC &&
    seconds <= SKILL_RUN_MAX_TIMEOUT_SEC
    ? seconds
    : null;
}

export type RunFormProblem = 'args_too_long' | 'timeout' | 'model';

export function runFormProblem(form: RunForm): RunFormProblem | null {
  if (utf8Bytes(form.args) > SKILL_RUN_ARGS_MAX_BYTES) return 'args_too_long';
  if (parseTimeoutMinutes(form.timeoutMinutes) === null) return 'timeout';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(form.model.trim())) {
    return 'model';
  }
  return null;
}

export const RUN_FORM_PROBLEM_TEXT: Record<RunFormProblem, string> = {
  args_too_long: `The arguments are over ${SKILL_RUN_ARGS_MAX_BYTES / 1024} KB.`,
  timeout: `The timeout must be whole minutes between ${SKILL_RUN_MIN_TIMEOUT_SEC / 60} and ${SKILL_RUN_MAX_TIMEOUT_SEC / 60}.`,
  model: 'Use a model alias or id such as sonnet.',
};

/** The request body; only the fields the person set are sent. */
export function toRunRequest(skill: string, form: RunForm): SkillRunRequest {
  const timeoutSec = parseTimeoutMinutes(form.timeoutMinutes);
  return {
    skill,
    args: form.args,
    model: form.model.trim(),
    output: form.output,
    ...(form.profileKey ? { profileKey: form.profileKey } : {}),
    ...(form.permissionMode ? { permissionMode: form.permissionMode } : {}),
    ...(typeof timeoutSec === 'number' ? { timeoutSec } : {}),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const totalBytes = (files: readonly SkillFile[]): number =>
  files.reduce((sum, file) => sum + file.size, 0);

/** `allowed-tools` is a string or a list in a SKILL.md; the list either way. */
export function allowedToolsOf(frontmatter: SkillFrontmatter): string[] {
  const raw = frontmatter['allowed-tools'];
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return raw
    .split(/[\s,]+/)
    .map((tool) => tool.trim())
    .filter((tool) => tool !== '');
}

/** The first 7 characters of a hash, for a label. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? (error.code as string | undefined) : undefined;

export const isCommandUnavailable = (error: unknown): boolean =>
  errorCode(error) === SKILLS_ERROR.commandUnavailable;

export const COMMAND_UNAVAILABLE_TEXT =
  'The runner does not handle skills yet, so nothing was sent.';

/** Every skills error as a sentence for the person. */
export function describeSkillsError(error: unknown): string {
  switch (errorCode(error)) {
    case SKILLS_ERROR.commandUnavailable:
      return COMMAND_UNAVAILABLE_TEXT;
    case SKILLS_ERROR.skillNotFound:
      return 'That skill is not in this project’s inventory. Refresh the list.';
    case SKILLS_ERROR.previewNotFound:
      return 'That preview is gone or belongs to someone else. Open the skill again.';
    case SKILLS_ERROR.previewExpired:
      return 'The preview expired (15 minutes). Open the skill again to review it.';
    case SKILLS_ERROR.previewConsumed:
      return 'That preview was already used. Open the skill again to install it again.';
    case SKILLS_ERROR.changedSincePreview:
      return 'The skill changed since you reviewed it, so nothing was written. Open it again and review the new content.';
    case SKILLS_ERROR.alreadyExists:
      return 'That skill is already installed there, or its install branch exists.';
    case SKILLS_ERROR.tooLarge:
      return 'The skill is over the runner’s file or size limit.';
    case SKILLS_ERROR.upstreamUnavailable:
      return 'skills.sh or GitHub did not answer the runner. Try again in a moment.';
    case SKILLS_ERROR.notRunnable:
      return 'This skill cannot be run from here: the orchestrator has its own controls and a worker needs a brief.';
    case SKILLS_ERROR.unsupportedRuntime:
      return 'Codex profiles cannot run skills yet. Pick a Claude profile.';
    case SKILLS_ERROR.noProfile:
      return 'Pick a runtime profile, or set a default one in the project settings.';
    case SKILLS_ERROR.unknownProfile:
      return 'That profile is not available on this project’s runner.';
    case SKILLS_ERROR.runFinished:
      return 'The run already finished.';
    case SKILLS_ERROR.runnerTimeout:
      return 'The runner did not answer in time. Check the run before trying again.';
    case SKILLS_ERROR.commandFailed:
      return `The runner could not complete the request: ${error instanceof ApiError ? error.message : 'unknown error'}`;
    default:
      break;
  }
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'It no longer exists, or you are not a member of this project.';
    }
    if (error.status === 403) return 'Your role does not allow this.';
  }
  return describeError(error);
}

export interface InstallOutcome {
  state: 'pending' | 'done' | 'failed';
  text: string;
  prUrl: string | null;
}

/**
 * What a project install (a `command_runs` row, #17) came to. The runner’s
 * own error code travels in the message (`runner_error`), so a recognised one
 * gets its sentence and anything else is shown as it came.
 */
export function installOutcome(run: {
  status: 'requested' | 'ok' | 'error' | 'unknown';
  result: Record<string, unknown> | null;
  error: { code: string; message?: string } | null;
}): InstallOutcome {
  switch (run.status) {
    case 'requested':
      return {
        state: 'pending',
        text: 'Installing — the runner is opening a pull request…',
        prUrl: null,
      };
    case 'ok': {
      const prUrl = safeHttpsUrl(
        typeof run.result?.prUrl === 'string' ? run.result.prUrl : null,
      );
      return {
        state: 'done',
        text: prUrl
          ? 'Installed: review and merge the pull request to use it.'
          : 'Installed.',
        prUrl,
      };
    }
    case 'unknown':
      return {
        state: 'failed',
        text: 'The runner never answered, so the outcome is unknown. Check the repository before installing again.',
        prUrl: null,
      };
    case 'error': {
      const message = run.error?.message ?? '';
      const known = Object.values(SKILLS_ERROR).find((code) =>
        message.includes(code),
      );
      return {
        state: 'failed',
        text: known
          ? describeSkillsError(
              new ApiError(0, known as never, message, undefined, {
                error: known,
              }),
            )
          : `The install failed. ${message}`.trim(),
        prUrl: null,
      };
    }
  }
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;
