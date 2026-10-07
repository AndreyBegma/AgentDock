import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** The process environment, passed in so every module can be tested with a fake one. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface Paths {
  home: string;
  /** `$XDG_CONFIG_HOME`, default `~/.config`. */
  configHome: string;
  /** `~/.config/agentdock/runner.json` (D3). */
  configFile: string;
  /** `~/.local/state/agentdock/spool/` (D7). */
  spoolDir: string;
  /** `~/.config/systemd/user/agentdock-runner.service` (D11). */
  serviceFile: string;
}

/** An XDG variable counts only when it is an absolute path (XDG Base Directory spec). */
const xdg = (value: string | undefined, fallback: string): string =>
  value && isAbsolute(value) ? value : fallback;

export const resolvePaths = (env: Env): Paths => {
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  const configHome = xdg(env.XDG_CONFIG_HOME, join(home, '.config'));
  const stateHome = xdg(env.XDG_STATE_HOME, join(home, '.local', 'state'));
  return {
    home,
    configHome,
    configFile: join(configHome, 'agentdock', 'runner.json'),
    spoolDir: join(stateHome, 'agentdock', 'spool'),
    serviceFile: join(
      configHome,
      'systemd',
      'user',
      'agentdock-runner.service',
    ),
  };
};

/** Expands a leading `~` against `home`; any other path is returned unchanged. */
export const expandHome = (path: string, home: string): string => {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
};
