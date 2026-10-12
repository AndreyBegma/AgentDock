import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  INSTALLED_SKILLS_MAX,
  type InstalledSkill,
  installedSkillSchema,
  SKILL_PROVENANCE_FILE,
  type SkillFrontmatter,
  type SkillListArgs,
  type SkillListResult,
  type SkillProvenance,
  skillNameSchema,
  skillProvenanceSchema,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import type { ConfigProfile } from '../config';
import { watchedProject } from '../control/target';
import type { Exec } from '../detect/exec';
import { claudeConfigDir } from '../detect/profiles';
import { resolveFleetProject } from '../fleet/project';
import { GIT_TIMEOUT_MS, type SkillsDeps } from './deps';
import { SKILL_FILE } from './discover';
import { parseFrontmatter } from './frontmatter';
import { profileSkillsDir } from './layout';

/** A `SKILL.md` larger than this is not read for its frontmatter. */
const MAX_SKILL_MD_BYTES = 256 * 1024;

const PROJECT_SKILL =
  /^(\.claude|\.agents)\/skills\/([^/]+)\/(SKILL\.md|\.agentdock-skill\.json)$/;

const provenanceOf = (raw: string | null): Partial<SkillProvenance> => {
  if (raw === null) return {};
  try {
    const parsed = skillProvenanceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    const { source, commit, contentHash } = parsed.data;
    return { source, commit, contentHash };
  } catch {
    return {};
  }
};

const describe = (frontmatter: SkillFrontmatter) => ({
  ...(frontmatter.description
    ? { description: frontmatter.description.trim().slice(0, 2000) }
    : {}),
  ...(frontmatter['argument-hint']
    ? { argumentHint: frontmatter['argument-hint'] }
    : {}),
});

const readSmall = (path: string): string | null => {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_SKILL_MD_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const dirNames = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** Skills of a directory holding `<name>/SKILL.md` entries (a profile, a plugin). */
const scanSkillsDir = (
  dir: string,
): {
  name: string;
  path: string;
  frontmatter: SkillFrontmatter;
  provenance: Partial<SkillProvenance>;
}[] => {
  const found = [];
  for (const name of dirNames(dir)) {
    if (!skillNameSchema.safeParse(name).success) continue;
    const text = readSmall(join(dir, name, SKILL_FILE));
    if (text === null) continue;
    found.push({
      name,
      path: join(dir, name),
      frontmatter: parseFrontmatter(text),
      provenance: provenanceOf(
        readSmall(join(dir, name, SKILL_PROVENANCE_FILE)),
      ),
    });
  }
  return found;
};

const gitShow = async (exec: Exec, root: string, spec: string) => {
  const result = await exec('git', ['-C', root, 'show', spec], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result && result.code === 0
    ? result.stdout.slice(0, MAX_SKILL_MD_BYTES)
    : null;
};

/**
 * D6: the project's skills as the base branch has them — read from git on
 * `origin/HEAD` (else the current branch), never from the working tree.
 */
export const projectSkills = async (
  exec: Exec,
  project: WatchedProject,
): Promise<InstalledSkill[]> => {
  const fleet = await resolveFleetProject(exec, project);
  const ref = fleet.defaultBase;
  if (!ref) return [];
  const listed = await exec(
    'git',
    [
      '-C',
      project.root,
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      '--',
      '.claude/skills',
      '.agents/skills',
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (!listed || listed.code !== 0) return [];
  const skillDirs: { agentDir: string; name: string; dir: string }[] = [];
  const withProvenance = new Set<string>();
  for (const path of listed.stdout.split('\n')) {
    const match = PROJECT_SKILL.exec(path);
    if (!match) continue;
    const [, agentDir = '', name = '', file] = match;
    const dir = `${agentDir}/skills/${name}`;
    if (file === SKILL_FILE) skillDirs.push({ agentDir, name, dir });
    else withProvenance.add(dir);
  }
  const items: InstalledSkill[] = [];
  for (const { agentDir, name, dir } of skillDirs) {
    const runtime = agentDir === '.claude' ? 'claude' : 'codex';
    const text = await gitShow(
      exec,
      project.root,
      `${ref}:${dir}/${SKILL_FILE}`,
    );
    if (text === null) continue;
    const meta = withProvenance.has(dir)
      ? provenanceOf(
          await gitShow(
            exec,
            project.root,
            `${ref}:${dir}/${SKILL_PROVENANCE_FILE}`,
          ),
        )
      : {};
    items.push({
      scope: 'project',
      runtime,
      name,
      invocation: name,
      path: dir,
      projectId: project.id,
      ...describe(parseFrontmatter(text)),
      ...meta,
    });
  }
  return items;
};

/** D6: a profile's own `skills/*`. */
export const profileSkills = (
  profile: ConfigProfile,
  home: string,
): InstalledSkill[] =>
  scanSkillsDir(profileSkillsDir(profile, home)).map((s) => ({
    scope: 'profile',
    runtime: profile.runtime,
    name: s.name,
    invocation: s.name,
    path: s.path,
    profileKey: profile.id,
    ...describe(s.frontmatter),
    ...s.provenance,
  }));

const installedPluginsSchema = z.object({
  plugins: z.record(
    z.string(),
    z.array(
      z.object({
        version: z.string().min(1),
        installPath: z.string().min(1),
        scope: z.string().optional(),
      }),
    ),
  ),
});

/**
 * D6: the skills of a claude profile's installed plugins, as
 * `<plugin>:<name>`. Read from `plugins/installed_plugins.json`, which names
 * the active install of each plugin inside `plugins/cache/` — older cached
 * versions are not offered.
 */
export const pluginSkills = (
  profile: ConfigProfile,
  home: string,
): InstalledSkill[] => {
  if (profile.runtime !== 'claude') return [];
  const configDir = claudeConfigDir(profile, home);
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(
        join(configDir, 'plugins', 'installed_plugins.json'),
        'utf8',
      ),
    );
  } catch {
    return [];
  }
  const parsed = installedPluginsSchema.safeParse(raw);
  if (!parsed.success) return [];
  const items: InstalledSkill[] = [];
  for (const [key, installs] of Object.entries(parsed.data.plugins).sort()) {
    const plugin = key.split('@')[0] ?? '';
    if (!skillNameSchema.safeParse(plugin).success) continue;
    const install = installs.find((i) => i.scope === 'user') ?? installs[0];
    if (!install || !isAbsolute(install.installPath)) continue;
    for (const s of scanSkillsDir(join(install.installPath, 'skills'))) {
      items.push({
        scope: 'plugin',
        runtime: 'claude',
        name: s.name,
        invocation: `${plugin}:${s.name}`,
        path: s.path,
        profileKey: profile.id,
        plugin,
        pluginVersion: install.version.slice(0, 100),
        ...describe(s.frontmatter),
      });
    }
  }
  return items;
};

const valid = (items: InstalledSkill[]): InstalledSkill[] =>
  items
    .filter((item) => installedSkillSchema.safeParse(item).success)
    .slice(0, INSTALLED_SKILLS_MAX);

/** `skill.list` (D6): project, profile and plugin skills. */
export const listSkills = async (
  args: SkillListArgs,
  deps: Pick<SkillsDeps, 'exec' | 'home' | 'profiles' | 'watchedProjects'>,
): Promise<SkillListResult> => {
  const items: InstalledSkill[] = [];
  if (args.projectId !== undefined && args.root !== undefined) {
    const project = watchedProject(
      { projectId: args.projectId, root: args.root },
      deps.watchedProjects(),
    );
    items.push(...(await projectSkills(deps.exec, project)));
  }
  for (const profile of deps.profiles()) {
    items.push(...profileSkills(profile, deps.home));
    items.push(...pluginSkills(profile, deps.home));
  }
  return { items: valid(items) };
};

/**
 * Whether a run of `invocation` on this project and claude profile would find
 * the skill (D8): the project's own skills on its base, the profile's, or the
 * profile's plugins'.
 */
export const findRunnableSkill = async (
  invocation: string,
  project: WatchedProject,
  profile: ConfigProfile,
  deps: Pick<SkillsDeps, 'exec' | 'home'>,
): Promise<InstalledSkill | null> => {
  const candidates = invocation.includes(':')
    ? pluginSkills(profile, deps.home)
    : [
        ...profileSkills(profile, deps.home),
        ...(await projectSkills(deps.exec, project)).filter(
          (s) => s.runtime === profile.runtime,
        ),
      ];
  return candidates.find((s) => s.invocation === invocation) ?? null;
};
