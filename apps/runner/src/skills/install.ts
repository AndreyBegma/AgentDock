import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  SkillInspectArgs,
  SkillInspectResult,
  SkillInstallArgs,
  SkillInstallResult,
  SkillProvenance,
  SkillUninstallArgs,
} from '@agentdock/shared/protocol';
import { isoNow } from '../clock';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { profileOf, randomShortId, type SkillsDeps } from './deps';
import { discoverSkills } from './discover';
import { profileSkillsDir, writeSkillDir } from './layout';
import { installProjectSkill } from './project-install';
import { cloneSource, fetchCommit } from './source';

/** `skill.inspect` (D2): clone, locate, hash. Nothing is written but a temp dir. */
export const inspectSkills = async (
  args: SkillInspectArgs,
  deps: SkillsDeps,
): Promise<SkillInspectResult> => {
  const checkout = await cloneSource(deps, args.source, args.ref);
  try {
    const found = discoverSkills(checkout.dir);
    const wanted = (s: { skillId: string }) =>
      args.skillId === undefined || s.skillId === args.skillId;
    const skills = found.skills.filter(wanted);
    if (args.skillId !== undefined && skills.length === 0) {
      const oversized = found.oversized.find(wanted);
      if (oversized) {
        throw new CommandFailure(
          'too_large',
          `${args.skillId} has ${oversized.reason}`,
        );
      }
      throw new CommandFailure(
        'not_found',
        `${args.source} has no skill ${args.skillId}`,
      );
    }
    return {
      commit: checkout.commit,
      skills: skills.map((s) => ({
        skillId: s.skillId,
        path: s.path,
        frontmatter: s.frontmatter,
        files: s.files,
        contentHash: s.contentHash,
      })),
    };
  } finally {
    await checkout.dispose();
  }
};

const profileFor = (
  deps: SkillsDeps,
  profileKey: string,
  runtime: 'claude' | 'codex',
): ConfigProfile => {
  const profile = profileOf(deps, profileKey);
  if (profile.runtime !== runtime) {
    throw new CommandFailure(
      'unsupported_runtime',
      `${profile.id} is a ${profile.runtime} profile, not ${runtime}`,
    );
  }
  return profile;
};

/**
 * `skill.install` (D3–D5): fetch exactly the previewed commit, check the
 * skill's `contentHash` against the preview, then copy — never `npx`, never a
 * symlink, nothing of the skill executed. A mismatch writes nothing.
 */
export const installSkill = async (
  args: SkillInstallArgs,
  deps: SkillsDeps,
): Promise<SkillInstallResult> => {
  const { target } = args;
  // Cheap refusals before the network.
  const profile =
    target.scope === 'profile'
      ? profileFor(deps, target.profileKey, target.runtime)
      : null;
  const profileDest = profile
    ? join(profileSkillsDir(profile, deps.home), args.skillId)
    : null;
  if (profileDest && existsSync(profileDest)) {
    throw new CommandFailure('already_exists', `${profileDest} already exists`);
  }

  const checkout = await fetchCommit(deps, args.source, args.commit);
  try {
    const found = discoverSkills(checkout.dir);
    const skill = found.skills.find((s) => s.skillId === args.skillId);
    if (!skill) {
      const oversized = found.oversized.find((s) => s.skillId === args.skillId);
      if (oversized) {
        throw new CommandFailure(
          'too_large',
          `${args.skillId} has ${oversized.reason}`,
        );
      }
      throw new CommandFailure(
        'changed_since_preview',
        `${args.source}@${args.commit} has no skill ${args.skillId}`,
      );
    }
    if (skill.contentHash !== args.contentHash) {
      throw new CommandFailure(
        'changed_since_preview',
        `${args.skillId} no longer matches the preview (contentHash ${skill.contentHash})`,
      );
    }
    const provenance: SkillProvenance = {
      source: args.source,
      skillId: args.skillId,
      commit: args.commit,
      contentHash: args.contentHash,
      installedAt: isoNow(deps.clock),
    };

    if (target.scope === 'project') {
      return await installProjectSkill(
        { ...args, target },
        { checkoutDir: checkout.dir, skill, provenance },
        deps,
      );
    }
    // A profile is not versioned: written directly, through a temp sibling and
    // one rename, so a half-copied skill never shows.
    const dest = profileDest as string;
    mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
    const temp = join(
      dirname(dest),
      `.${args.skillId}.agentdock-${(deps.shortId ?? randomShortId)()}`,
    );
    try {
      writeSkillDir(checkout.dir, skill, provenance, temp);
      if (existsSync(dest)) {
        throw new CommandFailure('already_exists', `${dest} already exists`);
      }
      renameSync(temp, dest);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    return { path: dest };
  } finally {
    await checkout.dispose();
  }
};

/** `skill.uninstall` (D14): a profile skill directory, removed. */
export const uninstallSkill = (
  args: SkillUninstallArgs,
  deps: SkillsDeps,
): { removed: true } => {
  const profile = profileFor(deps, args.profileKey, args.runtime);
  const dir = join(profileSkillsDir(profile, deps.home), args.name);
  if (!existsSync(dir)) {
    throw new CommandFailure(
      'not_found',
      `${profile.id} has no skill ${args.name}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
  return { removed: true };
};
