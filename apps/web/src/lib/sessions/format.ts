import {
  SESSION_ERROR,
  type SessionListQuery,
  type SessionRequestNode,
  type SessionToolNode,
  type SessionTotals,
  type SessionTreeNode,
  type SessionTurnNode,
} from '@agentdock/shared';
import type { QuerySource, Runtime } from '@agentdock/shared/protocol';
import type { TraceNode } from '@andrewbehma/glass-ui/trace-tree';
import { ApiError, describeError, type ErrorHint } from '../api';
import {
  formatCost as formatCostShared,
  formatDate,
  formatDuration as formatDurationShared,
  formatTokens as formatTokensShared,
} from '../format';

/** `1234` → `1.2k`, `2_500_000` → `2.5M`. */
export function formatTokens(n: number): string {
  return formatTokensShared(n);
}

/** Cost is a dash until #13 prices a request. */
export function formatCost(costUsd: string | null): string {
  return formatCostShared(costUsd) || '—';
}

/** "850 ms", "12.4 s", "3 min 05 s"; a dash when unknown. */
export function formatDuration(ms: number | null): string {
  return formatDurationShared(ms) || '—';
}

export const formatTime = (iso: string): string => formatDate(iso, 'datetime');

/** Everything the node read or wrote; `reasoning` is already inside `output`. */
export const tokenSum = (t: SessionTotals): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

export const cacheTokens = (t: SessionTotals): number =>
  t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

/** Filters as the form holds them: strings, empty meaning "not set". */
export interface SessionFilterForm {
  projectId: string;
  runtime: string;
  model: string;
  slot: string;
  fromDate: string;
  toDate: string;
  unassigned: boolean;
}

export const EMPTY_FILTERS: SessionFilterForm = {
  projectId: '',
  runtime: '',
  model: '',
  slot: '',
  fromDate: '',
  toDate: '',
  unassigned: false,
};

/** `yyyy-mm-dd` from a date input as a local-time instant; `to` is exclusive. */
function dayBoundary(date: string, nextDay: boolean): string | undefined {
  if (!date) return undefined;
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString();
}

export function toQuery(form: SessionFilterForm): SessionListQuery {
  const query: SessionListQuery = {};
  // `unassigned` excludes `projectId` (400 invalid_filter), so it wins here.
  if (form.unassigned) query.unassigned = true;
  else if (form.projectId) query.projectId = form.projectId;
  if (form.runtime) query.runtime = form.runtime as Runtime;
  if (form.model.trim()) query.model = form.model.trim();
  if (form.slot.trim()) query.slot = form.slot.trim();
  const from = dayBoundary(form.fromDate, false);
  const to = dayBoundary(form.toDate, true);
  if (from) query.from = from;
  if (to) query.to = to;
  return query;
}

export function queryString(
  query: SessionListQuery,
  extra: { cursor?: string; limit?: number } = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...extra })) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Which live topic keeps a list or a detail page fresh; null → poll instead. */
export function liveTopicFor(scope: {
  projectId?: string | null;
  unassigned?: boolean;
}): `project:${string}` | 'admin' | null {
  if (scope.unassigned) return 'admin';
  return scope.projectId ? `project:${scope.projectId}` : null;
}

/* ── tree ─────────────────────────────────────────────────────────────── */

export type TreeNodeInfo =
  | { kind: 'session'; node: SessionTreeNode }
  | { kind: 'turn'; turn: SessionTurnNode; index: number }
  | { kind: 'request'; request: SessionRequestNode }
  | { kind: 'tool'; tool: SessionToolNode }
  | { kind: 'group'; label: string; totals: SessionTotals };

export interface BuiltTrace {
  nodes: TraceNode[];
  info: Map<string, TreeNodeInfo>;
  /** Ids of the rows open by default: the root session and its turns. */
  defaultExpanded: string[];
}

/** "12.3k tok · $0.42"; the cost is left out until the node is priced. */
export function totalsLabel(t: SessionTotals): string {
  const tokens = `${formatTokens(tokenSum(t))} tok`;
  return t.costUsd === null ? tokens : `${tokens} · ${formatCost(t.costUsd)}`;
}

/** What a session is called: its title, else the start of its runtime id. */
export const sessionName = (s: SessionTreeNode['session']): string =>
  s.title ?? `Session ${s.externalId.slice(0, 8)}`;

export const QUERY_SOURCE_LABEL: Record<QuerySource, string> = {
  main: 'main thread',
  subagent: 'subagent',
  auxiliary: 'auxiliary',
};

const ms = (iso: string | null): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/**
 * The session as glass-ui `TraceTree` nodes: a session is an `agent`, a turn a
 * `turn`, a model request an `llm` span and a tool call a `tool` span — a
 * turn's requests and tools interleaved in the order they started. A tool that
 * spawned a subagent holds that session. Work the transcript could not place
 * in a turn is an `other` group at the end.
 */
export function buildTrace(root: SessionTreeNode): BuiltTrace {
  const info = new Map<string, TreeNodeInfo>();
  const defaultExpanded: string[] = [];

  const request = (r: SessionRequestNode): TraceNode => {
    const id = `request:${r.id}`;
    info.set(id, { kind: 'request', request: r });
    const end = ms(r.ts) ?? 0;
    return {
      id,
      kind: 'llm',
      label: r.model,
      meta: QUERY_SOURCE_LABEL[r.querySource] ?? r.querySource,
      start: end - (r.durationMs ?? 0),
      end,
      totals: totalsLabel(r.totals),
      status: 'ok',
    };
  };

  const tool = (t: SessionToolNode, live: boolean): TraceNode => {
    const id = `tool:${t.id}`;
    info.set(id, { kind: 'tool', tool: t });
    const start = ms(t.startedAt) ?? 0;
    const end = ms(t.endedAt);
    const node: TraceNode = {
      id,
      kind: 'tool',
      label: t.name,
      start,
      // A tool with no result in a finished session never ran on: it ends where it began.
      end: end ?? (t.ok === null && live ? undefined : start),
      status:
        t.ok === false
          ? 'error'
          : t.ok === null
            ? live
              ? 'running'
              : undefined
            : 'ok',
      ...(t.child ? { totals: totalsLabel(t.totals) } : {}),
    };
    return t.child ? { ...node, children: [session(t.child)] } : node;
  };

  /** Requests and tools in the order they started; a tie keeps requests first. */
  const interleave = (
    requests: SessionRequestNode[],
    tools: SessionToolNode[],
    live: boolean,
  ): TraceNode[] =>
    [...requests.map(request), ...tools.map((t) => tool(t, live))]
      .map((node, order) => ({ node, order }))
      .sort((a, b) => a.node.start - b.node.start || a.order - b.order)
      .map(({ node }) => node);

  const session = (node: SessionTreeNode): TraceNode => {
    const s = node.session;
    const id = `session:${s.id}`;
    const live = s.endedAt === null;
    info.set(id, { kind: 'session', node });
    const children: TraceNode[] = node.turns.map((turn, index) => {
      const turnId = `turn:${turn.id}`;
      info.set(turnId, { kind: 'turn', turn, index });
      defaultExpanded.push(turnId);
      return {
        id: turnId,
        kind: 'turn',
        label: `Turn ${index + 1}`,
        start: ms(turn.startedAt) ?? 0,
        end: ms(turn.endedAt),
        totals: totalsLabel(turn.totals),
        children: interleave(turn.requests, turn.tools, live),
      };
    });
    const { requests, tools } = node.unattributed;
    if (requests.length + tools.length > 0) {
      const groupId = `unattributed:${s.id}`;
      const loose = interleave(requests, tools, live);
      const groupTotals = sumTotals(
        [...requests, ...tools].map((n) => n.totals),
      );
      info.set(groupId, {
        kind: 'group',
        label: 'No turn known',
        totals: groupTotals,
      });
      children.push({
        id: groupId,
        kind: 'other',
        label: 'No turn known',
        start: Math.min(...loose.map((n) => n.start)),
        end: Math.max(...loose.map((n) => n.end ?? n.start)),
        totals: totalsLabel(groupTotals),
        children: loose,
      });
    }
    for (const sub of node.subagents) children.push(session(sub));
    defaultExpanded.push(id);
    return {
      id,
      kind: 'agent',
      label: sessionName(s),
      meta: s.models.join(', ') || undefined,
      start: ms(s.startedAt) ?? 0,
      end: ms(s.endedAt ?? s.lastEventAt),
      totals: totalsLabel(node.totals),
      status: live ? 'running' : undefined,
      children,
    };
  };

  return { nodes: [session(root)], info, defaultExpanded };
}

export function sumTotals(list: SessionTotals[]): SessionTotals {
  const sum: SessionTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    requests: 0,
    costUsd: null,
  };
  for (const t of list) {
    sum.input += t.input;
    sum.output += t.output;
    sum.cacheRead += t.cacheRead;
    sum.cacheWrite5m += t.cacheWrite5m;
    sum.cacheWrite1h += t.cacheWrite1h;
    sum.reasoning += t.reasoning;
    sum.requests += t.requests;
    if (t.costUsd !== null) {
      sum.costUsd = String(Number(sum.costUsd ?? 0) + Number(t.costUsd));
    }
  }
  return sum;
}

/** `[start, end]` of a node in epoch ms, when it has both a start and a duration. */
export function nodeSpan(info: TreeNodeInfo): [number, number] | null {
  switch (info.kind) {
    case 'session': {
      const s = info.node.session;
      return [Date.parse(s.startedAt), Date.parse(s.endedAt ?? s.lastEventAt)];
    }
    case 'turn':
      return info.turn.endedAt
        ? [Date.parse(info.turn.startedAt), Date.parse(info.turn.endedAt)]
        : [Date.parse(info.turn.startedAt), Date.parse(info.turn.startedAt)];
    case 'request': {
      const end = Date.parse(info.request.ts);
      return [end - (info.request.durationMs ?? 0), end];
    }
    case 'tool': {
      const start = Date.parse(info.tool.startedAt);
      return [start, info.tool.endedAt ? Date.parse(info.tool.endedAt) : start];
    }
    default:
      return null;
  }
}

/** The sentence, plus the page that fixes it when there is one. */
export function describeSessionHint(error: unknown): ErrorHint {
  const text = describeSessionError(error);
  const code: string | undefined =
    error instanceof ApiError ? error.code : undefined;
  if (code === SESSION_ERROR.forbidden) {
    return { text, href: '/sessions', cta: 'Show my sessions' };
  }
  return { text };
}

/** Whether a query narrows the list at all (none: "nothing yet", some: "no matches"). */
export const hasSessionFilters = (query: SessionListQuery): boolean =>
  Object.values(query).some((value) => value !== undefined && value !== '');

/** How many filters narrow the list — the count on the phone's "Filters" button. */
export const appliedFilterCount = (query: SessionListQuery): number => {
  const { from, to, ...rest } = query;
  const dates = from !== undefined || to !== undefined ? 1 : 0;
  return (
    dates +
    Object.values(rest).filter((value) => value !== undefined && value !== '')
      .length
  );
};

/** Whether the form holds filters that were not applied yet. */
export const sessionFormChanged = (
  form: SessionFilterForm,
  applied: SessionListQuery,
): boolean => queryString(toQuery(form)) !== queryString(applied);

export function describeSessionError(error: unknown): string {
  if (error instanceof ApiError) {
    // `ApiError.code` is typed for auth errors; sessions add their own codes.
    const code: string | undefined = error.code;
    if (code === SESSION_ERROR.notFound) {
      return 'This session does not exist, or you cannot see it.';
    }
    if (code === SESSION_ERROR.forbidden) {
      return 'Only administrators can list sessions that have no project.';
    }
    if (code === SESSION_ERROR.invalidFilter) {
      return `Invalid filter: ${error.message}`;
    }
  }
  return describeError(error);
}
