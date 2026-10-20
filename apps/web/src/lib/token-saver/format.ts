import {
  FILTER_ID_NONE,
  FILTER_ID_NONE_COMPOUND,
  FILTER_ID_NONE_MODE,
  FILTER_ID_NONE_OFF,
  FILTER_ID_NONE_UNCOVERED,
  FILTER_ID_READ_REFUSED,
  isRunnerMcpServer,
  type ProjectRuntimeProfile,
  type TokenSavedView,
  type TokenSaverRunKind,
  type TokenSaverSessionKind,
  type TokenSaverUnmeasuredKind,
} from '@nautelle/shared';
import { ApiError, describeError } from '../api';
import { formatCost, formatNumber, formatTokens } from '../format';

/** What a run kind is called on screen (D1: the eight launches; #475: manual). */
export const RUN_KIND_LABEL: Record<TokenSaverRunKind, string> = {
  card: 'Card worker',
  skill: 'Skill',
  plan: 'Planner',
  card_assess: 'Assess',
  card_capture: 'Capture',
  ui_profile: 'Design',
  text_normalize: 'Normalize',
  orchestrator: 'Orchestrator',
  manual: 'Manual session',
};

export const runKindLabel = (kind: TokenSaverRunKind): string =>
  RUN_KIND_LABEL[kind] ?? kind;

/**
 * Amendment 12: why no filter ran, as a person reads it. `none` is a row of a
 * runner from before the reasons were recorded (≤ 0.12.2, #648).
 */
const UNFILTERED_LABEL: Record<string, string> = {
  [FILTER_ID_NONE]: 'No filter (runner too old to say why)',
  [FILTER_ID_NONE_COMPOUND]: 'Compound command (not filtered)',
  [FILTER_ID_NONE_UNCOVERED]: 'No filter for this command',
  [FILTER_ID_NONE_MODE]: 'Not filtered in this permission mode',
  [FILTER_ID_NONE_OFF]: 'Filter switched off for this launch',
  [FILTER_ID_READ_REFUSED]: 'Whole-file read refused (use Read)',
};

/** #648: what each `none:*` reason means, for the reason table. */
export const UNFILTERED_HINT: Record<string, string> = {
  [FILTER_ID_NONE]:
    'The runner predates the reasons; update it to see which one applies.',
  [FILTER_ID_NONE_COMPOUND]:
    'A line with redirects, substitutions, loops or a trailing & — the hook only rewrites simple commands joined by |, &&, || or ;.',
  [FILTER_ID_NONE_UNCOVERED]: 'No filter family covers the program.',
  [FILTER_ID_NONE_MODE]:
    'The session ran in a permission mode where the hook never rewrites (only bypass, auto and plan do).',
  [FILTER_ID_NONE_OFF]:
    'A filter family covers the program, but the launch switched that family off.',
};

/** #663: what a session kind of cost per round is called on screen. */
export const SESSION_KIND_LABEL: Record<TokenSaverSessionKind, string> = {
  card: 'Card round',
  ci_fix: 'CI-fix round',
  design: 'Design',
  plan: 'Planner',
  worker: 'Orchestrator worker',
  card_capture: 'Capture',
  text_normalize: 'Normalize',
  assistant: 'Assistant chat',
};

/** #663: the launches cost per round cannot measure yet, as a person reads them. */
export const UNMEASURED_KIND_LABEL: Record<TokenSaverUnmeasuredKind, string> = {
  skill: 'skill runs',
  schedule: 'schedules',
  ui_profile: 'UI profile builds',
  card_assess: 'model assessments',
};

/** A filter id as a person reads it. */
export const filterLabel = (filter: string): string =>
  UNFILTERED_LABEL[filter] ?? filter;

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

/** A signed change as a percent, `−12%` / `+3%` / `0%`; blank when unknown. */
export function formatChange(change: number | null): string {
  if (change === null) return '';
  if (change === 0) return '0%';
  return `${change < 0 ? '−' : '+'}${formatRate(Math.abs(change))}`;
}

/**
 * #648: the share of a prompt's tokens read from the prompt cache, 0–1 —
 * cache reads over everything sent as input (uncached, cache reads and cache
 * writes); `0` for nothing.
 */
export function cacheReadShare(c: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  const total = c.input + c.cacheRead + c.cacheWrite;
  return total > 0 ? c.cacheRead / total : 0;
}

/** #648: input tokens per run, cache reads and writes included; `0` for no runs. */
export function inputTokensPerRun(c: {
  runs: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  return c.runs > 0 ? (c.input + c.cacheRead + c.cacheWrite) / c.runs : 0;
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
 * (kept visible, so saving never drops one silently). The runner's own server
 * (`nautelle`, `agentdock` before ADR-0073) is always loaded and is not a
 * choice. Sorted, unique.
 */
export function mcpChoices(
  profiles: readonly Pick<ProjectRuntimeProfile, 'mcpServers'>[],
  allowed: readonly string[],
): { name: string; reported: boolean }[] {
  const reported = new Set(
    profiles
      .flatMap((profile) => profile.mcpServers ?? [])
      .filter((name) => !isRunnerMcpServer(name)),
  );
  const names = new Set([...reported, ...allowed]);
  return [...names]
    .filter((name) => !isRunnerMcpServer(name))
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
