import {
  WORKFLOW_OUTCOMES,
  type WorkflowsOrchestrationResponse,
  type WorkflowsSummaryResponse,
  type WorkflowsToolsResponse,
} from '@agentdock/shared';
import type { UsageRange } from '../usage/format';
import { formatFlow } from './format';

/* ── export: what is on screen, as a file ───────────────────────────── */

type Cell = string | number | null;

/**
 * One CSV field. Quoted when it carries a quote, comma or line break; text
 * that a spreadsheet would run as a formula gets a leading `'`, since tool
 * and type names come from agents.
 */
function csvField(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const toCsv = (rows: readonly (readonly Cell[])[]): string =>
  `${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;

export function summaryCsv(summary: WorkflowsSummaryResponse): string {
  return toCsv([
    ['metric', 'value'],
    ['sessions', summary.sessions],
    ['active', summary.active],
    ['ended', summary.ended],
    ...WORKFLOW_OUTCOMES.map((o): Cell[] => [
      `outcome_${o}`,
      summary.outcomes[o],
    ]),
    ['avg_depth', summary.avgDepth],
    ['avg_subagents', summary.avgSubagents],
    ['success_rate', summary.successRate],
    [
      'top_tool_flow',
      summary.topToolFlow ? formatFlow(summary.topToolFlow) : null,
    ],
    ['top_tool_flow_count', summary.topToolFlow?.count ?? null],
    ['avg_compactions', summary.avgCompactions],
    ['avg_duration_ms', summary.avgDurationMs],
    ['computed_at', summary.computedAt],
  ]);
}

export function orchestrationCsv(data: WorkflowsOrchestrationResponse): string {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const column = (id: string) => byId.get(id)?.column ?? '';
  const label = (id: string) => byId.get(id)?.label ?? id;
  return toCsv([
    ['source_column', 'source', 'target_column', 'target', 'sessions'],
    ...data.links.map((link): Cell[] => [
      column(link.source),
      label(link.source),
      column(link.target),
      label(link.target),
      link.value,
    ]),
  ]);
}

export function toolsCsv(data: WorkflowsToolsResponse): string {
  return toCsv([
    ['from', 'to', 'count', 'errors', 'error_share'],
    ...data.transitions.map((t): Cell[] => [
      t.from,
      t.to,
      t.count,
      t.errors,
      t.errorShare,
    ]),
  ]);
}

/** `workflows-tools-2026-10-07-to-2026-10-14.csv`: the range in the name. */
export function exportFileName(
  what: string,
  range: UsageRange,
  extension: 'csv' | 'json',
): string {
  const day = (iso: string) => iso.slice(0, 10);
  return `workflows-${what}-${day(range.from)}-to-${day(range.to)}.${extension}`;
}
