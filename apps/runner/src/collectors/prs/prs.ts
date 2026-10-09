import { type CheckRollupEntry, rollupChecks } from '@agentdock/shared';
import type { PrChecks } from '@agentdock/shared/protocol';
import { z } from 'zod';
import type { Exec } from '../../detect/exec';
import type { FleetEmitter, FleetProject } from '../../fleet/project';
import type { SlotBook } from '../../fleet/slots';
import type { Logger } from '../../log';

/** One open pull request from `gh pr list --json` (D3). */
export interface ListedPr {
  number: number;
  headRefName: string;
  title: string;
  url: string;
  mergeable?: string;
  statusCheckRollup?: CheckRollupEntry[] | null;
}

const LIST_FIELDS = 'number,headRefName,statusCheckRollup,mergeable,title,url';
export const PR_LIST_LIMIT = 100;

/** `MERGEABLE` → true, `CONFLICTING` → false, anything else → unknown. */
export const mergeableOf = (value: string | undefined): boolean | undefined =>
  value === 'MERGEABLE' ? true : value === 'CONFLICTING' ? false : undefined;

const listedPrSchema = z.object({
  number: z.number().int().positive(),
  headRefName: z.string().min(1),
  title: z.string(),
  url: z.url(),
  mergeable: z.string().optional(),
  statusCheckRollup: z
    .array(
      z.object({
        status: z.string().nullish(),
        conclusion: z.string().nullish(),
        state: z.string().nullish(),
      }),
    )
    .nullish(),
});

/** The entries of `gh pr list --json`; an entry that does not fit is dropped. Not JSON → null. */
export const parsePrList = (stdout: string): ListedPr[] | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((entry) => {
    const parsed = listedPrSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
};

interface Tracked {
  branch: string;
  slot: string;
  checks: PrChecks;
  mergeable: boolean | undefined;
}

export interface PrWatcherOptions {
  exec: Exec;
  project: FleetProject;
  book: SlotBook;
  emit: FleetEmitter;
  log: Logger;
}

/**
 * Polls a project's open pull requests through the runner's own `gh` (D3) and
 * follows the ones on a slot's branch: `pr.opened` when one appears,
 * `pr.checks_changed` when its rolled-up checks or mergeability move,
 * `pr.closed` (merged or not) when it leaves the open list. Without a GitHub
 * remote or a working `gh` it reports once and tries again next poll.
 */
export class PrWatcher {
  private readonly tracked = new Map<number, Tracked>();
  private degraded: string | null = null;

  constructor(private readonly options: PrWatcherOptions) {}

  async poll(): Promise<void> {
    const { project, book, exec } = this.options;
    if (!project.github) return this.degrade('no GitHub remote');
    const result = await exec('gh', [
      'pr',
      'list',
      '--repo',
      project.github,
      '--state',
      'open',
      '--limit',
      String(PR_LIST_LIMIT),
      '--json',
      LIST_FIELDS,
    ]);
    if (!result) return this.degrade('gh is not available or timed out');
    if (result.code !== 0) {
      return this.degrade(`gh pr list failed: ${result.stderr.trim()}`);
    }
    const prs = parsePrList(result.stdout);
    if (!prs) return this.degrade('gh pr list returned no JSON array');
    this.recover();

    const branches = book.branches();
    const open = new Set<number>();
    for (const pr of prs) {
      const slot =
        branches.get(pr.headRefName) ?? this.tracked.get(pr.number)?.slot;
      if (!slot) continue;
      open.add(pr.number);
      this.observe(pr, slot);
    }
    for (const [number, tracked] of this.tracked) {
      if (!open.has(number)) await this.closed(number, tracked);
    }
  }

  private observe(pr: ListedPr, slot: string): void {
    const checks = rollupChecks(pr.statusCheckRollup ?? []);
    const mergeable = mergeableOf(pr.mergeable);
    const previous = this.tracked.get(pr.number);
    this.tracked.set(pr.number, {
      branch: pr.headRefName,
      slot,
      checks,
      mergeable,
    });
    const scope = { slot, issue: this.options.book.issue(slot) };
    const fields = { number: pr.number, branch: pr.headRefName, checks };
    const withMergeable = mergeable === undefined ? {} : { mergeable };
    if (!previous) {
      this.options.emit(
        'pr.opened',
        { ...fields, url: pr.url, title: pr.title, ...withMergeable },
        scope,
      );
    } else if (previous.checks !== checks || previous.mergeable !== mergeable) {
      this.options.emit(
        'pr.checks_changed',
        { ...fields, ...withMergeable },
        scope,
      );
    }
  }

  /** A PR left the open list: ask `gh` whether it merged. Unknown → keep it for the next poll. */
  private async closed(number: number, tracked: Tracked): Promise<void> {
    const { exec, project } = this.options;
    const result = await exec('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      project.github as string,
      '--json',
      'state',
    ]);
    if (!result || result.code !== 0) return;
    let state: unknown;
    try {
      state = (JSON.parse(result.stdout) as { state?: unknown }).state;
    } catch {
      return;
    }
    if (state !== 'MERGED' && state !== 'CLOSED') return;
    this.tracked.delete(number);
    this.options.emit(
      'pr.closed',
      { number, branch: tracked.branch, merged: state === 'MERGED' },
      { slot: tracked.slot, issue: this.options.book.issue(tracked.slot) },
    );
  }

  private degrade(reason: string): void {
    if (this.degraded === reason) return;
    this.degraded = reason;
    this.options.log.warn('fleet: pull requests unavailable', {
      projectId: this.options.project.id,
      reason,
    });
  }

  private recover(): void {
    if (this.degraded === null) return;
    this.degraded = null;
    this.options.log.info('fleet: pull requests available again', {
      projectId: this.options.project.id,
    });
  }
}
