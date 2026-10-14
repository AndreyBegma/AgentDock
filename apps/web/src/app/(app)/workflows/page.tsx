'use client';

import {
  type ProjectRuntimeProfile,
  type ProjectSummary,
  WORKFLOW_FRESHNESS_MS,
  WORKFLOW_TOOLS_DEFAULT_LIMIT,
  type WorkflowsOrchestrationResponse,
  type WorkflowsSummaryResponse,
  type WorkflowsToolsResponse,
} from '@agentdock/shared';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { canSee } from '../../../components/shell/nav';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api } from '../../../lib/api';
import { type Section, useSection } from '../../../lib/section/use-section';
import {
  applyNodeFilter,
  clearNodeFilters,
  describeWorkflowsError,
  type WorkflowsFilters as Filters,
  filtersFromSearch,
  filtersSearch,
  hasNodeFilters,
  isWorkflowsNotFound,
  rangeOf,
  workflowsQuery,
} from '../../../lib/workflows/format';
import { OrchestrationCard } from './orchestration-card';
import { ToolFlowCard } from './tool-flow-card';
import { WorkflowTiles } from './workflow-tiles';
import { NodeFilterChips, WorkflowsFilters } from './workflows-filters';
import { WorkflowsHeader } from './workflows-header';

/**
 * A preset range moves with the clock, and the API's figures are at most
 * `WORKFLOW_FRESHNESS_MS` old: polling faster would only re-read its cache.
 */
const POLL_MS = WORKFLOW_FRESHNESS_MS;

/** While the tab is visible, a counter that moves every `POLL_MS`. */
function usePollTick(): [number, () => void] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return [tick, () => setTick((n) => n + 1)];
}

function Unavailable({
  section,
  title,
}: {
  section: Pick<Section<unknown>, 'error' | 'loading' | 'retry'>;
  title: string;
}) {
  if (section.error === null || section.loading) return null;
  return (
    <div className="mb-3">
      <SectionUnavailable
        title={title}
        stillWorks={`${describeWorkflowsError(section.error)} The filters above still work.`}
        action={
          <Button variant="glass" size="sm" onClick={section.retry}>
            Try again
          </Button>
        }
      />
    </div>
  );
}

/**
 * Nothing in scope, worded by what narrowed it: the graph filters first,
 * then the project, then the status — "nothing here" is never "nothing yet".
 */
function WorkflowsEmpty({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  if (hasNodeFilters(filters)) {
    return (
      <EmptyState
        title="No sessions match the graph filters"
        description="Nothing in this range took that path."
        action={
          <Button
            variant="glass"
            onClick={() => onChange(clearNodeFilters(filters))}
          >
            Clear graph filters
          </Button>
        }
      />
    );
  }
  if (filters.projectId || filters.profileKey) {
    return (
      <EmptyState
        title="No sessions for this project in this range"
        description="Try a longer range, or look at all your projects."
        action={
          <Button
            variant="glass"
            onClick={() =>
              onChange({ ...filters, projectId: '', profileKey: '' })
            }
          >
            Show all projects
          </Button>
        }
      />
    );
  }
  if (filters.status !== 'all') {
    return (
      <EmptyState
        title={
          filters.status === 'active'
            ? 'No session is active right now'
            : 'No session has ended in this range'
        }
        description="A session is active while it had an event in the last 30 minutes."
        action={
          <Button
            variant="glass"
            onClick={() => onChange({ ...filters, status: 'all' })}
          >
            Show all sessions
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      title="No sessions in this range"
      description="A session appears here once an agent runs on a paired runner. Try a longer range."
      action={
        <Link
          href="/sessions"
          className={buttonClassName({ variant: 'glass' })}
        >
          Open Sessions
        </Link>
      }
    />
  );
}

function WorkflowsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const user = useCurrentUser();
  // The URL holds the filters: reload, back and a shared link all keep them.
  const filters = useMemo(
    () => filtersFromSearch(new URLSearchParams(params.toString())),
    [params],
  );
  const apply = (next: Filters) =>
    router.replace(`${pathname}${filtersSearch(next)}`, { scroll: false });

  const [tick, refresh] = usePollTick();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` moves a preset range with the clock
  const range = useMemo(() => rangeOf(filters), [filters, tick]);
  const query = range ? workflowsQuery(filters, range) : '';

  const summary = useSection<WorkflowsSummaryResponse | null>(
    () =>
      query
        ? api<WorkflowsSummaryResponse>(`/workflows/summary${query}`)
        : Promise.resolve(null),
    [query, tick],
  );
  const orchestration = useSection<WorkflowsOrchestrationResponse | null>(
    () =>
      query
        ? api<WorkflowsOrchestrationResponse>(
            `/workflows/orchestration${query}`,
          )
        : Promise.resolve(null),
    [query, tick],
  );
  const tools = useSection<WorkflowsToolsResponse | null>(
    () =>
      range
        ? api<WorkflowsToolsResponse>(
            `/workflows/tools${workflowsQuery(filters, range, { limit: WORKFLOW_TOOLS_DEFAULT_LIMIT })}`,
          )
        : Promise.resolve(null),
    [query, tick],
  );

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter stays on "all"; the page still works.
      });
  }, []);

  // `GET /projects/:id/runtime-profiles` is operator+: a viewer gets no select.
  const offerProfiles =
    canSee(user.role, 'operator') && filters.projectId !== '';
  const [profiles, setProfiles] = useState<ProjectRuntimeProfile[] | null>(
    null,
  );
  useEffect(() => {
    setProfiles(null);
    if (!offerProfiles) return;
    let current = true;
    api<ProjectRuntimeProfile[]>(
      `/projects/${encodeURIComponent(filters.projectId)}/runtime-profiles`,
    )
      .then((list) => {
        if (current && Array.isArray(list)) setProfiles(list);
      })
      .catch(() => {
        // No select: a profile from the URL still shows as a chip.
      });
    return () => {
      current = false;
    };
  }, [offerProfiles, filters.projectId]);

  const sections = [summary, orchestration, tools];
  const notFound = sections.some((s) => isWorkflowsNotFound(s.error));
  const failed = sections.some((s) => s.error !== null);
  const loading = sections.some((s) => s.loading);
  const data = {
    summary: summary.data ?? undefined,
    orchestration: orchestration.data ?? undefined,
    tools: tools.data ?? undefined,
  };

  const onNodeFilter = (nodeId: string) => {
    const node = data.orchestration?.nodes.find((n) => n.id === nodeId);
    if (node) apply(applyNodeFilter(filters, node));
  };

  const empty = <WorkflowsEmpty filters={filters} onChange={apply} />;
  // Either count will do: the graph's can be missing when its route failed.
  const noSessions =
    (data.orchestration?.sessions ?? data.summary?.sessions) === 0;

  return (
    <>
      <WorkflowsHeader
        status={filters.status}
        onStatus={(status) => apply({ ...filters, status })}
        data={data}
        range={range}
        query={query}
        live={range !== null && !failed && data.summary !== undefined}
        refreshing={loading}
        onRefresh={refresh}
      />

      <div className="mb-4">
        <WorkflowsFilters
          filters={filters}
          onChange={apply}
          projects={projects}
          profiles={profiles}
        />
      </div>

      <NodeFilterChips
        filters={filters}
        onChange={apply}
        showProfile={filters.profileKey !== '' && profiles === null}
      />

      {!range ? (
        <EmptyState
          title="Pick a range"
          description="Choose a first and a last day."
        />
      ) : notFound ? (
        <EmptyState
          title="Project not found"
          description="It does not exist, or you are not a member of it."
          action={
            <Button
              variant="glass"
              onClick={() =>
                apply({ ...filters, projectId: '', profileKey: '' })
              }
            >
              Show all projects
            </Button>
          }
        />
      ) : (
        <>
          <Unavailable
            section={summary}
            title="The workflow summary is not answering"
          />
          <WorkflowTiles summary={data.summary} />
          <OrchestrationCard
            data={data.orchestration}
            busy={orchestration.loading}
            unavailable={
              <Unavailable
                section={orchestration}
                title="The orchestration graph is not answering"
              />
            }
            hasError={orchestration.error !== null && !orchestration.loading}
            empty={empty}
            onNodeFilter={onNodeFilter}
          />
          {/* No session in scope is said once, above; a second empty
              state under it would only repeat it. */}
          {noSessions ? null : (
            <ToolFlowCard
              data={data.tools}
              busy={tools.loading}
              unavailable={
                <Unavailable
                  section={tools}
                  title="The tool flow is not answering"
                />
              }
              hasError={tools.error !== null && !tools.loading}
              empty={
                <EmptyState
                  title="No tool calls in these sessions"
                  description="Tool transitions are read from Claude Code transcripts; Codex sessions are not read yet."
                />
              }
            />
          )}
        </>
      )}
    </>
  );
}

export default function WorkflowsPage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <WorkflowsView />
    </Suspense>
  );
}
