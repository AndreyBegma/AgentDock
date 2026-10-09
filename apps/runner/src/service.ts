/** Exit codes of `agentdock-runner`. */
export const EXIT = {
  ok: 0,
  /** A failure: crash, unreachable server, bad config. systemd restarts it. */
  failure: 1,
  /** Wrong arguments. */
  usage: 2,
  /**
   * The server closed with a terminal code (protocol mismatch, revoked token,
   * replaced): restarting can only loop, so the unit prevents it (EX_CONFIG).
   */
  terminalClose: 78,
} as const;

/** Quotes one argument for a systemd `ExecStart=` line; `%` is a specifier there. */
const quote = (arg: string): string => {
  const escaped = arg.replace(/%/g, '%%');
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped)
    ? escaped
    : `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

/** The systemd user unit for `agentdock-runner run` (D11). */
export const serviceUnit = (execStart: readonly string[]): string =>
  [
    '[Unit]',
    'Description=AgentDock runner',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart.map(quote).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
    `RestartPreventExitStatus=${EXIT.terminalClose}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
