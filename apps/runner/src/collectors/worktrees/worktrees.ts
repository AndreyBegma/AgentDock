import { existsSync } from 'node:fs';
import type { WorktreeChangedData } from '@agentdock/shared/protocol';
import type { Exec } from '../../detect/exec';
import type { FleetEmitter, FleetProject } from '../../fleet/project';
import { slotOfWorktree, slotWorktreePath } from '../../fleet/session-name';
import type { SlotBook, WorktreeFacts } from '../../fleet/slots';

/** One entry of `git worktree list --porcelain`. */
export interface ListedWorktree {
  path: string;
  head?: string;
  /** Short name, `refs/heads/` stripped; absent for a detached HEAD. */
  branch?: string;
  prunable: boolean;
}

export const parseWorktreeList = (stdout: string): ListedWorktree[] =>
  stdout
    .split(/\n\s*\n/)
    .map((block) => {
      const entry: ListedWorktree = { path: '', prunable: false };
      for (const line of block.split('\n')) {
        const space = line.indexOf(' ');
        const key = space === -1 ? line : line.slice(0, space);
        const value = space === -1 ? '' : line.slice(space + 1);
        if (key === 'worktree') entry.path = value;
        else if (key === 'HEAD') entry.head = value;
        else if (key === 'branch') {
          entry.branch = value.replace(/^refs\/heads\//, '');
        } else if (key === 'prunable') entry.prunable = true;
      }
      return entry;
    })
    .filter((e) => e.path.length > 0);

/** watch.sh's `trailer_in_message`: the harness's attribution lines. */
const TRAILER = /^(Co-Authored-By: Claude|Claude-Session:)/im;

/** A brief whose worktree is still missing after this long is a finished slot. */
export const BRIEF_GRACE_MS = 10 * 60_000;

export interface WorktreeWatcherOptions {
  exec: Exec;
  project: FleetProject;
  book: SlotBook;
  emit: FleetEmitter;
  now: () => number;
}

/**
 * Watches a project's `.wt-<repo>-<slot>` worktrees (D1, D8): which exist,
 * their branch, ahead / behind the base, dirty; and the attribution trailer on
 * a new branch head (watch.sh `TRAILER`). Emits `worktree.changed` only when
 * what git reports changed.
 */
export class WorktreeWatcher {
  private readonly last = new Map<string, string>();
  private readonly heads = new Map<string, string>();

  constructor(private readonly options: WorktreeWatcherOptions) {}

  /** Refreshes the slot book's worktrees and emits what changed. False when git could not list them. */
  async poll(): Promise<boolean> {
    const { exec, project, book } = this.options;
    const listed = await exec('git', [
      '-C',
      project.root,
      'worktree',
      'list',
      '--porcelain',
    ]);
    if (!listed || listed.code !== 0) return false;

    const present = new Map<string, WorktreeFacts>();
    for (const entry of parseWorktreeList(listed.stdout)) {
      const slot = slotOfWorktree(project.root, entry.path);
      if (!slot || entry.prunable || !existsSync(entry.path)) continue;
      present.set(slot, { path: entry.path, branch: entry.branch });
    }
    book.worktrees = present;

    for (const [slot, facts] of present) {
      const data = await this.describe(slot, facts);
      this.report(slot, data);
      await this.checkTrailer(slot, facts.path);
    }
    for (const slot of book.names()) {
      if (present.has(slot)) continue;
      const brief = book.briefs.get(slot);
      const known = this.last.has(slot);
      const settled =
        brief !== undefined &&
        this.options.now() - brief.mtimeMs > BRIEF_GRACE_MS;
      if (!known && !settled) continue;
      this.report(slot, {
        path: slotWorktreePath(project.root, slot),
        exists: false,
      });
    }
    // A slot that left both the worktrees and the briefs was reported gone already.
    for (const slot of this.last.keys()) {
      if (present.has(slot) || book.briefs.has(slot)) continue;
      this.report(slot, {
        path: slotWorktreePath(project.root, slot),
        exists: false,
      });
    }
    return true;
  }

  private report(slot: string, data: WorktreeChangedData): void {
    const key = JSON.stringify(data);
    if (this.last.get(slot) === key) return;
    this.last.set(slot, key);
    this.options.emit('worktree.changed', data, {
      slot,
      issue: this.options.book.issue(slot),
    });
  }

  private async describe(
    slot: string,
    facts: WorktreeFacts,
  ): Promise<WorktreeChangedData> {
    const data: WorktreeChangedData = { path: facts.path, exists: true };
    if (facts.branch) data.branch = facts.branch;
    const base = await this.baseRef(slot, facts.path);
    if (base) {
      const counts = await this.git(facts.path, [
        'rev-list',
        '--left-right',
        '--count',
        `${base}...HEAD`,
      ]);
      const [behind, ahead] = (counts ?? '').split(/\s+/).map(Number);
      if (Number.isInteger(behind) && Number.isInteger(ahead)) {
        data.ahead = ahead;
        data.behind = behind;
      }
    }
    const status = await this.git(facts.path, ['status', '--porcelain']);
    if (status !== null) data.dirty = status.length > 0;
    return data;
  }

  /** `origin/<base>` of the slot's brief, else `<base>`, else the project default. */
  private async baseRef(slot: string, cwd: string): Promise<string | null> {
    const base = this.options.book.briefs.get(slot)?.base;
    const candidates = base
      ? [`origin/${base}`, base]
      : this.options.project.defaultBase
        ? [this.options.project.defaultBase]
        : [];
    for (const ref of candidates) {
      const sha = await this.git(cwd, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${ref}^{commit}`,
      ]);
      if (sha) return ref;
    }
    return null;
  }

  private async checkTrailer(slot: string, cwd: string): Promise<void> {
    const log = await this.git(cwd, ['log', '-1', '--format=%H%n%B']);
    if (!log) return;
    const [sha, ...message] = log.split('\n');
    if (!/^[0-9a-f]{7,64}$/.test(sha) || this.heads.get(slot) === sha) return;
    this.heads.set(slot, sha);
    if (TRAILER.test(message.join('\n'))) {
      this.options.emit(
        'commit.trailer_found',
        { sha },
        { slot, issue: this.options.book.issue(slot) },
      );
    }
  }

  private async git(cwd: string, args: string[]): Promise<string | null> {
    const result = await this.options.exec('git', ['-C', cwd, ...args]);
    return result && result.code === 0 ? result.stdout.trim() : null;
  }
}
