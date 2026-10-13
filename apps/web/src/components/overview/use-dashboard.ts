'use client';

import type {
  ActivityPage,
  ApprovalsView,
  FleetView,
  ProjectSummary,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import { useEffect } from 'react';
import { api } from '../../lib/api';
import {
  lastSevenDays,
  nextHour,
  startOfToday,
} from '../../lib/overview/dashboard';
import { type Section, useSection } from '../../lib/section/use-section';
import { browserZone } from '../../lib/usage/format';

/** The dashboard is a glance, not a live view: look again twice a minute. */
const REFRESH_MS = 30_000;
const RECENT_LIMIT = 8;
/** Merges in one day across every project; more than this is not a glance. */
const MERGED_LIMIT = 200;

export interface ProjectFacts {
  fleets: Map<string, FleetView>;
  approvals: Map<string, ApprovalsView>;
  /** Projects whose fleet or approvals did not answer — never shown as zero. */
  failed: ProjectSummary[];
}

/**
 * Every project's fleet and approvals. One project failing does not fail the
 * rest: its id goes in `failed` and the page says so beside the figures.
 */
async function loadProjectFacts(
  projects: ProjectSummary[],
): Promise<ProjectFacts> {
  const results = await Promise.all(
    projects.map(async (project) => {
      const [fleet, approvals] = await Promise.allSettled([
        api<FleetView>(`/projects/${project.id}/fleet`),
        api<ApprovalsView>(`/projects/${project.id}/approvals`),
      ]);
      return { project, fleet, approvals };
    }),
  );
  const facts: ProjectFacts = {
    fleets: new Map(),
    approvals: new Map(),
    failed: [],
  };
  for (const { project, fleet, approvals } of results) {
    if (fleet.status === 'fulfilled') facts.fleets.set(project.id, fleet.value);
    if (approvals.status === 'fulfilled') {
      facts.approvals.set(project.id, approvals.value);
    }
    if (fleet.status === 'rejected' || approvals.status === 'rejected') {
      facts.failed.push(project);
    }
  }
  return facts;
}

export interface Dashboard {
  facts: Section<ProjectFacts>;
  costToday: Section<UsageSummaryResponse>;
  cost7d: Section<UsageTimeseriesResponse>;
  merged: Section<ActivityPage>;
  recent: Section<ActivityPage>;
}

/** The dashboard's sections, each loading and failing on its own. */
export function useDashboard(projects: ProjectSummary[]): Dashboard {
  // The project list is refetched as a new array; load again only when it changes.
  const ids = projects.map((p) => p.id).join(',');
  const facts = useSection(() => loadProjectFacts(projects), [ids]);
  const costToday = useSection(() => {
    const query = new URLSearchParams({
      from: startOfToday(),
      to: nextHour(),
    });
    return api<UsageSummaryResponse>(`/usage/summary?${query}`);
  }, []);
  const cost7d = useSection(() => {
    const { from, to } = lastSevenDays();
    const query = new URLSearchParams({
      from,
      to,
      interval: 'day',
      groupBy: 'project',
      tz: browserZone(),
    });
    return api<UsageTimeseriesResponse>(`/usage/timeseries?${query}`);
  }, []);
  const merged = useSection(() => {
    const query = new URLSearchParams({
      type: 'pr.merged',
      from: startOfToday(),
      limit: String(MERGED_LIMIT),
    });
    return api<ActivityPage>(`/activity?${query}`);
  }, []);
  const recent = useSection(
    () => api<ActivityPage>(`/activity?limit=${RECENT_LIMIT}`),
    [],
  );

  const retries = [
    facts.retry,
    costToday.retry,
    cost7d.retry,
    merged.retry,
    recent.retry,
  ];
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry callbacks are stable
  useEffect(() => {
    const timer = setInterval(() => {
      for (const retry of retries) retry();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return { facts, costToday, cost7d, merged, recent };
}
