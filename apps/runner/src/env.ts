import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** The process environment, passed in so every module can be tested with a fake one. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The directory name under the XDG base directories (ADR-0073). */
export const DIR_NAME = 'nautelle';
/** The name before ADR-0073; runner 0.16.0 stops migrating from it. */
export const LEGACY_DIR_NAME = 'agentdock';

export interface Paths {
  home: string;
  /** `$XDG_CONFIG_HOME`, default `~/.config`. */
  configHome: string;
  /** `~/.config/nautelle`. */
  configDir: string;
  /** `~/.local/state/nautelle`: the spool, the card records, the session-token secret. */
  stateDir: string;
  /** `~/.config/nautelle/runner.json` (D3). */
  configFile: string;
  /** `~/.local/state/nautelle/spool/` (D7). */
  spoolDir: string;
  /** `~/.local/state/nautelle/offsets.json`: transcript read positions (spec 12 D5). */
  offsetsFile: string;
  /** `~/.local/state/nautelle/stopped.json`: why the daemon last stopped for good (C-108). */
  stopStatusFile: string;
  /** `~/.config/systemd/user/nautelle-runner.service` (D11). */
  serviceFile: string;
  /** `~/Library/LaunchAgents/com.nautelle.runner.plist` on macOS (ADR-0017). */
  launchAgentFile: string;
  /** `~/Library/Logs/nautelle-runner.log`: the launchd agent's stdout and stderr. */
  launchAgentLog: string;
  /** ADR-0073: where the runner kept these before the rename, until 0.16.0. */
  legacy: {
    configDir: string;
    stateDir: string;
    serviceFile: string;
    launchAgentFile: string;
  };
}

/** An XDG variable counts only when it is an absolute path (XDG Base Directory spec). */
const xdg = (value: string | undefined, fallback: string): string =>
  value && isAbsolute(value) ? value : fallback;

export const resolvePaths = (env: Env): Paths => {
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  const configHome = xdg(env.XDG_CONFIG_HOME, join(home, '.config'));
  const stateHome = xdg(env.XDG_STATE_HOME, join(home, '.local', 'state'));
  const configDir = join(configHome, DIR_NAME);
  const stateDir = join(stateHome, DIR_NAME);
  return {
    home,
    configHome,
    configDir,
    stateDir,
    configFile: join(configDir, 'runner.json'),
    spoolDir: join(stateDir, 'spool'),
    offsetsFile: join(stateDir, 'offsets.json'),
    stopStatusFile: join(stateDir, 'stopped.json'),
    serviceFile: join(configHome, 'systemd', 'user', 'nautelle-runner.service'),
    launchAgentFile: join(
      home,
      'Library',
      'LaunchAgents',
      'com.nautelle.runner.plist',
    ),
    launchAgentLog: join(home, 'Library', 'Logs', 'nautelle-runner.log'),
    legacy: {
      configDir: join(configHome, LEGACY_DIR_NAME),
      stateDir: join(stateHome, LEGACY_DIR_NAME),
      serviceFile: join(
        configHome,
        'systemd',
        'user',
        'agentdock-runner.service',
      ),
      launchAgentFile: join(
        home,
        'Library',
        'LaunchAgents',
        'com.agentdock.runner.plist',
      ),
    },
  };
};

/** Expands a leading `~` against `home`; any other path is returned unchanged. */
export const expandHome = (path: string, home: string): string => {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
};
