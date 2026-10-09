import {
  type DocsSourceOverrideRequest,
  PROJECT_ERROR,
} from '@agentdock/shared';
import type {
  BaseSource,
  DocsRule,
  DocsSourceKind,
  ProjectInspection,
} from '@agentdock/shared/protocol';
import { ApiError, describeError } from '../api';

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

/** A sentence for the user; falls back to the shared wording. */
export function describeProjectError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code as string | undefined) {
      case PROJECT_ERROR.notFound:
        return 'This project no longer exists, or you are not a member of it.';
      case PROJECT_ERROR.runnerOffline:
        return 'The runner is offline. Bring it back online and try again.';
      case PROJECT_ERROR.runnerTimeout:
        return 'The runner did not answer in time. Try again.';
      case PROJECT_ERROR.runnerError:
        return 'The runner could not complete that.';
      case PROJECT_ERROR.pathNotFound:
        return 'That path does not exist on the runner, or is not a directory.';
      case PROJECT_ERROR.notARepository:
        return 'That path is not inside a git repository.';
      case PROJECT_ERROR.pathNotAllowed:
        return 'The runner does not allow that path.';
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
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The override form as a request, or the sentence that says what is wrong. */
export function docsOverrideRequest(
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
      return { ok: true, body: { kind: 'remote_repo', repo } };
  }
}
