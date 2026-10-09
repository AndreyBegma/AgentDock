/** What the board collector learnt from a slot's newest brief. */
export interface BriefFacts {
  /** `YYYY-MM-DD/HHMM`. */
  round: string;
  path: string;
  /** When the brief file was last written (ms). */
  mtimeMs: number;
  issue?: number;
  branch?: string;
  base?: string;
}

/** What the worktree collector learnt from `git worktree list`. */
export interface WorktreeFacts {
  path: string;
  branch?: string;
}

/**
 * The slots one project's collectors know about, shared between them: the
 * board fills briefs, the worktree scan fills worktrees, and the session, pane,
 * reply and PR collectors read both.
 */
export class SlotBook {
  readonly briefs = new Map<string, BriefFacts>();
  worktrees = new Map<string, WorktreeFacts>();

  /** Every slot name known from a brief or a worktree. */
  names(): string[] {
    return [...new Set([...this.briefs.keys(), ...this.worktrees.keys()])];
  }

  issue(slot: string): number | undefined {
    return this.briefs.get(slot)?.issue;
  }

  /** The branch of a slot: what its worktree has checked out, else its brief's. */
  branch(slot: string): string | undefined {
    return this.worktrees.get(slot)?.branch ?? this.briefs.get(slot)?.branch;
  }

  /** Branch → slot, for matching pull requests. */
  branches(): Map<string, string> {
    const map = new Map<string, string>();
    for (const slot of this.names()) {
      const branch = this.branch(slot);
      if (branch) map.set(branch, slot);
    }
    return map;
  }
}
