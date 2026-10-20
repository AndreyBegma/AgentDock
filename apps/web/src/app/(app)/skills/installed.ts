import type { InstalledSkillView } from '@nautelle/shared';

/** Searches offered before the person types (#159): one tap fills the field. */
export const SUGGESTED_SEARCHES = [
  'review',
  'testing',
  'estimate',
  'security',
  'docs',
  'refactor',
] as const;

/** One skill as the catalog lists it: shown once, however many profiles carry it. */
export interface InstalledEntry {
  invocation: string;
  name: string;
  description: string | null;
  /** In the project's own repository. */
  inProject: boolean;
  /** How many runner profiles carry it. */
  profiles: number;
}

/**
 * Installed skills folded by invocation: a plugin skill that comes from five
 * profiles is one entry "in 5 profiles", not five rows. Sorted by name.
 */
export function installedEntries(
  items: readonly InstalledSkillView[],
): InstalledEntry[] {
  const byInvocation = new Map<
    string,
    InstalledEntry & { profileKeys: Set<string> }
  >();
  for (const item of items) {
    let entry = byInvocation.get(item.invocation);
    if (!entry) {
      entry = {
        invocation: item.invocation,
        name: item.name,
        description: item.description,
        inProject: false,
        profiles: 0,
        profileKeys: new Set(),
      };
      byInvocation.set(item.invocation, entry);
    }
    entry.description ??= item.description;
    if (item.profileKey) entry.profileKeys.add(item.profileKey);
    else entry.inProject = true;
  }
  return [...byInvocation.values()]
    .map(({ profileKeys, ...entry }) => ({
      ...entry,
      profiles: profileKeys.size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "in this project", "in 5 profiles", "in this project and 1 profile". */
export function whereInstalled(entry: InstalledEntry): string {
  const profiles =
    entry.profiles === 0
      ? ''
      : `${entry.profiles} ${entry.profiles === 1 ? 'profile' : 'profiles'}`;
  if (entry.inProject && profiles) return `in this project and ${profiles}`;
  if (entry.inProject) return 'in this project';
  return `in ${profiles}`;
}
