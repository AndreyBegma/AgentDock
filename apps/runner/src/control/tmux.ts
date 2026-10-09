import type { Exec } from '../detect/exec';

/** One tmux session, as `list-sessions` reports it. */
export interface TmuxSession {
  name: string;
  /** `session_created`, as an ISO timestamp; null when tmux gave none. */
  createdAt: string | null;
}

const SEP = '|:|';

/**
 * An exact-match target. Without the `=`, tmux falls back to a prefix match,
 * so `-t cs-i4` would hit `cs-i42` when no `cs-i4` exists.
 */
const exact = (session: string) => `=${session}`;
/** The active pane of an exact-match session. */
const exactPane = (session: string) => `=${session}:`;

const createdAt = (raw: string | undefined): string | null => {
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
};

/**
 * The tmux calls the control commands make (spec 17), each with fixed argv
 * (ADR-0010) — never a shell string. `serverArgs` selects the server: empty
 * for the user's own, `['-L', name]` for a private socket in tests.
 */
export class TmuxControl {
  constructor(
    private readonly exec: Exec,
    private readonly serverArgs: readonly string[] = [],
  ) {}

  private async run(args: readonly string[]) {
    const result = await this.exec('tmux', [...this.serverArgs, ...args]);
    if (!result) throw new Error('tmux is not available on this runner');
    return result;
  }

  /** Every live session; `[]` when no server is running. */
  async sessions(): Promise<TmuxSession[]> {
    const result = await this.run([
      'list-sessions',
      '-F',
      `#{session_name}${SEP}#{session_created}`,
    ]);
    // No server, or its socket is gone: there are no sessions.
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name = '', created] = line.split(SEP);
        return { name, createdAt: createdAt(created) };
      })
      .filter((s) => s.name.length > 0);
  }

  async find(name: string): Promise<TmuxSession | null> {
    return (await this.sessions()).find((s) => s.name === name) ?? null;
  }

  /**
   * `new-session -d -s <name> -c <cwd> -e K=V … <argv…>`. tmux runs a command
   * given as several arguments directly, without `sh -c`.
   */
  async newSession(
    name: string,
    cwd: string,
    env: Readonly<Record<string, string>>,
    argv: readonly string[],
  ): Promise<{ ok: true } | { ok: false; stderr: string }> {
    const result = await this.run([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwd,
      ...Object.entries(env).flatMap(([key, value]) => [
        '-e',
        `${key}=${value}`,
      ]),
      ...argv,
    ]);
    return result.code === 0
      ? { ok: true }
      : { ok: false, stderr: result.stderr.trim() };
  }

  async killSession(name: string): Promise<void> {
    const result = await this.run(['kill-session', '-t', exact(name)]);
    if (result.code !== 0) {
      throw new Error(
        `tmux kill-session ${name} failed: ${result.stderr.trim()}`,
      );
    }
  }

  /** The visible text of the session's active pane; null when it is gone. */
  async capture(name: string): Promise<string | null> {
    const result = await this.run([
      'capture-pane',
      '-p',
      '-t',
      exactPane(name),
    ]);
    return result.code === 0 ? result.stdout : null;
  }

  /** Types `text` literally (`-l`): no key names are interpreted. */
  async sendLiteral(name: string, text: string): Promise<void> {
    await this.sendKeys(name, ['-l', text]);
  }

  async sendEnter(name: string): Promise<void> {
    await this.sendKeys(name, ['Enter']);
  }

  private async sendKeys(name: string, keys: readonly string[]) {
    const result = await this.run([
      'send-keys',
      '-t',
      exactPane(name),
      ...keys,
    ]);
    if (result.code !== 0) {
      throw new Error(`tmux send-keys ${name} failed: ${result.stderr.trim()}`);
    }
  }
}
