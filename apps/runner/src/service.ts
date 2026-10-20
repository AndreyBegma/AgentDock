/** The systemd user unit's name, and the binary's (ADR-0073). */
export const SERVICE_NAME = 'nautelle-runner';
/** The unit before ADR-0073, which `install-service` replaces. */
export const LEGACY_SERVICE_NAME = 'agentdock-runner';

/** Exit codes of `nautelle-runner`. */
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

/**
 * One `Environment=` line with the whole assignment quoted: `\`, `"` and `%`
 * (a specifier) are escaped, so a PATH with spaces or odd characters survives.
 */
const environment = (name: string, value: string): string =>
  `Environment="${`${name}=${value}`
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\n/g, '\\n')}"`;

/**
 * The systemd user unit for `nautelle-runner run` (D11). `path` is the PATH
 * the service runs with: a systemd user manager starts it with a minimal one,
 * so runtimes in `~/.local/bin` would not be found (ADR-0017 §6).
 */
export const serviceUnit = (
  execStart: readonly string[],
  path?: string,
): string =>
  [
    '[Unit]',
    'Description=Nautelle runner',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    ...(path ? [environment('PATH', path)] : []),
    `ExecStart=${execStart.map(quote).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
    `RestartPreventExitStatus=${EXIT.terminalClose}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');

/** The launchd label, and the plist's base name (ADR-0017). */
export const LAUNCH_AGENT_LABEL = 'com.nautelle.runner';

/**
 * Runs its arguments and turns a terminal close (78) into a clean exit.
 * launchd has no `RestartPreventExitStatus`: `KeepAlive.SuccessfulExit=false`
 * restarts every non-zero exit, 78 included, so 78 has to become 0 to stop
 * the loop (ADR-0017). The Homebrew formula's service runs the same script.
 */
export const TERMINAL_CLOSE_AS_SUCCESS = `"$@"; c=$?; [ "$c" -eq ${EXIT.terminalClose} ] && exit 0; exit "$c"`;

const xml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The launchd user agent for `nautelle-runner run`. `path` is the PATH the
 * agent runs with: launchd's default holds only the system directories, so
 * runtimes installed under Homebrew or `~/.local/bin` would not be found.
 */
export const launchAgentPlist = (
  execStart: readonly string[],
  logFile: string,
  path?: string,
): string => {
  const args = [
    '/bin/sh',
    '-c',
    TERMINAL_CLOSE_AS_SUCCESS,
    SERVICE_NAME,
    ...execStart,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    ...(path
      ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          '    <key>PATH</key>',
          `    <string>${xml(path)}</string>`,
          '  </dict>',
        ]
      : []),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
};
