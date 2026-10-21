import {
  type BoardCardDetail,
  CARD_EFFORTS,
  type CardEffort,
  type CardRecommendationView,
  type ClaudeModelOption,
  claudeModelLabel,
  claudeModelOptions,
  type ProjectRuntimeProfile,
  RECOMMENDED_SUFFIX,
} from '@nautelle/shared';

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
> &
  Partial<Pick<BoardCardDetail, 'effort'>> &
  CardSessionPair;

/**
 * #750 D7: the model and effort the card's current session started with;
 * absent or `null` for a card with no session or one from before #750.
 */
export interface CardSessionPair {
  sessionModel?: string | null;
  sessionEffort?: CardEffort | null;
}

/** #750 D7: the popover's line when the pick will not resume the session. */
export const FRESH_SESSION_TEXT =
  'Starts a fresh session (the model or effort changed)';

/**
 * #750 D7: the chosen model or effort differs from the pair the card's
 * session started with, so the round starts a fresh session. A default
 * pick is the API's to resolve and a null pair resumes, so neither counts.
 */
export function startsFreshSession(
  card: CardSessionPair,
  form: LaunchForm,
): boolean {
  const model =
    form.model !== DEFAULT_VALUE &&
    card.sessionModel != null &&
    form.model !== card.sessionModel;
  const effort =
    isCardEffort(form.effort) &&
    card.sessionEffort != null &&
    form.effort !== card.sessionEffort;
  return model || effort;
}

/** The empty `<option>`: the API's own fall-through (D2), shown honestly. */
export const DEFAULT_VALUE = '';

export const NO_RECOMMENDATION_TEXT = 'No recommendation yet';

export interface LaunchForm {
  /** `''` follows the resolver (#272 D1). */
  profileKey: string;
  /** `''` follows the project's model. */
  model: string;
  /**
   * #663: the work's effort; `''` follows the API's default. Absent on a
   * design launch, which has no effort.
   */
  effort?: string;
}

/** #663: the work's effort the card runs at, else the recommended one. */
const workEffort = (card: LaunchCard): string =>
  card.effort ?? card.recommendation.work?.effort ?? DEFAULT_VALUE;

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
    ...(kind === 'work' ? { effort: workEffort(card) } : {}),
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
 * #750 D1, D2: the assessed class, `deciding: schema, auth` or `mechanical`;
 * `null` for a card assessed before #750.
 */
export function workClassText(
  work: CardRecommendationView['work'],
): string | null {
  if (!work?.class) return null;
  const signals = (work.signals ?? []).map((s) => s.replaceAll('_', ' '));
  return signals.length > 0
    ? `${work.class}: ${signals.join(', ')}`
    : work.class;
}

/**
 * The model select's options (D2, D4): the catalog with the recommended one
 * suffixed (#750: with the work's class), a stored value outside the catalog
 * as its own option, and "Project default" first while the form follows
 * neither an override nor a recommendation.
 */
export function launchModelOptions(
  card: LaunchCard,
  kind: LaunchKind,
): ClaudeModelOption[] {
  const recommended = recommendationFor(card.recommendation, kind)?.model;
  const workClass =
    kind === 'work' ? workClassText(card.recommendation.work) : null;
  const options = claudeModelOptions({
    selected: modelOverrideOf(card, kind),
    recommended,
  }).map((option) =>
    option.recommended && workClass
      ? { ...option, label: `${option.label} · ${workClass}` }
      : option,
  );
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

/** #663: an effort's label, `Low`. */
export const effortLabel = (effort: CardEffort): string =>
  `${effort[0].toUpperCase()}${effort.slice(1)}`;

/**
 * #663: the effort select's options, by the model rule (D2, D4): the
 * recommended one suffixed, and "Claude default" first while the form follows
 * neither an override nor a recommendation.
 */
export function launchEffortOptions(
  card: LaunchCard,
): { value: string; label: string; recommended: boolean }[] {
  const recommended = card.recommendation.work?.effort ?? null;
  const options = CARD_EFFORTS.map((effort) => ({
    value: effort,
    label: `${effortLabel(effort)}${effort === recommended ? RECOMMENDED_SUFFIX : ''}`,
    recommended: effort === recommended,
  }));
  return recommended || card.effort
    ? options
    : [
        { value: DEFAULT_VALUE, label: 'Claude default', recommended: false },
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
): { profileKey?: string; model?: string; effort?: CardEffort } => ({
  ...(form.profileKey !== DEFAULT_VALUE ? { profileKey: form.profileKey } : {}),
  ...(form.model !== DEFAULT_VALUE ? { model: form.model } : {}),
  ...(isCardEffort(form.effort) ? { effort: form.effort } : {}),
});

const isCardEffort = (value: string | undefined): value is CardEffort =>
  (CARD_EFFORTS as readonly string[]).includes(value ?? '');

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
