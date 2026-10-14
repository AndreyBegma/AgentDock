'use client';

import {
  WORKFLOW_STATUSES,
  type WorkflowStatus,
  type WorkflowsOrchestrationResponse,
  type WorkflowsSummaryResponse,
  type WorkflowsToolsResponse,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { MetaBar, type MetaBarCounter } from '@andrewbehma/glass-ui/meta-bar';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { SegmentedControl } from '@andrewbehma/glass-ui/segmented-control';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { Download, RefreshCw } from 'lucide-react';
import { formatNumber } from '../../../lib/format';
import type { UsageRange } from '../../../lib/usage/format';
import {
  exportFileName,
  orchestrationCsv,
  summaryCsv,
  toolsCsv,
} from '../../../lib/workflows/export';
import { formatUpdatedAt, STATUS_LABEL } from '../../../lib/workflows/format';
import { Segment } from './segment';

export interface WorkflowsData {
  summary?: WorkflowsSummaryResponse;
  orchestration?: WorkflowsOrchestrationResponse;
  tools?: WorkflowsToolsResponse;
}

/** Hands the browser a file built from what is on screen. */
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const CSV = 'text/csv;charset=utf-8';

function ExportMenu({
  data,
  range,
  query,
}: {
  data: WorkflowsData;
  range: UsageRange | null;
  /** The API query the data answers, kept in the JSON for the record. */
  query: string;
}) {
  const { summary, orchestration, tools } = data;
  const ready = range !== null && (summary || orchestration || tools);
  return (
    <MenuRoot>
      <Tooltip content="Export what is on screen">
        <MenuTrigger asChild>
          <Button variant="ghost" icon aria-label="Export" disabled={!ready}>
            <Download aria-hidden="true" className="size-4" />
          </Button>
        </MenuTrigger>
      </Tooltip>
      {range ? (
        <MenuContent align="end">
          <MenuItem
            disabled={!summary}
            onSelect={() =>
              summary &&
              download(
                exportFileName('summary', range, 'csv'),
                summaryCsv(summary),
                CSV,
              )
            }
          >
            Summary (CSV)
          </MenuItem>
          <MenuItem
            disabled={!orchestration}
            onSelect={() =>
              orchestration &&
              download(
                exportFileName('orchestration', range, 'csv'),
                orchestrationCsv(orchestration),
                CSV,
              )
            }
          >
            Orchestration links (CSV)
          </MenuItem>
          <MenuItem
            disabled={!tools}
            onSelect={() =>
              tools &&
              download(
                exportFileName('tools', range, 'csv'),
                toolsCsv(tools),
                CSV,
              )
            }
          >
            Tool transitions (CSV)
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() =>
              download(
                exportFileName('all', range, 'json'),
                `${JSON.stringify(
                  {
                    query: Object.fromEntries(new URLSearchParams(query)),
                    summary: summary ?? null,
                    orchestration: orchestration ?? null,
                    tools: tools ?? null,
                  },
                  null,
                  2,
                )}\n`,
                'application/json',
              )
            }
          >
            Everything (JSON)
          </MenuItem>
        </MenuContent>
      ) : null}
    </MenuRoot>
  );
}

/** All sessions · Active only · Ended. */
function StatusSegment({
  status,
  onStatus,
}: {
  status: WorkflowStatus;
  onStatus: (status: WorkflowStatus) => void;
}) {
  return (
    <SegmentedControl aria-label="Sessions">
      {WORKFLOW_STATUSES.map((s) => (
        <Segment
          key={s}
          layoutId="workflows-status"
          active={status === s}
          onSelect={() => onStatus(s)}
        >
          {STATUS_LABEL[s]}
        </Segment>
      ))}
    </SegmentedControl>
  );
}

/**
 * The page's one header (#213): glass-ui `PageHeader` with the counters in
 * `meta`. Live is the top bar's dot; the page says so only when it is *not*
 * updating. Below `sm` the actions wrap under the title at full width.
 */
export function WorkflowsHeader({
  status,
  onStatus,
  data,
  range,
  query,
  stale,
  refreshing,
  onRefresh,
}: {
  status: WorkflowStatus;
  onStatus: (status: WorkflowStatus) => void;
  data: WorkflowsData;
  range: UsageRange | null;
  query: string;
  /** A section's last load failed: the figures on screen are not moving. */
  stale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { summary } = data;
  const counters: MetaBarCounter[] = summary
    ? [
        {
          id: 'sessions',
          value: formatNumber(summary.sessions),
          label: 'Sessions',
        },
        {
          id: 'active',
          value: formatNumber(summary.active),
          label: 'Active',
          tone: summary.active > 0 ? 'running' : undefined,
        },
        { id: 'ended', value: formatNumber(summary.ended), label: 'Ended' },
      ]
    : [];
  return (
    <PageHeader
      className="mb-6"
      title="Workflows"
      description="How agents work across sessions — Usage says what they cost."
      status={
        stale && summary ? (
          <StatusPill status="paused" label="Not updating" />
        ) : undefined
      }
      meta={counters.length > 0 ? <MetaBar counters={counters} /> : undefined}
      actions={
        <>
          <StatusSegment status={status} onStatus={onStatus} />
          <div className="flex items-center gap-1">
            <Tooltip content={refreshing ? 'Loading…' : 'Refresh'}>
              <Button
                variant="ghost"
                icon
                aria-label="Refresh"
                disabled={refreshing}
                onClick={onRefresh}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={`size-4 ${refreshing ? 'animate-spin' : ''}`}
                />
              </Button>
            </Tooltip>
            <ExportMenu data={data} range={range} query={query} />
            {summary ? (
              <span className="num ml-1 text-xs text-ink-3" role="status">
                Updated {formatUpdatedAt(summary.computedAt)}
              </span>
            ) : null}
          </div>
        </>
      }
    />
  );
}
