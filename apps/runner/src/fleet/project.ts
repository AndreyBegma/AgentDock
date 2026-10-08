import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  FleetEventType,
  UnsequencedEvent,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { type Clock, isoNow } from '../clock';
import type { Exec } from '../detect/exec';
import { parseRemote } from '../projects/remote';

/** What the fleet collectors know about one watched project. */
export interface FleetProject {
  id: string;
  /** The main checkout, exactly as the watch list names it. */
  root: string;
  /** `owner/name` on GitHub, else null (no PR polling). */
  github: string | null;
  /** The envelope's `project.repo`: `owner/name`, else the root's basename. */
  repo: string;
  /** `<git-common-dir>/cs-orchestrator` — the round boards (D4). */
  boardDir: string;
  /** `orchestrator.sessionPrefix` from `.code-analyzer-config.json`, if set. */
  sessionPrefix: string | null;
  /** The ref ahead/behind is counted against when no brief names a base. */
  defaultBase: string | null;
}

const ok = async (
  exec: Exec,
  args: readonly string[],
): Promise<string | null> => {
  const result = await exec('git', args);
  return result && result.code === 0 ? result.stdout.trim() || null : null;
};

const configuredPrefix = (root: string): string | null => {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(root, '.code-analyzer-config.json'), 'utf8'),
    );
    const prefix = (raw as { orchestrator?: { sessionPrefix?: unknown } })
      ?.orchestrator?.sessionPrefix;
    return typeof prefix === 'string' && prefix.length > 0 ? prefix : null;
  } catch {
    return null;
  }
};

/**
 * Resolves a watched project through git (fixed argv, ADR-0010). A root that
 * is not a git checkout still resolves: its board directory simply never
 * exists and no worktree is ever listed.
 */
export const resolveFleetProject = async (
  exec: Exec,
  project: WatchedProject,
): Promise<FleetProject> => {
  const { root } = project;
  const commonDir =
    (await ok(exec, [
      '-C',
      root,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])) ?? join(root, '.git');
  const origin = await ok(exec, ['-C', root, 'remote', 'get-url', 'origin']);
  const github = origin ? parseRemote(origin).repo : null;
  const originHead = await ok(exec, [
    '-C',
    root,
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const current = await ok(exec, ['-C', root, 'branch', '--show-current']);
  return {
    id: project.id,
    root,
    github,
    repo: github ?? basename(root.replace(/\/+$/, '')),
    boardDir: join(commonDir, 'cs-orchestrator'),
    sessionPrefix: configuredPrefix(root),
    defaultBase: originHead ?? current,
  };
};

/** `i42-api` → 42: Code Sentinel names slots `i<issue>` (Phase 6). */
export const issueOfSlot = (slot: string): number | undefined => {
  const match = /^i(\d+)(?:-|$)/.exec(slot);
  const issue = match ? Number(match[1]) : 0;
  return issue > 0 ? issue : undefined;
};

export interface EventScope {
  slot?: string;
  issue?: number;
  source?: 'runner' | 'scraped';
}

/** Builds fleet events for one project: the envelope, stamped by the clock. */
export type FleetEmitter = (
  type: FleetEventType,
  data: unknown,
  scope?: EventScope,
) => void;

export const fleetEmitter =
  (
    project: FleetProject,
    clock: Clock,
    emit: (event: UnsequencedEvent) => void,
  ): FleetEmitter =>
  (type, data, scope = {}) => {
    const issue =
      scope.issue ?? (scope.slot ? issueOfSlot(scope.slot) : undefined);
    emit({
      v: 1,
      ts: isoNow(clock),
      type,
      source: scope.source ?? 'runner',
      project: { repo: project.repo, root: project.root },
      ...(scope.slot ? { slot: scope.slot } : {}),
      ...(issue ? { issue } : {}),
      data,
    });
  };
