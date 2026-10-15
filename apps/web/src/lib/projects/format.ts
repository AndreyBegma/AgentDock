import {
  type DocsSourceOverrideRequest,
  type DocsSourceView,
  PROJECT_ERROR,
} from '@agentdock/shared';
import type {
  BaseSource,
  DocsRule,
  DocsSourceKind,
  ProjectInspection,
} from '@agentdock/shared/protocol';
import { ApiError, describeError } from '../api';
import { type PrerequisiteCopy, RUNNERS_PAGE } from '../prerequisites/copy';
import type { RunnersFact } from '../prerequisites/facts';
import { RUN_COMMAND } from '../runners/install';

/** The GitHub App card's single state (healthy + covered and the like collapse into one). */
export function githubAppState(status: {
  covered: boolean;
  state: 'healthy' | 'unhealthy';
}): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (!status.covered) return { label: 'Not covered', tone: 'neutral' };
  return status.state === 'healthy'
    ? { label: 'Healthy', tone: 'ok' }
    : { label: 'Needs attention', tone: 'warn' };
}

export const DOCS_KIND_LABEL: Record<DocsSourceKind, string> = {
  in_repo: 'In the repository',
  sibling_repo: 'Sibling repository',
  remote_repo: 'Remote repository',
  none: 'None',
};

export const DOCS_RULE_LABEL: Record<DocsRule, string> = {
  spec_dir: 'specDir in the config',
  sibling: 'Sibling folder',
  same_owner_remote: 'Same-owner remote',
  text_link: 'Link in AGENTS.md / CLAUDE.md / README.md',
  back_link: 'README back-link',
  in_repo: 'docs/ in the repository',
};

export const BASE_SOURCE_LABEL: Record<BaseSource, string> = {
  config: 'orchestrator.base in the config',
  origin_head: 'origin/HEAD',
  gh: 'GitHub default branch',
  default: 'fallback default',
};

/** The docs kind for a table cell; a project with no docs row reads `—`. */
export const docsKindLabel = (kind: DocsSourceKind | null): string =>
  kind === null ? '—' : DOCS_KIND_LABEL[kind];

/**
 * `path_not_allowed` carries the runner's message. The one rule the runner
 * enforces on a project root is its watch list (`project.refresh`); the API
 * re-sends that list on this refusal, so a retry succeeds.
 */
function pathNotAllowedText(message: string): string {
  if (/is not a registered root of project/.test(message)) {
    return "The runner has not registered this path as the project's root yet. AgentDock has sent it again; try again in a moment.";
  }
  return message
    ? `The runner does not allow that path: ${message}`
    : 'The runner does not allow that path.';
}

/** A sentence for the user; falls back to the shared wording. */
export function describeProjectError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code as string | undefined) {
      case PROJECT_ERROR.notFound:
        return 'This project no longer exists, or you are not a member of it.';
      case PROJECT_ERROR.runnerOffline:
        return `The runner is offline. Start "${RUN_COMMAND}" on its machine (or keep it running as a service), then try again.`;
      case PROJECT_ERROR.runnerTimeout:
        return 'The runner did not answer in time. Try again.';
      case PROJECT_ERROR.runnerError: {
        // The API prefixes the command name ("project.inspect: …").
        const detail = error.message.replace(/^[a-z]+(\.[a-z]+)+:\s*/, '');
        return detail
          ? `The runner could not complete that: ${detail}`
          : 'The runner could not complete that.';
      }
      case PROJECT_ERROR.pathNotFound:
        return 'That path does not exist on the runner, or is not a directory.';
      case PROJECT_ERROR.notARepository:
        return 'That path is not inside a git repository.';
      case PROJECT_ERROR.pathNotAllowed:
        return pathNotAllowedText(error.message);
      case PROJECT_ERROR.notMainCheckout:
        return 'That is a linked worktree or a subdirectory, not the main checkout.';
      case PROJECT_ERROR.unsupportedForge:
        return 'Only GitHub repositories can be connected: this one has no GitHub origin.';
      case PROJECT_ERROR.alreadyConnected:
        return 'That repository is already connected on this runner.';
      case PROJECT_ERROR.profileNotOnRunner:
        return "That profile does not belong to this project's runner.";
      case PROJECT_ERROR.invalidDocsSource:
        return 'Those fields do not fit that kind of docs source.';
      case PROJECT_ERROR.userNotFound:
        return 'That user does not exist.';
      case PROJECT_ERROR.userNotActive:
        return 'Only active users can be added as members.';
      case PROJECT_ERROR.alreadyMember:
        return 'That user is already a member.';
    }
  }
  return describeError(error);
}

/** A `PrerequisiteCopy` that may end in a command to run. */
export interface RunnerNoticeCopy extends PrerequisiteCopy {
  command?: string;
}

/**
 * Above the Connect form when no runner can be reached: none paired → pair
 * one; paired but offline → start it. Null while any runner is online.
 */
export function noOnlineRunnerCopy(
  fleet: RunnersFact,
): RunnerNoticeCopy | null {
  switch (fleet.kind) {
    case 'none':
      return {
        tone: 'warn',
        title: 'No runner is paired.',
        body: 'Projects live on a runner, the AgentDock daemon on the machine that holds your repositories. Pair one first.',
        href: RUNNERS_PAGE,
        cta: 'Pair a runner',
      };
    case 'offline': {
      const names = fleet.runners.map((runner) => runner.name);
      const several = names.length > 1;
      return {
        tone: 'warn',
        title: `${names.join(', ')} ${several ? 'are' : 'is'} offline.`,
        body: several
          ? 'Start one of them on its machine:'
          : 'Start it on that machine:',
        command: RUN_COMMAND,
        href: RUNNERS_PAGE,
        cta: 'Open Runners',
      };
    }
    case 'online':
    case 'unknown':
      return null;
  }
}

/** The main checkout the API suggests with a `not_main_checkout` refusal. */
export const suggestedPathOf = (error: unknown): string | undefined =>
  error instanceof ApiError &&
  (error.code as string | undefined) === PROJECT_ERROR.notMainCheckout
    ? error.suggestedPath
    : undefined;

/**
 * Why the preview cannot be connected, or null when it can. The API refuses
 * the same cases (409 / 422); this saves the round trip.
 */
export function connectBlocker(inspection: ProjectInspection): string | null {
  if (!inspection.isMainCheckout) {
    return `This is not the main checkout. Use ${inspection.root} instead.`;
  }
  if (inspection.remote.forge === 'unsupported') {
    return 'Only GitHub repositories can be connected: this one has no GitHub origin.';
  }
  return null;
}

export interface DocsOverrideForm {
  kind: DocsSourceKind;
  localPath: string;
  repo: string;
  /** #379: the Spec folder, relative to the docs root; blank clears it. */
  specDir?: string;
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * #379: why a Spec folder is refused, or null when it is a relative path
 * inside the docs root — the API checks the same (`repoRelativeDirSchema`).
 */
export function specFolderError(specDir: string): string | null {
  const dir = specDir.trim().replace(/\/+$/, '');
  if (dir === '') return null;
  if (
    dir.startsWith('/') ||
    dir.includes('\\') ||
    dir.length > 256 ||
    dir.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    return 'The spec folder must be a relative path inside the docs root, without "." or "..".';
  }
  return null;
}

/**
 * #379: what the Spec folder field starts with — the stored folder, else the
 * specs folder detection classified, else blank.
 */
export function specFolderOf(docs: DocsSourceView | null): string {
  return docs?.specDir ?? docs?.classified.specs[0] ?? '';
}

/** The override form as a request, or the sentence that says what is wrong. */
export function docsOverrideRequest(
  form: DocsOverrideForm,
  projectRoot: string,
):
  | { ok: true; body: DocsSourceOverrideRequest }
  | { ok: false; error: string } {
  const result = docsSourceRequest(form, projectRoot);
  if (!result.ok || form.specDir === undefined || form.kind === 'none') {
    return result;
  }
  const specError = specFolderError(form.specDir);
  if (specError) return { ok: false, error: specError };
  const specDir = form.specDir.trim().replace(/\/+$/, '');
  return { ok: true, body: { ...result.body, specDir: specDir || null } };
}

function docsSourceRequest(
  form: DocsOverrideForm,
  projectRoot: string,
):
  | { ok: true; body: DocsSourceOverrideRequest }
  | { ok: false; error: string } {
  const localPath = form.localPath.trim();
  const repo = form.repo.trim();
  switch (form.kind) {
    case 'none':
      return { ok: true, body: { kind: 'none' } };
    case 'in_repo':
      if (!localPath.startsWith('/')) {
        return { ok: false, error: 'Enter an absolute path.' };
      }
      if (
        localPath !== projectRoot &&
        !localPath.startsWith(`${projectRoot}/`)
      ) {
        return {
          ok: false,
          error: `The path must be inside ${projectRoot}.`,
        };
      }
      return { ok: true, body: { kind: 'in_repo', localPath } };
    case 'sibling_repo': {
      if (!localPath.startsWith('/')) {
        return { ok: false, error: 'Enter an absolute path.' };
      }
      if (repo && !REPO.test(repo)) {
        return { ok: false, error: 'The repository must be owner/name.' };
      }
      return {
        ok: true,
        body: { kind: 'sibling_repo', localPath, ...(repo ? { repo } : {}) },
      };
    }
    case 'remote_repo':
      if (!REPO.test(repo)) {
        return { ok: false, error: 'The repository must be owner/name.' };
      }
      // #379: an optional local clone, where specs are written.
      if (localPath && !localPath.startsWith('/')) {
        return { ok: false, error: 'Enter an absolute path.' };
      }
      return {
        ok: true,
        body: {
          kind: 'remote_repo',
          repo,
          ...(localPath ? { localPath } : {}),
        },
      };
  }
}
