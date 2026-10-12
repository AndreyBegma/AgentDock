import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SKILL_PROVENANCE_FILE,
  type SkillProvenance,
} from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import { claudeConfigDir, codexHome } from '../detect/profiles';
import { copySkillFiles, type DiscoveredSkill } from './discover';

/** D3: where a profile keeps its skills. */
export const profileSkillsDir = (
  profile: ConfigProfile,
  home: string,
): string =>
  join(
    profile.runtime === 'claude'
      ? claudeConfigDir(profile, home)
      : codexHome(profile, home),
    'skills',
  );

/** D3: where a project keeps its skills, relative to its root. */
export const projectSkillsDir = (runtime: 'claude' | 'codex'): string =>
  runtime === 'claude' ? '.claude/skills' : '.agents/skills';

export const provenanceJson = (provenance: SkillProvenance): string =>
  `${JSON.stringify(provenance, null, 2)}\n`;

/** The installed directory: the skill's files, then `.agentdock-skill.json` (D5). */
export const writeSkillDir = (
  checkoutDir: string,
  skill: DiscoveredSkill,
  provenance: SkillProvenance,
  dest: string,
): void => {
  copySkillFiles(join(checkoutDir, skill.path), skill.files, dest);
  writeFileSync(join(dest, SKILL_PROVENANCE_FILE), provenanceJson(provenance), {
    mode: 0o644,
  });
};
