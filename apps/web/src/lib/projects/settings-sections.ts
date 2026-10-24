/**
 * The project settings page's four sections (#704, stack S-7 mockup). Each
 * section is one page of stacked blocks; each block is one of the thirteen
 * former tabs (Review, #890, is new) and keeps that tab's id as its anchor.
 */
export const SETTINGS_SECTIONS = [
  {
    id: 'project',
    label: 'Project',
    items: [
      { id: 'general', label: 'General' },
      { id: 'members', label: 'Members' },
      { id: 'docs', label: 'Docs source' },
      { id: 'rules', label: 'Coding rules' },
    ],
  },
  {
    id: 'automation',
    label: 'Automation',
    items: [
      { id: 'orchestrator', label: 'Orchestrator' },
      { id: 'board', label: 'Board' },
      { id: 'review', label: 'Review' },
      { id: 'demo-videos', label: 'Demo videos' },
      { id: 'sessions', label: 'Sessions' },
      { id: 'steward', label: 'Steward' },
    ],
  },
  {
    id: 'planning',
    label: 'Planning',
    items: [
      { id: 'planner', label: 'Planner' },
      { id: 'design', label: 'Design' },
      { id: 'ai-digest', label: 'AI digest' },
    ],
  },
  {
    id: 'cost',
    label: 'Cost',
    items: [
      { id: 'budget', label: 'Budget' },
      { id: 'token-saver', label: 'Token saver' },
    ],
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];
export type SettingsItemId =
  (typeof SETTINGS_SECTIONS)[number]['items'][number]['id'];

export const SETTINGS_SECTION_IDS: readonly SettingsSectionId[] =
  SETTINGS_SECTIONS.map(({ id }) => id);

/**
 * A former tab's id → the section that now holds it, so an old
 * `?tab=budget` link opens Cost (and the page scrolls to `#budget`).
 */
export const SETTINGS_ITEM_SECTION: Readonly<
  Record<SettingsItemId, SettingsSectionId>
> = Object.fromEntries(
  SETTINGS_SECTIONS.flatMap(({ id, items }) =>
    items.map((item) => [item.id, id]),
  ),
) as Record<SettingsItemId, SettingsSectionId>;

/** `?tab=`'s value when it names a former tab, else undefined. */
export function settingsItemOf(tab: string | null): SettingsItemId | undefined {
  return tab !== null && Object.hasOwn(SETTINGS_ITEM_SECTION, tab)
    ? (tab as SettingsItemId)
    : undefined;
}
