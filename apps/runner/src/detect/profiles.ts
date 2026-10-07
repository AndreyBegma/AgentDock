import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeProfile } from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import { type Env, expandHome } from '../env';

const isFile = (path: string): { size: number } | null => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { size: stat.size } : null;
  } catch {
    return null;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The directory claude reads for this profile: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeConfigDir = (profile: ConfigProfile, home: string): string =>
  expandHome(profile.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), home);

/** The directory codex reads for this profile: `CODEX_HOME`, else `~/.codex`. */
export const codexHome = (profile: ConfigProfile, home: string): string =>
  expandHome(profile.env.CODEX_HOME ?? join(home, '.codex'), home);

/**
 * Whether the profile has credentials on disk (D4): a non-empty
 * `.credentials.json` for claude, an `auth.json` for codex. Reads metadata
 * only — never the credential itself.
 */
export const isAuthenticated = (
  profile: ConfigProfile,
  home: string,
): boolean => {
  if (profile.runtime === 'claude') {
    const file = isFile(
      join(claudeConfigDir(profile, home), '.credentials.json'),
    );
    return file !== null && file.size > 0;
  }
  return isFile(join(codexHome(profile, home), 'auth.json')) !== null;
};

export const withAuthentication = (
  profiles: readonly ConfigProfile[],
  home: string,
): RuntimeProfile[] =>
  profiles.map((p) => ({ ...p, authenticated: isAuthenticated(p, home) }));

/** A directory name as a profile id: `[A-Za-z0-9][A-Za-z0-9._-]*`, or null. */
const toIdPart = (name: string): string | null => {
  const id = name
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  return id.length > 0 ? id : null;
};

/**
 * Proposes profiles for this machine (D4): the default `~/.claude`, one claude
 * profile per directory in `~/.claude-profiles/`, and one codex profile. Paths
 * are absolute. Shell functions are never invoked.
 */
export const detectProfiles = (env: Env, home: string): ConfigProfile[] => {
  const profiles: ConfigProfile[] = [
    { id: 'claude-default', runtime: 'claude', env: {}, args: [] },
  ];
  const ids = new Set(profiles.map((p) => p.id));

  const root = join(home, '.claude-profiles');
  let names: string[] = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    // No ~/.claude-profiles: only the default.
  }
  for (const name of names) {
    const dir = join(root, name);
    const part = toIdPart(name);
    if (!part || !isDirectory(dir)) continue;
    let id = `claude-${part}`;
    for (let n = 2; ids.has(id); n++) id = `claude-${part}-${n}`;
    ids.add(id);
    profiles.push({
      id,
      runtime: 'claude',
      env: { CLAUDE_CONFIG_DIR: dir },
      args: [],
    });
  }

  profiles.push({
    id: 'codex-default',
    runtime: 'codex',
    env: env.CODEX_HOME ? { CODEX_HOME: expandHome(env.CODEX_HOME, home) } : {},
    args: [],
  });
  return profiles;
};
