import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type CardPrefix,
  OVERLAY_PART_CLAUDE_MD,
  skillOfPart,
} from '@nautelle/shared';
import type { PrefixOverlayStaleData } from '@nautelle/shared/protocol';
import { SKILL_FILE } from '../skills/discover';
import { type MeasureInput, sha256Hex } from './measure';

/**
 * #751 B5, B7, B10, B11: a card launch's `tokenSaver.prefix`, applied
 * without touching the worktree. Checked against Claude Code 2.1.306:
 *
 * - `claudeMdExcludes` is honoured from `--settings`, so the original
 *   `CLAUDE.md` is excluded by its absolute path and the overlay is loaded
 *   with `--append-system-prompt-file`;
 * - `skillOverrides: { <name>: "off" }` hides a project skill, and a plugin
 *   generated in the run dir and passed with `--plugin-dir` lists the
 *   overlay as `nautelle-overlay:<name>`, which "off" on `<name>` leaves.
 *
 * An overlay is used only while its original hashes to `originalSha256`;
 * else the launch keeps the original and the overlay is reported stale.
 */

/** The generated plugin's name, and so the overlay skills' namespace. */
export const OVERLAY_PLUGIN = 'nautelle-overlay';
export const OVERLAY_PLUGIN_DIR = 'overlay-plugin';
export const OVERLAY_CLAUDE_MD_FILE = 'prefix-claude-md.md';

/** B8: the file a `claude_md` part is: the root `CLAUDE.md`, else `.claude/CLAUDE.md`. */
export const CLAUDE_MD_PATHS = ['CLAUDE.md', '.claude/CLAUDE.md'] as const;

/** The repo-relative file of a file part, as it is on disk; null when missing. */
export const overlayOriginalPath = (
  root: string,
  part: string,
): string | null => {
  if (part === OVERLAY_PART_CLAUDE_MD) {
    return CLAUDE_MD_PATHS.find((p) => existsSync(join(root, p))) ?? null;
  }
  const skill = skillOfPart(part);
  if (skill === null) return null;
  const path = `.claude/skills/${skill}/${SKILL_FILE}`;
  return existsSync(join(root, path)) ? path : null;
};

/** The header the overlay text is loaded under, as Claude Code heads a memory file. */
const claudeMdHeader = (path: string): string =>
  `Contents of ${path} (project instructions, checked into the codebase):\n\n`;

export interface AppliedPrefix {
  /** Merged into the launch's `--settings`. */
  settings: {
    claudeMdExcludes?: string[];
    skillOverrides?: Record<string, 'off'>;
  };
  /** After the Token saver args. */
  args: string[];
  /** B5: the MCP servers the session may load, narrowing the setting's. */
  mcpAllow?: string[];
  /** B5: hidden skills, overlaid ones included. */
  skillsOff: string[];
  /** For the measurement: what the overlays load instead. */
  loaded: NonNullable<MeasureInput['overlays']>;
  /** B10: overlays not used because their original changed. */
  stale: Omit<PrefixOverlayStaleData, 'runId'>[];
}

const EMPTY_SHA = sha256Hex('');

const readOriginal = (abs: string): string => {
  try {
    return sha256Hex(readFileSync(abs));
  } catch {
    return EMPTY_SHA;
  }
};

/** Links the original skill's other files beside the overlay, so its relative references hold. */
const linkSiblings = (from: string, to: string): void => {
  let names: string[] = [];
  try {
    names = readdirSync(from);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === SKILL_FILE) continue;
    symlinkSync(join(from, name), join(to, name));
  }
};

/**
 * Applies `prefix` for a launch in `cwd`, writing the overlay files into
 * `dir` (the launch's run dir). Throws when a file cannot be written; the
 * caller then launches without Token saver, as for its own files.
 */
export const applyCardPrefix = (
  prefix: CardPrefix,
  cwd: string,
  dir: string,
): AppliedPrefix => {
  const skillsOff = [...prefix.skillsOff];
  const excludes: string[] = [];
  const args: string[] = [];
  const loaded: AppliedPrefix['loaded'] = {};
  const stale: AppliedPrefix['stale'] = [];
  const done = new Set<string>();
  let pluginDir: string | null = null;

  for (const overlay of prefix.overlays) {
    if (done.has(overlay.part)) continue;
    done.add(overlay.part);
    const path = overlayOriginalPath(cwd, overlay.part);
    const sha256 = path === null ? EMPTY_SHA : readOriginal(join(cwd, path));
    if (path === null || sha256 !== overlay.originalSha256) {
      stale.push({ overlayId: overlay.id, sha256 });
      continue;
    }
    const original = join(cwd, path);
    const skill = skillOfPart(overlay.part);
    if (skill === null) {
      const file = join(dir, OVERLAY_CLAUDE_MD_FILE);
      writeFileSync(file, claudeMdHeader(path) + overlay.content, {
        mode: 0o600,
      });
      excludes.push(original);
      args.push('--append-system-prompt-file', file);
      loaded.claudeMd = {
        path: original,
        text: overlay.content,
        originalSha256: sha256,
      };
      continue;
    }
    if (pluginDir === null) {
      pluginDir = join(dir, OVERLAY_PLUGIN_DIR);
      mkdirSync(join(pluginDir, '.claude-plugin'), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(
        join(pluginDir, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify({
          name: OVERLAY_PLUGIN,
          version: '0.0.0',
          description: "Nautelle's approved overlays of this project's skills",
        })}\n`,
        { mode: 0o600 },
      );
      args.push('--plugin-dir', pluginDir);
    }
    const skillDir = join(pluginDir, 'skills', skill);
    mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(skillDir, SKILL_FILE), overlay.content, { mode: 0o600 });
    linkSiblings(join(cwd, '.claude', 'skills', skill), skillDir);
    if (!skillsOff.includes(skill)) skillsOff.push(skill);
    loaded.skills = {
      ...loaded.skills,
      [skill]: { text: overlay.content, originalSha256: sha256 },
    };
  }

  return {
    settings: {
      ...(excludes.length > 0 ? { claudeMdExcludes: excludes } : {}),
      ...(skillsOff.length > 0
        ? {
            skillOverrides: Object.fromEntries(
              skillsOff.map((name) => [name, 'off' as const]),
            ),
          }
        : {}),
    },
    args,
    ...(prefix.mcpAllow !== undefined ? { mcpAllow: prefix.mcpAllow } : {}),
    skillsOff,
    loaded,
    stale,
  };
};
