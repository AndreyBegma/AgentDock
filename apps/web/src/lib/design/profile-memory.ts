import {
  cardLabel,
  stackLabel,
  UI_PROFILE_SCREEN_SUMMARY_MAX,
  UI_PROFILE_STYLE_RULE_MAX,
  type UiProfileDesignRef,
  type UiProfileScreen,
  type UiProfileSource,
  type UiProfileStyleRule,
  type UiProfileUpdateRequest,
  type UiProfileVersionView,
} from '@nautelle/shared';
import { cardDesignHref, designHref, stackDesignHref } from './href';

/**
 * The profile's memory in Settings → Design (#752 A5): the approved-screen
 * library and the style rules, each with the design it came from. An admin's
 * edit or delete is a `manual` version of the whole profile, as the editor's.
 */

/** How a version's source reads in the version list and on its badge. */
export const PROFILE_SOURCE_LABEL: Record<UiProfileSource, string> = {
  agent: 'Built',
  manual: 'Manual edit',
  memory: 'Learned from a design',
};

/** The design a library entry or a rule came from, as a link's text. */
export const designRefLabel = (ref: UiProfileDesignRef): string => {
  switch (ref.kind) {
    case 'card':
      return `${cardLabel(ref.number)} ${ref.title}`;
    case 'stack':
      return `${stackLabel(ref.number)} ${ref.title}`;
    case 'task':
      return `${ref.title} · ${ref.taskKey}`;
  }
};

export const designRefHref = (
  projectId: string,
  ref: UiProfileDesignRef,
): string => {
  switch (ref.kind) {
    case 'card':
      return cardDesignHref(projectId, ref.number);
    case 'stack':
      return stackDesignHref(projectId, ref.number);
    case 'task':
      return designHref(projectId, ref.planId, ref.taskKey);
  }
};

/** A `PUT` body that changes only the memory: the rest of the version as it is. */
export const memoryUpdateBody = (
  profile: UiProfileVersionView,
  change: { screens?: UiProfileScreen[]; styleRules?: UiProfileStyleRule[] },
): UiProfileUpdateRequest => ({
  hasUi: profile.hasUi,
  summary: profile.summary,
  kit: profile.kit,
  snippets: profile.snippets,
  screens: change.screens ?? profile.screens,
  styleRules: change.styleRules ?? profile.styleRules,
});

/** Why an edited summary or rule cannot be saved; null when it can. */
export const memoryTextError = (
  kind: 'screen' | 'rule',
  text: string,
): string | null => {
  const max =
    kind === 'screen'
      ? UI_PROFILE_SCREEN_SUMMARY_MAX
      : UI_PROFILE_STYLE_RULE_MAX;
  if (!text.trim()) {
    return kind === 'screen'
      ? 'Describe the screen, or delete it.'
      : 'Write the rule, or delete it.';
  }
  return text.trim().length > max
    ? `At most ${max.toLocaleString('en')} characters.`
    : null;
};
