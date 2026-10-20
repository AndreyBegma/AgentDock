import { type Hue, hueFor } from '@andrewbehma/glass-ui/hue';
import type {
  SankeyColumn,
  SankeyLink,
  SankeyNode,
  SankeyTone,
} from '@andrewbehma/glass-ui/sankey';
import type {
  WorkflowOutcome,
  WorkflowSankeyNode,
  WorkflowsOrchestrationResponse,
  WorkflowToolTransition,
} from '@nautelle/shared';

/* ── Sankeys: the two graphs of /workflows ──────────────────────────── */

const OUTCOME_TONE: Record<WorkflowOutcome, SankeyTone> = {
  completed: 'ok',
  error: 'danger',
  abandoned: 'warn',
  active: 'accent',
};

/**
 * How an orchestration node is painted. Outcomes wear their state's tone;
 * runtimes and named subagent types an identity hue, stable by name, so a
 * type keeps its colour from one range to the next. The `~` buckets and
 * compactions are neutral: they are groupings, not things.
 */
export function orchestrationNodeLook(
  node: WorkflowSankeyNode,
): Pick<SankeyNode, 'tone' | 'hue'> {
  const filter = node.filter;
  if (!filter) return { tone: 'neutral' };
  switch (filter.key) {
    case 'outcome':
      return { tone: OUTCOME_TONE[filter.value] };
    case 'runtime':
      return { hue: hueFor(`runtime:${filter.value}`) };
    case 'agentType':
      return filter.value.startsWith('~')
        ? { tone: 'neutral' }
        : { hue: hueFor(`agent:${filter.value}`) };
    case 'compactions':
      return { tone: filter.value === 'many' ? 'series-4' : 'neutral' };
  }
}

export interface SankeyInput {
  columns: SankeyColumn[];
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export function orchestrationSankey(
  data: WorkflowsOrchestrationResponse,
): SankeyInput {
  return {
    columns: data.columns.map(({ id, label }) => ({ id, label })),
    nodes: data.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      column: node.column,
      value: node.value,
      ...orchestrationNodeLook(node),
    })),
    links: data.links,
  };
}

/**
 * The API folds subagent types to the top 8, then "+N more", "Unknown type"
 * and "No subagents". Past that, glass-ui would fold again into its own
 * "+N more", whose click names no filter — so the graph is allowed them all.
 */
export const ORCHESTRATION_MAX_PER_COLUMN = 12;

export const toolHue = (tool: string): Hue => hueFor(`tool:${tool}`);

/**
 * A tool's name short enough for a Sankey card (#213). An MCP tool
 * (`mcp__<server>__<tool>`) reads "server · tool", a plugin's server without
 * its `plugin_` prefix or a repeated name. The full name stays in the
 * transitions table and the export.
 */
export function toolLabel(tool: string): string {
  const match = /^mcp__(.+)__([^_].*)$/.exec(tool);
  if (!match) return tool;
  let server = match[1].replace(/^plugin_/, '');
  const half = server.length / 2;
  if (
    Number.isInteger(half - 0.5) &&
    server.slice(0, half - 0.5) === server.slice(half + 0.5)
  ) {
    server = server.slice(0, half - 0.5);
  }
  return `${server} · ${match[2]}`;
}

/**
 * The tool flow as a two-column Sankey. A transition can loop (Bash → Bash)
 * and the graph can cycle, which one column cannot draw left to right, so a
 * tool has a node on each side: `from:<tool>` and `to:<tool>`, the same hue.
 */
export function toolSankey(
  transitions: readonly WorkflowToolTransition[],
): SankeyInput {
  const nodes = new Map<string, SankeyNode>();
  const add = (side: 'from' | 'to', tool: string) => {
    const id = `${side}:${tool}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: toolLabel(tool),
        column: side,
        hue: toolHue(tool),
      });
    }
    return id;
  };
  const links = transitions.map((t) => ({
    source: add('from', t.from),
    target: add('to', t.to),
    value: t.count,
  }));
  return {
    columns: [
      { id: 'from', label: 'Tool' },
      { id: 'to', label: 'Next tool' },
    ],
    nodes: [...nodes.values()],
    links,
  };
}
