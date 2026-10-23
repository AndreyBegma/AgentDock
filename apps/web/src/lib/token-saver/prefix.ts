import {
  type CardType,
  OVERLAY_PART_CLAUDE_MD,
  OVERLAY_PART_RULES,
  PREFIX_ERROR,
  type PrefixOrigin,
  type PrefixOverlayDetailView,
  type PrefixOverlayPullRequestResult,
  type PrefixOverlayState,
  type PrefixOverlayView,
  type PrefixPartKind,
  type PrefixSummaryView,
  type ProposePrefixOverlayResult,
  skillOfPart,
} from '@nautelle/shared';
import { ApiError, api, describeError } from '../api';
import { RUN_KIND_LABEL } from './format';

/** `/projects/:id/prefix/overlays` (#751): viewers read, a project admin acts. */
const overlays = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/prefix/overlays`;

export const fetchPrefixSummary = (
  projectId: string,
  range: { from: string; to: string },
) =>
  api<PrefixSummaryView>(
    `/projects/${encodeURIComponent(projectId)}/token-saver/prefix?${new URLSearchParams(
      { from: range.from, to: range.to },
    ).toString()}`,
  );

export const fetchPrefixOverlays = (projectId: string) =>
  api<PrefixOverlayView[]>(overlays(projectId));

/** Admin only: the diff's two sides. */
export const fetchPrefixOverlay = (projectId: string, overlayId: string) =>
  api<PrefixOverlayDetailView>(
    `${overlays(projectId)}/${encodeURIComponent(overlayId)}`,
  );

export const proposePrefixOverlay = (projectId: string, part: string) =>
  api<ProposePrefixOverlayResult>(`${overlays(projectId)}/propose`, {
    method: 'POST',
    body: { part },
  });

const decide = (projectId: string, overlayId: string, verb: string) =>
  api<PrefixOverlayView>(
    `${overlays(projectId)}/${encodeURIComponent(overlayId)}/${verb}`,
    { method: 'POST' },
  );

export const approvePrefixOverlay = (projectId: string, overlayId: string) =>
  decide(projectId, overlayId, 'approve');

export const rejectPrefixOverlay = (projectId: string, overlayId: string) =>
  decide(projectId, overlayId, 'reject');

export const openOverlayPullRequest = (projectId: string, overlayId: string) =>
  api<PrefixOverlayPullRequestResult>(
    `${overlays(projectId)}/${encodeURIComponent(overlayId)}/pull-request`,
    { method: 'POST' },
  );

// Labels

export const CARD_TYPE_LABEL: Record<CardType, string> = {
  ci_fix: 'CI fix',
  ui: 'UI',
  bug: 'Bug',
  feature: 'Feature',
};

/** A launch kind (a string on the wire) as a person reads it. */
export const launchKindLabel = (kind: string): string =>
  (RUN_KIND_LABEL as Record<string, string>)[kind] ?? kind;

export const PART_KIND_LABEL: Record<PrefixPartKind, string> = {
  claude_md: 'CLAUDE.md',
  rules: 'Rules',
  nautelle: 'Nautelle',
  skill: 'Skill',
  mcp: 'MCP server',
  agents: 'Agents',
};

export const ORIGIN_LABEL: Record<PrefixOrigin, string> = {
  repo: 'Repository',
  profile: 'Profile',
  plugin: 'Plugin',
  nautelle: 'Nautelle',
};

export const OVERLAY_STATE_LABEL: Record<PrefixOverlayState, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  stale: 'Stale',
};

export type OverlayTone = 'neutral' | 'success' | 'warning' | 'danger';

export const OVERLAY_STATE_TONE: Record<PrefixOverlayState, OverlayTone> = {
  proposed: 'warning',
  approved: 'success',
  rejected: 'neutral',
  stale: 'danger',
};

/** An overlay's part as a person reads it: `CLAUDE.md`, `Skill review`, `Rules`. */
export function overlayPartLabel(part: string): string {
  if (part === OVERLAY_PART_CLAUDE_MD) return 'CLAUDE.md';
  if (part === OVERLAY_PART_RULES) return 'Injected rules';
  const skill = skillOfPart(part);
  return skill ? `Skill ${skill}` : part;
}

// Sizes

/** "≈ 1,240 → ≈ 860 tokens (−31%)" for a before → after pair. */
export function sizeChange(
  before: number,
  after: number,
): { delta: number; percent: number } {
  const delta = after - before;
  return {
    delta,
    percent: before > 0 ? Math.round((delta / before) * 100) : 0,
  };
}

/** How full a budget bar is, 0..1 (a launch over budget stays at 1). */
export function budgetFill(tokens: number, budget: number): number {
  if (budget <= 0) return 1;
  return Math.min(1, Math.max(0, tokens / budget));
}

// Diff

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

/** Above this many cells the exact diff is skipped and both sides are shown whole. */
const DIFF_CELL_LIMIT = 4_000_000;

/**
 * A line diff (longest common subsequence). Large inputs fall back to "all
 * removed, all added" instead of a quadratic table.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > DIFF_CELL_LIMIT) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'remove', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string });
      i++;
      j++;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      out.push({ kind: 'remove', text: a[i] as string });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] as string });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'remove', text: a[i] as string });
  for (; j < b.length; j++) out.push({ kind: 'add', text: b[j] as string });
  return out;
}

const DIFF_MARK: Record<DiffLine['kind'], string> = {
  same: '  ',
  add: '+ ',
  remove: '- ',
};

/** The diff as unified text (`+ ` added, `- ` removed), for a glass-ui CodeBlock. */
export const unifiedDiff = (lines: readonly DiffLine[]): string =>
  lines.map((l) => `${DIFF_MARK[l.kind]}${l.text}`).join('\n');

/**
 * A `rules` overlay carries `{ rules: [...] }` as JSON on both sides; the
 * diff reads better as the rules block. Any other text is returned as it is.
 */
export function renderOverlayText(part: string, text: string): string {
  if (part !== OVERLAY_PART_RULES) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    const rules =
      typeof parsed === 'object' && parsed !== null && 'rules' in parsed
        ? (parsed as { rules: unknown }).rules
        : null;
    if (!Array.isArray(rules)) return text;
    return rules
      .map((r: { title?: unknown; description?: unknown }, i) => {
        const description =
          typeof r.description === 'string' ? r.description.trim() : '';
        return `${i + 1}. **${String(r.title ?? '')}**${description ? ` — ${description}` : ''}`;
      })
      .join('\n');
  } catch {
    return text;
  }
}

// Selection matrix (B5)

/** The names of `list` with `name` switched on or off, sorted, unique. */
export function toggleName(
  list: readonly string[],
  name: string,
  on: boolean,
): string[] {
  const rest = list.filter((n) => n !== name);
  return (on ? [...rest, name] : rest).sort((a, b) => a.localeCompare(b));
}

/**
 * The MCP servers a card type loads: its own list, or every allowed server
 * when the type has none (a type without a key is not narrowed).
 */
export function mcpForType(
  byType: Partial<Record<string, string[]>>,
  type: CardType,
  allow: readonly string[],
): string[] {
  return byType[type] ?? [...allow];
}

/**
 * `mcpByType` after `name` is switched on or off for `type`. A list that
 * equals the whole allowlist is dropped, so the type is not narrowed.
 */
export function setMcpForType(
  byType: Partial<Record<string, string[]>>,
  type: CardType,
  name: string,
  on: boolean,
  allow: readonly string[],
): Partial<Record<string, string[]>> {
  const next = toggleName(mcpForType(byType, type, allow), name, on);
  const { [type]: _dropped, ...rest } = byType;
  return next.length === allow.length && allow.every((n) => next.includes(n))
    ? rest
    : { ...rest, [type]: next };
}

/** `skillsOffByType` after `name` is hidden or shown for `type`; empty lists are dropped. */
export function setSkillOffForType(
  byType: Partial<Record<string, string[]>>,
  type: CardType,
  name: string,
  off: boolean,
): Partial<Record<string, string[]>> {
  const next = toggleName(byType[type] ?? [], name, off);
  const { [type]: _dropped, ...rest } = byType;
  return next.length === 0 ? rest : { ...rest, [type]: next };
}

/** `mcpByType` narrowed to what `allow` still holds, as the API requires. */
export function pruneMcpByType(
  byType: Partial<Record<string, string[]>>,
  allow: readonly string[],
): Partial<Record<string, string[]>> {
  return Object.fromEntries(
    Object.entries(byType).flatMap(([type, names]) =>
      names ? [[type, names.filter((n) => allow.includes(n))]] : [],
    ),
  );
}

export const sameByType = (
  a: Partial<Record<string, string[]>>,
  b: Partial<Record<string, string[]>>,
): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key] ?? [];
    const y = b[key] ?? [];
    if (x.length !== y.length || !x.every((n) => y.includes(n))) return false;
  }
  return true;
};

/** Skill names a person can hide: those the runner reported, plus those already hidden. */
export function skillChoices(
  reported: readonly string[],
  skillsOffByType: Partial<Record<string, string[]>>,
): string[] {
  const names = new Set(reported);
  for (const list of Object.values(skillsOffByType)) {
    for (const name of list ?? []) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function describePrefixError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code as string | undefined) {
      case PREFIX_ERROR.notFound:
        return 'That overlay no longer exists. The list has been reloaded.';
      case PREFIX_ERROR.notProposed:
        return 'That overlay was already decided. The list has been reloaded.';
      case PREFIX_ERROR.notPullable:
        return 'Only an approved CLAUDE.md or skill overlay can become a pull request.';
      case PREFIX_ERROR.openProposal:
        return 'This part already has an open proposal.';
      case PREFIX_ERROR.runnerUnavailable:
        return 'No runner can make a proposal right now. Try again when one is online.';
    }
    if (error.status === 403) {
      return 'Only a project administrator can do that.';
    }
    if (error.status === 404) {
      return 'That project was not found, or you are not a member of it.';
    }
  }
  return describeError(error);
}
