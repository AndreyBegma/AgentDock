import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  SKILL_INSPECT_MAX_SKILLS,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  SKILL_PROVENANCE_FILE,
  type SkillFile,
  type SkillFrontmatter,
  skillContentHashInput,
  skillFilePathSchema,
  skillNameSchema,
} from '@agentdock/shared/protocol';
import { parseFrontmatter } from './frontmatter';

export const SKILL_FILE = 'SKILL.md';
/** D2: skills are looked for this many directory levels below the root. */
export const DISCOVERY_MAX_DEPTH = 3;
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

export interface DiscoveredSkill {
  skillId: string;
  /** The skill directory, relative to the checkout (`skills/estimate`). */
  path: string;
  frontmatter: SkillFrontmatter;
  files: SkillFile[];
  contentHash: string;
}

/** A skill directory that breaks the caps; inspect leaves it out, install refuses it. */
export interface OversizedSkill {
  skillId: string;
  path: string;
  reason: string;
}

export interface Discovery {
  skills: DiscoveredSkill[];
  oversized: OversizedSkill[];
}

const entries = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    return [];
  }
};

const isRegularFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export const contentHashOf = (files: readonly SkillFile[]): string =>
  sha256(skillContentHashInput(files));

type FileWalk =
  | { ok: true; files: SkillFile[] }
  | { ok: false; reason: string };

/**
 * Every regular file of a skill directory, hashed. Symlinks and other
 * non-regular entries are never followed nor listed, so a skill cannot pull in
 * a file from outside its directory. Walking stops at the first cap breach.
 */
export const listSkillFiles = (skillDir: string): FileWalk => {
  const files: SkillFile[] = [];
  let total = 0;
  const walk = (dir: string, prefix: string): string | null => {
    for (const entry of entries(dir)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        const failed = walk(full, rel);
        if (failed) return failed;
        continue;
      }
      if (!entry.isFile()) continue;
      if (rel === SKILL_PROVENANCE_FILE) continue;
      if (!skillFilePathSchema.safeParse(rel).success) {
        return `unsupported file name: ${JSON.stringify(rel)}`;
      }
      const size = lstatSync(full).size;
      total += size;
      if (files.length + 1 > SKILL_MAX_FILES) {
        return `more than ${SKILL_MAX_FILES} files`;
      }
      if (total > SKILL_MAX_TOTAL_BYTES) {
        return `more than ${SKILL_MAX_TOTAL_BYTES} bytes`;
      }
      files.push({ path: rel, size, sha256: sha256(readFileSync(full)) });
    }
    return null;
  };
  const failed = walk(skillDir, '');
  return failed ? { ok: false, reason: failed } : { ok: true, files };
};

const skillIdOf = (
  frontmatter: SkillFrontmatter,
  dir: string,
): string | null => {
  for (const candidate of [frontmatter.name, basename(dir)]) {
    if (candidate && skillNameSchema.safeParse(candidate).success) {
      return candidate;
    }
  }
  return null;
};

/**
 * D2: the skills of a checkout, found the way the `skills` CLI finds them — a
 * directory holding `SKILL.md`, at most three levels down, agent directories
 * (`.claude/skills/…`) included. A skill directory is not searched for more
 * skills. A `SKILL.md` at the root itself is not a skill here: the protocol
 * names a skill by a non-empty directory path. The first directory (in path
 * order) wins a duplicated `skillId`.
 */
export const discoverSkills = (checkout: string): Discovery => {
  const found: Discovery = { skills: [], oversized: [] };
  const seen = new Set<string>();
  const visit = (dir: string, rel: string, depth: number) => {
    if (found.skills.length >= SKILL_INSPECT_MAX_SKILLS) return;
    if (rel && isRegularFile(join(dir, SKILL_FILE))) {
      const frontmatter = parseFrontmatter(
        readFileSync(join(dir, SKILL_FILE), 'utf8'),
      );
      const skillId = skillIdOf(frontmatter, dir);
      if (!skillId || seen.has(skillId)) return;
      if (!skillFilePathSchema.safeParse(rel).success) return;
      seen.add(skillId);
      const walk = listSkillFiles(dir);
      if (!walk.ok) {
        found.oversized.push({ skillId, path: rel, reason: walk.reason });
        return;
      }
      found.skills.push({
        skillId,
        path: rel,
        frontmatter,
        files: walk.files,
        contentHash: contentHashOf(walk.files),
      });
      return;
    }
    if (depth >= DISCOVERY_MAX_DEPTH) return;
    for (const entry of entries(dir)) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
      visit(
        join(dir, entry.name),
        rel ? `${rel}/${entry.name}` : entry.name,
        depth + 1,
      );
    }
  };
  visit(checkout, '', 0);
  return found;
};

/**
 * Copies exactly the listed files of a skill into `dest`, each checked again
 * to be a regular file; the executable bit is kept, nothing else is.
 */
export const copySkillFiles = (
  sourceDir: string,
  files: readonly SkillFile[],
  dest: string,
): void => {
  mkdirSync(dest, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const from = join(sourceDir, file.path);
    const stat = lstatSync(from);
    if (!stat.isFile()) throw new Error(`${file.path} is not a regular file`);
    const to = join(dest, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
    writeFileSync(to, readFileSync(from));
    chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644);
  }
};
