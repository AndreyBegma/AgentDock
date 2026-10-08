import type { Exec } from '../../detect/exec';
import type { FleetEmitter, FleetProject } from '../../fleet/project';
import { parseSessionName } from '../../fleet/session-name';
import { classifyPane } from '../tmux/classify';
import { emitPaneChanges } from '../tmux/sessions';
import type { TmuxPane } from '../tmux/tmux';
import { PaneTracker } from '../tmux/tracker';

/** The tmux session AgentDock launches the orchestrator in (D6). */
export const ORCHESTRATOR_SESSION = 'agentdock-orchestrator';
/** The skill the orchestrator runs; found in a pane's command line (D6). */
export const ORCHESTRATOR_SKILL = 'code-sentinel:orchestrator';

const inside = (path: string, root: string): boolean => {
  const base = root.replace(/\/+$/, '');
  return path === base || path.startsWith(`${base}/`);
};

/** `ps -eo pid=,ppid=,args=` → pid → { ppid, args }. */
export const parseProcessTable = (stdout: string) => {
  const table = new Map<number, { ppid: number; args: string }>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) {
      table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
    }
  }
  return table;
};

/** Whether a process or any of its descendants has `needle` in its arguments. */
const treeMentions = (
  table: ReturnType<typeof parseProcessTable>,
  pid: number,
  needle: string,
): boolean => {
  const queue = [pid];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (visited.has(current)) continue;
    visited.add(current);
    if (table.get(current)?.args.includes(needle)) return true;
    for (const [child, entry] of table) {
      if (entry.ppid === current) queue.push(child);
    }
  }
  return false;
};

export interface OrchestratorWatcherOptions {
  exec: Exec;
  project: FleetProject;
  emit: FleetEmitter;
  capture: (paneId: string) => Promise<string | null>;
}

/**
 * The orchestrator's presence in a project (D6). A pane counts when it is in a
 * session that is not a slot's, its current path is the project root (or
 * inside it), and either its session is `agentdock-orchestrator` or its
 * command line runs `code-sentinel:orchestrator`. The root condition applies
 * to both: one `agentdock-orchestrator` session is one project's, not every
 * project's.
 *
 * The first poll always reports, so a project whose orchestrator is not
 * running reads `absent` rather than `unknown`.
 */
export class OrchestratorWatcher {
  private session: string | null = null;
  private tracker = new PaneTracker();
  private first = true;

  constructor(private readonly options: OrchestratorWatcherOptions) {}

  async poll(panes: readonly TmuxPane[]): Promise<void> {
    const found = await this.find(panes);
    const { emit } = this.options;
    const next = found?.session ?? null;
    if (this.first || next !== this.session) {
      if (this.session !== null) {
        emit('orchestrator.stopped', {
          session: this.session,
          reason: next ? `moved to ${next}` : 'session gone',
        });
      } else if (next === null) {
        emit('orchestrator.stopped', {
          session: ORCHESTRATOR_SESSION,
          reason: 'not running',
        });
      }
      if (next !== null) {
        emit('orchestrator.started', { session: next });
        this.tracker = new PaneTracker();
      }
      this.session = next;
      this.first = false;
    }
    if (!found) return;
    const text = await this.options.capture(found.paneId);
    if (text === null) return;
    emitPaneChanges(emit, this.tracker.next(classifyPane(text)), {
      target: 'orchestrator',
    });
  }

  private async find(panes: readonly TmuxPane[]): Promise<TmuxPane | null> {
    const { root } = this.options.project;
    const candidates = panes.filter(
      (p) => !parseSessionName(p.session) && inside(p.path, root),
    );
    const direct = candidates.find(
      (p) =>
        p.session === ORCHESTRATOR_SESSION ||
        p.startCommand.includes(ORCHESTRATOR_SKILL),
    );
    if (direct || candidates.length === 0) return direct ?? null;
    const ps = await this.options.exec('ps', [
      '-ww',
      '-eo',
      'pid=,ppid=,args=',
    ]);
    if (!ps || ps.code !== 0) return null;
    const table = parseProcessTable(ps.stdout);
    return (
      candidates.find(
        (p) => p.pid !== null && treeMentions(table, p.pid, ORCHESTRATOR_SKILL),
      ) ?? null
    );
  }
}
