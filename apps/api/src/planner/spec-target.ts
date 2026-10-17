import { posix } from 'node:path';
import type { SpecTargetKind } from '@agentdock/shared';
import { repoRelativeDirSchema } from '@agentdock/shared/protocol';
import type { DocsSourceKind, Prisma } from '@prisma/client';
import { specDirOf } from './planner-instructions.service';

/**
 * #379 (ADR-0036): where a project's specs go.
 *
 * - `code_repo` — `specDir` is repository-relative; the spec is committed on
 *   a branch of the code repository (a card's branch, a plan's docs PR).
 * - `docs_repo` — an external docs repository: `docsRoot` is its local clone
 *   and `specDir` is relative to it; the spec goes in through a pull request
 *   there (`docs.publish_specs`).
 * - `no_spec_dir` — nowhere: no Spec folder and no repository-relative
 *   `orchestrator.specDir`.
 * - `no_docs_clone` — the Spec folder is in a remote docs repository with no
 *   local clone path to write it in.
 */
export type SpecTarget =
  | { kind: 'code_repo'; specDir: string }
  | {
      kind: 'docs_repo';
      docsRoot: string;
      /** `owner/name` as the docs source records it; the runner reads the clone's own. */
      repo: string | null;
      specDir: string;
    }
  | { kind: 'no_spec_dir' }
  | { kind: 'no_docs_clone'; repo: string | null };

export interface SpecTargetProject {
  rootPath: string;
  codeSentinelConfig: Prisma.JsonValue;
  docsSource: {
    kind: DocsSourceKind;
    localPath: string | null;
    repo: string | null;
    specDir: string | null;
  } | null;
}

const trimSlash = (path: string): string => path.replace(/\/+$/, '');

/** `specDir` as a repository-relative directory, or null when it is not one. */
const repoRelative = (dir: string): string | null => {
  const parsed = repoRelativeDirSchema.safeParse(dir);
  return parsed.success ? parsed.data : null;
};

/**
 * The docs source's Spec folder decides, by its kind; without one, the
 * repository-relative `orchestrator.specDir` is the fallback (today's
 * behaviour). Reads stored rows only, never a disk (ADR-0001).
 */
export const resolveSpecTarget = (project: SpecTargetProject): SpecTarget => {
  const docs = project.docsSource;
  const folder = docs?.specDir ? repoRelative(docs.specDir) : null;
  if (docs && folder) {
    switch (docs.kind) {
      case 'in_repo': {
        const root = trimSlash(project.rootPath);
        const local = docs.localPath ? trimSlash(docs.localPath) : root;
        const rel = posix.relative(root, local);
        const dir = repoRelative(rel === '' ? folder : `${rel}/${folder}`);
        if (dir && !rel.startsWith('..')) {
          return { kind: 'code_repo', specDir: dir };
        }
        break;
      }
      case 'sibling_repo':
      case 'remote_repo':
        if (docs.localPath) {
          return {
            kind: 'docs_repo',
            docsRoot: trimSlash(docs.localPath),
            repo: docs.repo,
            specDir: folder,
          };
        }
        return { kind: 'no_docs_clone', repo: docs.repo };
      case 'none':
        break;
    }
  }
  const specDir = specDirOf(project.codeSentinelConfig);
  return specDir ? { kind: 'code_repo', specDir } : { kind: 'no_spec_dir' };
};

/** The readiness fact (`ReadinessFacts.specTarget`). */
export const specTargetKindOf = (target: SpecTarget): SpecTargetKind =>
  target.kind;

/**
 * The repository-relative spec directory of the code repository, or null —
 * where designs go beside their spec. With an external docs repository the
 * designs stay in the code repository's fallback directory (#379 "Out of
 * scope"), so it is null there too.
 */
export const codeSpecDirOf = (target: SpecTarget): string | null =>
  target.kind === 'code_repo' ? target.specDir : null;
