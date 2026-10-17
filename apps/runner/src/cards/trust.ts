import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigProfile } from '../config';
import { profileClaudeJson } from '../launch/profile-mcp';
import { writeJsonAtomic } from '../skills/run/record';

/**
 * #624: Claude Code asks "Is this a project you created or one you trust?"
 * the first time it starts in a folder, and the card's session waits on it
 * with nobody watching. The runner created the card's worktree, so it
 * trusts it ahead of the launch: `projects[<path>].hasTrustDialogAccepted`
 * in the profile's `.claude.json` — the key Claude Code itself writes when
 * the person answers "Yes" (checked against Claude Code 2.1.301).
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The worktree as Claude Code names it: its real path, and the path given. */
const pathsOf = (worktree: string): string[] => {
  let real = worktree;
  try {
    real = realpathSync(worktree);
  } catch {
    // Not there yet: the path as given.
  }
  return real === worktree ? [worktree] : [real, worktree];
};

/**
 * Marks `worktree` trusted in the profile's `.claude.json`, keeping every
 * other key. True when the file now says so; false when it is unreadable as
 * an object — it is then left alone, and the dialog is the stuck-dialog
 * signal's to report.
 */
export const trustWorktree = (
  profile: ConfigProfile,
  home: string,
  worktree: string,
): boolean => {
  const file = profileClaudeJson(profile, home);
  let config: Json = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObject(parsed)) return false;
      config = parsed;
    } catch {
      return false;
    }
  }
  const projects = isObject(config.projects) ? { ...config.projects } : {};
  const paths = pathsOf(worktree);
  if (
    paths.every((path) => {
      const entry = projects[path];
      return isObject(entry) && entry.hasTrustDialogAccepted === true;
    })
  ) {
    return true;
  }
  for (const path of paths) {
    const entry = projects[path];
    projects[path] = {
      ...(isObject(entry) ? entry : {}),
      hasTrustDialogAccepted: true,
    };
  }
  // A profile Claude Code has not started in yet: its first launch makes it.
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, { ...config, projects });
  return true;
};
