import {
  type BoardCardDetail,
  type CardRecommendationView,
  type ClaudeModelOption,
  claudeModelLabel,
  claudeModelOptions,
  type ProjectRuntimeProfile,
} from '@agentdock/shared';

/**
 * The launch popover (#322 D1–D3, D7): which action it launches, what it
 * starts with, and what it sends. Storing an override is the API's decision
 * (D3); this only sends the person's pick.
 */

/** A card's work (Run, Run again) or its design (Generate, Revise). */
export type LaunchKind = 'work' | 'design';

/** What the popover reads off the card. */
export type LaunchCard = Pick<
  BoardCardDetail,
  'profileKey' | 'model' | 'designModel' | 'recommendation'
>;

/** The empty `<option>`: the API's own fall-through (D2), shown honestly. */
export const DEFAULT_VALUE = '';

export const NO_RECOMMENDATION_TEXT = 'No recommendation yet';

export interface LaunchForm {
  /** `''` follows the resolver (#272 D1). */
  profileKey: string;
  /** `''` follows the project's model. */
  model: string;
}

/** The recommendation for this action, `null` without one (D7). */
export const recommendationFor = (
  recommendation: CardRecommendationView,
  kind: LaunchKind,
): { model: string; reason: string } | null =>
  kind === 'work' ? recommendation.work : recommendation.design;

/** The card's own override for this action: `model`, or `designModel`. */
export const modelOverrideOf = (
  card: Pick<LaunchCard, 'model' | 'designModel'>,
  kind: LaunchKind,
): string | null => (kind === 'work' ? card.model : card.designModel);

/**
 * What the popover opens with (D2): the card's profile, and its model
 * override, else the recommendation, else nothing — the project's model.
 */
export function launchDefaults(card: LaunchCard, kind: LaunchKind): LaunchForm {
  return {
    profileKey: card.profileKey ?? DEFAULT_VALUE,
    model:
      modelOverrideOf(card, kind) ??
      recommendationFor(card.recommendation, kind)?.model ??
      DEFAULT_VALUE,
  };
}

/**
 * What "Use defaults" returns to (D2, D3): the resolver's profile and the
 * recommendation for the action, without the card's overrides.
 */
export function launchBaseline(
  card: Pick<LaunchCard, 'recommendation'>,
  kind: LaunchKind,
): LaunchForm {
  return {
    profileKey: DEFAULT_VALUE,
    model: recommendationFor(card.recommendation, kind)?.model ?? DEFAULT_VALUE,
  };
}

/** Which of the two the form has moved off the baseline. */
export function launchChanges(
  form: LaunchForm,
  card: Pick<LaunchCard, 'recommendation'>,
  kind: LaunchKind,
): ('profile' | 'model')[] {
  const baseline = launchBaseline(card, kind);
  return [
    ...(form.profileKey !== baseline.profileKey ? (['profile'] as const) : []),
    ...(form.model !== baseline.model ? (['model'] as const) : []),
  ];
}

/** The note under the group while a non-default is chosen (D3); `null` otherwise. */
export function launchSavedNote(
  changes: readonly ('profile' | 'model')[],
  label: string,
): string | null {
  return changes.length === 0
    ? null
    : `Your ${changes.join(' and ')} choice is saved on ${label} and used by its next design turns, including auto-starts.`;
}

/**
 * The model select's options (D2, D4): the catalog with the recommended one
 * suffixed, a stored value outside the catalog as its own option, and "Project
 * default" first while the form follows neither an override nor a
 * recommendation.
 */
export function launchModelOptions(
  card: LaunchCard,
  kind: LaunchKind,
): ClaudeModelOption[] {
  const recommended = recommendationFor(card.recommendation, kind)?.model;
  const options = claudeModelOptions({
    selected: modelOverrideOf(card, kind),
    recommended,
  });
  return recommended || modelOverrideOf(card, kind)
    ? options
    : [
        {
          value: DEFAULT_VALUE,
          label: 'Project default',
          inCatalog: true,
          recommended: false,
        },
        ...options,
      ];
}

/** The line under the model select: the reason, or that there is none (D7). */
export function recommendationNote(
  card: Pick<LaunchCard, 'recommendation'>,
  kind: LaunchKind,
): string {
  const recommendation = recommendationFor(card.recommendation, kind);
  return recommendation
    ? `${claudeModelLabel(recommendation.model)}: ${recommendation.reason}`
    : NO_RECOMMENDATION_TEXT;
}

/** The body of Run / Generate / Revise: only what the person has set. */
export const launchRequest = (
  form: LaunchForm,
): { profileKey?: string; model?: string } => ({
  ...(form.profileKey !== DEFAULT_VALUE ? { profileKey: form.profileKey } : {}),
  ...(form.model !== DEFAULT_VALUE ? { model: form.model } : {}),
});

/**
 * The card form's model select (D4): "Recommended — Opus 5.5" while a
 * recommendation exists, else "Project default". Choosing it clears the
 * override (`null`).
 */
export function cardFormDefaultLabel(
  recommendation: CardRecommendationView,
): string {
  return recommendation.work
    ? `Recommended — ${claudeModelLabel(recommendation.work.model)}`
    : 'Project default';
}

/** The card form's model options: the default first, then the catalog. */
export function cardFormModelOptions(
  card: Pick<LaunchCard, 'model' | 'recommendation'>,
): { value: string; label: string }[] {
  return [
    {
      value: DEFAULT_VALUE,
      label: cardFormDefaultLabel(card.recommendation),
    },
    ...claudeModelOptions({
      selected: card.model,
      recommended: card.recommendation.work?.model,
    }).map(({ value, label }) => ({ value, label })),
  ];
}

/**
 * The profile select's options. A key the runner no longer lists stays as its
 * own option, so nothing is silently changed (the model rule, D4).
 */
export function profileKeysWith(
  profiles: readonly ProjectRuntimeProfile[],
  selected: string,
): string[] {
  const keys = profiles.map((p) => p.key);
  return selected !== DEFAULT_VALUE && !keys.includes(selected)
    ? [selected, ...keys]
    : keys;
}
