import {
  SESSION_ERROR,
  type SessionListQuery,
  type SessionRequestNode,
  type SessionToolNode,
  type SessionTotals,
  type SessionTreeNode,
  type SessionTurnNode,
} from '@agentdock/shared';
import type { Runtime } from '@agentdock/shared/protocol';
import type { TreeItem } from 'glass-ui/tree';
import { ApiError, describeError } from '../api';

/** `1234` → `1.2k`, `2_500_000` → `2.5M`. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1_000)}k`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}B`;
}

const trim = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');

/** Cost is blank until #13 prices a request. */
export function formatCost(costUsd: string | null): string {
  if (costUsd === null) return '—';
  const value = Number(costUsd);
  if (!Number.isFinite(value)) return '—';
  return value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString();

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

export interface BuiltTree {
  items: TreeItem[];
  info: Map<string, TreeNodeInfo>;
  /** Ids of the rows open by default: the root session and its turns. */
  defaultExpanded: string[];
}

const tokenLabel = (t: SessionTotals): string =>
  `${formatTokens(tokenSum(t))} tok`;

export function sessionLabel(node: SessionTreeNode): string {
  const s = node.session;
  return `${s.title ?? s.externalId.slice(0, 8)} · ${tokenLabel(node.totals)}`;
}

/** The tree of one session: turns → requests and tools → child sessions. */
export function buildTree(root: SessionTreeNode): BuiltTree {
  const info = new Map<string, TreeNodeInfo>();
  const defaultExpanded: string[] = [];

  const request = (r: SessionRequestNode): TreeItem => {
    const id = `request:${r.id}`;
    info.set(id, { kind: 'request', request: r });
    return {
      id,
      label: `${r.model} (${r.querySource}) · ${tokenLabel(r.totals)}`,
    };
  };

  const tool = (t: SessionToolNode): TreeItem => {
    const id = `tool:${t.id}`;
    info.set(id, { kind: 'tool', tool: t });
    const label = `${t.name}${t.ok === false ? ' ✗' : ''}${
      t.child ? ` · ${tokenLabel(t.totals)}` : ''
    }`;
    return t.child
      ? { id, label, children: [session(t.child)] }
      : { id, label };
  };

  const session = (node: SessionTreeNode): TreeItem => {
    const id = `session:${node.session.id}`;
    info.set(id, { kind: 'session', node });
    const children: TreeItem[] = node.turns.map((turn, index) => {
      const turnId = `turn:${turn.id}`;
      info.set(turnId, { kind: 'turn', turn, index });
      defaultExpanded.push(turnId);
      return {
        id: turnId,
        label: `Turn ${index + 1} · ${tokenLabel(turn.totals)}`,
        children: [...turn.requests.map(request), ...turn.tools.map(tool)],
      };
    });
    const { requests, tools } = node.unattributed;
    if (requests.length + tools.length > 0) {
      const groupId = `unattributed:${node.session.id}`;
      info.set(groupId, {
        kind: 'group',
        label: 'No turn known',
        totals: sumTotals([...requests, ...tools].map((n) => n.totals)),
      });
      children.push({
        id: groupId,
        label: 'No turn known',
        children: [...requests.map(request), ...tools.map(tool)],
      });
    }
    for (const sub of node.subagents) children.push(session(sub));
    defaultExpanded.push(id);
    return { id, label: sessionLabel(node), children };
  };

  return { items: [session(root)], info, defaultExpanded };
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

/** A bar's left offset and width as percentages of `[origin, origin + span]`. */
export function barGeometry(
  [start, end]: [number, number],
  origin: number,
  span: number,
): { left: number; width: number } {
  if (span <= 0) return { left: 0, width: 100 };
  const left = Math.min(100, Math.max(0, ((start - origin) / span) * 100));
  const width = Math.min(
    100 - left,
    Math.max(0.5, ((end - start) / span) * 100),
  );
  return { left, width };
}

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
