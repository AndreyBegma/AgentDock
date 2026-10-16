import {
  FILTER_ID_NONE,
  type ProjectRuntimeProfile,
  type TokenSavedView,
  type TokenSaverRunKind,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';
import { formatCost, formatNumber, formatTokens } from '../format';

/** What a run kind is called on screen (D1: the eight launches). */
export const RUN_KIND_LABEL: Record<TokenSaverRunKind, string> = {
  card: 'Card worker',
  skill: 'Skill',
  plan: 'Planner',
  card_assess: 'Assess',
  card_capture: 'Capture',
  ui_profile: 'Design',
  text_normalize: 'Normalize',
  orchestrator: 'Orchestrator',
};

export const runKindLabel = (kind: TokenSaverRunKind): string =>
  RUN_KIND_LABEL[kind] ?? kind;

/** A filter id as a person reads it; `none` is a command no family covers. */
export const filterLabel = (filter: string): string =>
  filter === FILTER_ID_NONE ? 'No filter (uncovered command)' : filter;

/** The estimate's dollars, always with "≈" (D12): `≈ $0.41`, `≈ <$0.01`. */
export function formatSavedUsd(usd: number): string {
  const cost = formatCost(usd);
  return cost ? `≈ ${cost}` : '';
}

/** `≈ 12.3k tokens`. */
export function formatSavedTokens(tokens: number): string {
  return `≈ ${formatTokens(tokens)} tokens`;
}

/**
 * The card face's chip text (D13): `saved ≈ $0.41`. Nothing when the round
 * saved nothing — a card without filtered commands shows no chip.
 */
export function savedLabel(
  saved: TokenSavedView | null | undefined,
): string | null {
  if (!saved || saved.estimateTokens <= 0) return null;
  return `saved ${formatSavedUsd(saved.estimateUsd)}`;
}

/** A 0–1 rate as a whole percent; `0%` for nothing, `<1%` for a trace. */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0%';
  const percent = rate * 100;
  return percent < 1 ? '<1%' : `${formatNumber(percent, 0)}%`;
}

/** Share of a filter's commands that returned the original, 0–1. */
export const passThroughShare = (f: {
  commands: number;
  passedThrough: number;
}): number => (f.commands > 0 ? f.passedThrough / f.commands : 0);

/** `kept / raw` as "≈ 22% of the original", for a totals line. */
export function keptShare(rawBytes: number, keptBytes: number): number {
  return rawBytes > 0 ? keptBytes / rawBytes : 1;
}

/**
 * What the allowlist offers: every server the runner reports across the
 * project's profiles, plus names already allowed that no profile reports now
 * (kept visible, so saving never drops one silently). `agentdock` is always
 * loaded and is not a choice. Sorted, unique.
 */
export function mcpChoices(
  profiles: readonly Pick<ProjectRuntimeProfile, 'mcpServers'>[],
  allowed: readonly string[],
): { name: string; reported: boolean }[] {
  const reported = new Set(
    profiles.flatMap((profile) => profile.mcpServers ?? []),
  );
  reported.delete('agentdock');
  const names = new Set([...reported, ...allowed]);
  names.delete('agentdock');
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, reported: reported.has(name) }));
}

/** Whether any profile told us its servers (older runners and Codex do not). */
export const profilesReportServers = (
  profiles: readonly Pick<ProjectRuntimeProfile, 'mcpServers'>[],
): boolean => profiles.some((profile) => profile.mcpServers !== undefined);

/** The allowlist with `name` switched on or off, order kept by name. */
export function toggleAllow(
  allow: readonly string[],
  name: string,
  on: boolean,
): string[] {
  const rest = allow.filter((n) => n !== name);
  return (on ? [...rest, name] : rest).sort((a, b) => a.localeCompare(b));
}

/** The same set, whatever the order. */
export const sameAllow = (
  a: readonly string[],
  b: readonly string[],
): boolean => a.length === b.length && a.every((name) => b.includes(name));

export function describeTokenSaverError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return 'Only project administrators can change Token saver.';
    if (error.status === 404)
      return 'That project was not found, or you are not a member of it.';
  }
  return describeError(error);
}
