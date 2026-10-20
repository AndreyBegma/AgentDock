import {
  WORKFLOW_AGENT_TYPE,
  WORKFLOW_COLUMNS,
  WORKFLOW_COMPACTION_BUCKETS,
  WORKFLOW_OUTCOMES,
  WORKFLOW_TOP_AGENT_TYPES,
  type WorkflowColumn,
  type WorkflowCompactionBucket,
  type WorkflowOutcome,
  type WorkflowSankeyLink,
  type WorkflowSankeyNode,
  type WorkflowStatus,
  type WorkflowsOrchestrationResponse,
  type WorkflowsSummaryResponse,
  type WorkflowToolFlow,
  type WorkflowToolTransition,
} from '@nautelle/shared';
import type { Runtime } from '@nautelle/shared/protocol';

/**
 * The metric definitions of #161 that are not SQL: rows in, numbers out. The
 * contract's doc comment (`packages/shared/src/workflows`) states each one.
 * A session's outcome and compaction bucket are SQL (`workflow-sql.ts`), so
 * the routes read a few dozen groups instead of every session; the rest is
 * here, over those groups.
 */

/**
 * Root sessions that share a runtime, primary subagent type, compaction
 * bucket and outcome, with the sums the averages need.
 */
export interface WorkflowGroup {
  runtime: Runtime;
  agentType: string;
  bucket: WorkflowCompactionBucket;
  outcome: WorkflowOutcome;
  sessions: number;
  depth: number;
  subagents: number;
  compactions: number;
  durationMs: number;
}

/**
 * The tree's last signal is an error: no LLM request came after its last
 * `session.error`. A request at the same instant does not clear it.
 */
export const erroredOf = (
  lastErrorAt: Date | null,
  lastRequestAt: Date | null,
): boolean =>
  lastErrorAt !== null &&
  (lastRequestAt === null || lastErrorAt.getTime() >= lastRequestAt.getTime());

/** A key that is not a type name: none, unknown, other. */
const isPseudoType = (type: string): boolean => type.startsWith('~');

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The type most subagents of a tree had; ties go to the name first in order.
 * `types` holds one entry per subagent, null when its type is unknown.
 */
export const primaryAgentType = (
  types: ReadonlyArray<string | null>,
): string => {
  if (types.length === 0) return WORKFLOW_AGENT_TYPE.none;
  const counts = new Map<string, number>();
  for (const type of types) {
    if (type !== null) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const [best] = [...counts].sort(([a, x], [b, y]) => y - x || byName(a, b));
  return best ? best[0] : WORKFLOW_AGENT_TYPE.unknown;
};

/**
 * The `WORKFLOW_TOP_AGENT_TYPES` most common primary types (names only), by
 * sessions, then name.
 */
export const topAgentTypes = (
  groups: ReadonlyArray<Pick<WorkflowGroup, 'agentType' | 'sessions'>>,
): Set<string> => {
  const counts = new Map<string, number>();
  for (const { agentType, sessions } of groups) {
    if (!isPseudoType(agentType)) {
      counts.set(agentType, (counts.get(agentType) ?? 0) + sessions);
    }
  }
  return new Set(
    [...counts]
      .sort(([a, x], [b, y]) => y - x || byName(a, b))
      .slice(0, WORKFLOW_TOP_AGENT_TYPES)
      .map(([type]) => type),
  );
};

/** Where a primary type sits in the Sankey: itself, or "+N more". */
const typeKey = (type: string, top: ReadonlySet<string>): string =>
  isPseudoType(type) || top.has(type) ? type : WORKFLOW_AGENT_TYPE.other;

export interface ScopeFilters {
  status?: WorkflowStatus;
  outcome?: WorkflowOutcome;
  agentType?: string;
  compactions?: WorkflowCompactionBucket;
}

/**
 * The groups the page shows: the status and node filters. `agentType=~other`
 * is a type outside the top types of the scope the other filters leave, so it
 * names the same sessions as the "+N more" node the person clicked.
 */
export const scope = (
  groups: readonly WorkflowGroup[],
  filters: ScopeFilters,
): WorkflowGroup[] => {
  const status = filters.status ?? 'all';
  const kept = groups.filter(
    (g) =>
      (status === 'all' ||
        (status === 'active') === (g.outcome === 'active')) &&
      (filters.outcome === undefined || g.outcome === filters.outcome) &&
      (filters.compactions === undefined || g.bucket === filters.compactions),
  );
  const { agentType } = filters;
  if (agentType === undefined) return kept;
  if (agentType !== WORKFLOW_AGENT_TYPE.other) {
    return kept.filter((g) => g.agentType === agentType);
  }
  const top = topAgentTypes(kept);
  return kept.filter(
    (g) => typeKey(g.agentType, top) === WORKFLOW_AGENT_TYPE.other,
  );
};

const emptyOutcomes = (): Record<WorkflowOutcome, number> => ({
  completed: 0,
  error: 0,
  abandoned: 0,
  active: 0,
});

/** The six metrics, and the counts behind them. Averages are over sessions. */
export const summarize = (
  groups: readonly WorkflowGroup[],
  topToolFlow: WorkflowToolFlow | null,
  computedAt: Date,
): WorkflowsSummaryResponse => {
  const outcomes = emptyOutcomes();
  const sum = { sessions: 0, depth: 0, subagents: 0, compactions: 0, ms: 0 };
  for (const g of groups) {
    outcomes[g.outcome] += g.sessions;
    sum.sessions += g.sessions;
    sum.depth += g.depth;
    sum.subagents += g.subagents;
    sum.compactions += g.compactions;
    sum.ms += g.durationMs;
  }
  const average = (total: number): number | null =>
    sum.sessions === 0 ? null : total / sum.sessions;
  const ended = sum.sessions - outcomes.active;
  return {
    sessions: sum.sessions,
    active: outcomes.active,
    ended,
    outcomes,
    avgDepth: average(sum.depth),
    avgSubagents: average(sum.subagents),
    successRate: ended === 0 ? null : outcomes.completed / ended,
    topToolFlow,
    avgCompactions: average(sum.compactions),
    avgDurationMs: average(sum.ms),
    computedAt: computedAt.toISOString(),
  };
};

const COLUMN_LABEL: Record<WorkflowColumn, string> = {
  origin: 'Origin',
  agent: 'Main agent',
  subagentType: 'Subagent types',
  compactions: 'Compactions',
  outcome: 'Outcomes',
};

const RUNTIME_LABEL: Record<Runtime, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const COMPACTION_LABEL: Record<WorkflowCompactionBucket, string> = {
  none: 'No compaction',
  one: '1 compaction',
  many: '2+ compactions',
};

const OUTCOME_LABEL: Record<WorkflowOutcome, string> = {
  completed: 'Completed',
  error: 'Error',
  abandoned: 'Abandoned',
  active: 'Active',
};

/** Pseudo types after the named ones, in this order. */
const PSEUDO_ORDER: readonly string[] = [
  WORKFLOW_AGENT_TYPE.other,
  WORKFLOW_AGENT_TYPE.unknown,
  WORKFLOW_AGENT_TYPE.none,
];

const typeLabel = (type: string, folded: number): string =>
  type === WORKFLOW_AGENT_TYPE.none
    ? 'No subagents'
    : type === WORKFLOW_AGENT_TYPE.unknown
      ? 'Unknown type'
      : type === WORKFLOW_AGENT_TYPE.other
        ? `+${folded} more`
        : type;

/** Within a column: the fixed order where there is one, else -1 (by value). */
const rank = (node: WorkflowSankeyNode): number => {
  const { filter } = node;
  if (filter?.key === 'compactions') {
    return WORKFLOW_COMPACTION_BUCKETS.indexOf(filter.value);
  }
  if (filter?.key === 'outcome') return WORKFLOW_OUTCOMES.indexOf(filter.value);
  if (filter?.key === 'agentType') return PSEUDO_ORDER.indexOf(filter.value);
  return -1;
};

/**
 * The orchestration Sankey. Each root session follows one path — origin →
 * runtime → primary type → compaction bucket → outcome — so every column
 * sums to the session count. The top types are those of `groups` themselves:
 * after a click on "+N more", the folded types unfold.
 */
export const orchestration = (
  groups: readonly WorkflowGroup[],
  computedAt: Date,
): WorkflowsOrchestrationResponse => {
  const top = topAgentTypes(groups);
  const folded = new Set<string>();
  const nodes = new Map<string, WorkflowSankeyNode>();
  const links = new Map<string, WorkflowSankeyLink>();
  let sessions = 0;

  const add = (
    node: Omit<WorkflowSankeyNode, 'value'>,
    value: number,
  ): void => {
    const found = nodes.get(node.id);
    if (found) found.value += value;
    else nodes.set(node.id, { ...node, value });
  };
  const link = (source: string, target: string, value: number): void => {
    const key = `${source}\n${target}`;
    const found = links.get(key);
    if (found) found.value += value;
    else links.set(key, { source, target, value });
  };

  for (const g of groups) {
    if (g.sessions === 0) continue;
    sessions += g.sessions;
    const type = typeKey(g.agentType, top);
    if (type === WORKFLOW_AGENT_TYPE.other) folded.add(g.agentType);
    const path: Omit<WorkflowSankeyNode, 'value'>[] = [
      { id: 'origin', label: 'Sessions', column: 'origin', filter: null },
      {
        id: `agent:${g.runtime}`,
        label: RUNTIME_LABEL[g.runtime],
        column: 'agent',
        filter: { key: 'runtime', value: g.runtime },
      },
      {
        id: `type:${type}`,
        label: type,
        column: 'subagentType',
        filter: { key: 'agentType', value: type },
      },
      {
        id: `compactions:${g.bucket}`,
        label: COMPACTION_LABEL[g.bucket],
        column: 'compactions',
        filter: { key: 'compactions', value: g.bucket },
      },
      {
        id: `outcome:${g.outcome}`,
        label: OUTCOME_LABEL[g.outcome],
        column: 'outcome',
        filter: { key: 'outcome', value: g.outcome },
      },
    ];
    path.forEach((node, i) => {
      add(node, g.sessions);
      if (i > 0) link(path[i - 1].id, node.id, g.sessions);
    });
  }

  for (const node of nodes.values()) {
    if (node.column !== 'subagentType') continue;
    node.label = typeLabel(node.label, folded.size);
    if (node.id === `type:${WORKFLOW_AGENT_TYPE.other}`) {
      node.folded = folded.size;
    }
  }

  const ordered = [...nodes.values()].sort(
    (a, b) =>
      WORKFLOW_COLUMNS.indexOf(a.column) - WORKFLOW_COLUMNS.indexOf(b.column) ||
      rank(a) - rank(b) ||
      b.value - a.value ||
      byName(a.label, b.label),
  );

  return {
    sessions,
    columns: WORKFLOW_COLUMNS.map((id) => ({ id, label: COLUMN_LABEL[id] })),
    nodes: ordered,
    links: [...links.values()],
    computedAt: computedAt.toISOString(),
  };
};

/** A `from → to` pair summed over the sessions in scope. */
export interface TransitionSum {
  from: string;
  to: string;
  count: number;
  errors: number;
}

const byFrequency = (a: TransitionSum, b: TransitionSum): number =>
  b.count - a.count || byName(a.from, b.from) || byName(a.to, b.to);

/** The transitions, most frequent first, `limit` of them, with error shares. */
export const toolTransitions = (
  sums: readonly TransitionSum[],
  limit: number,
): WorkflowToolTransition[] =>
  [...sums]
    .sort(byFrequency)
    .slice(0, limit)
    .map((t) => ({
      from: t.from,
      to: t.to,
      count: t.count,
      errors: t.errors,
      errorShare: t.count === 0 ? 0 : t.errors / t.count,
    }));

/** The most frequent transition — the top bigram — or null without one. */
export const topToolFlow = (
  sums: readonly TransitionSum[],
): WorkflowToolFlow | null => {
  const [top] = toolTransitions(sums, 1);
  return top ? { from: top.from, to: top.to, count: top.count } : null;
};
