import type { Exec } from '../../detect/exec';

/** One tmux pane, as `list-panes -a` reports it. */
export interface TmuxPane {
  session: string;
  paneId: string;
  active: boolean;
  /** `pane_current_path`. */
  path: string;
  pid: number | null;
  /** `pane_start_command`; empty for a pane started on the default shell. */
  startCommand: string;
}

const FIELDS = [
  '#{session_name}',
  '#{pane_id}',
  '#{pane_active}',
  '#{pane_pid}',
  '#{pane_current_path}',
  '#{pane_start_command}',
];
/**
 * Field separator of the `list-panes` format. Printable on purpose: without a
 * UTF-8 locale (a systemd service has none) tmux prints a tab as `_`. tmux
 * refuses `:` in session names, and the free-form fields — path and start
 * command — come last, where a stray separator only splits the command.
 */
export const PANE_FIELD_SEP = '|:|';
const SEP = PANE_FIELD_SEP;

/**
 * Talks to one tmux server with fixed argv (ADR-0010). `serverArgs` selects
 * the server — empty for the user's default one, `['-L', name]` for a private
 * socket (tests).
 */
export class Tmux {
  constructor(
    private readonly exec: Exec,
    private readonly serverArgs: readonly string[] = [],
  ) {}

  /**
   * Every pane of every session. `null` when tmux cannot be asked (not
   * installed, timed out); `[]` when no server is running.
   */
  async panes(): Promise<TmuxPane[] | null> {
    const result = await this.exec('tmux', [
      ...this.serverArgs,
      'list-panes',
      '-a',
      '-F',
      FIELDS.join(SEP),
    ]);
    if (!result) return null;
    // No server, or its socket is gone: there are no sessions.
    if (result.code !== 0) return [];
    return parsePanes(result.stdout);
  }

  /** The visible text of a pane; null when it cannot be captured. */
  async capture(paneId: string): Promise<string | null> {
    const result = await this.exec('tmux', [
      ...this.serverArgs,
      'capture-pane',
      '-p',
      '-t',
      paneId,
    ]);
    return result && result.code === 0 ? result.stdout : null;
  }
}

export const parsePanes = (stdout: string): TmuxPane[] =>
  stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [session, paneId, active, pid, path, ...command] = line.split(SEP);
      if (!session || !paneId?.startsWith('%') || path === undefined) return [];
      const n = Number(pid);
      return [
        {
          session,
          paneId,
          active: active === '1',
          path,
          pid: Number.isInteger(n) && n > 0 ? n : null,
          startCommand: command.join(SEP),
        },
      ];
    });

/** The pane to read for a session: its active one, else its first. */
export const sessionPanes = (panes: readonly TmuxPane[]) => {
  const bySession = new Map<string, TmuxPane>();
  for (const pane of panes) {
    const seen = bySession.get(pane.session);
    if (!seen || (pane.active && !seen.active)) {
      bySession.set(pane.session, pane);
    }
  }
  return bySession;
};
