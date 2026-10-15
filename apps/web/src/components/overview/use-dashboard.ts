'use client';

import type {
  ActivityPage,
  ApprovalsView,
  FleetView,
  OrchestratorSettingsView,
  ProjectSummary,
  RunPage,
  RunSummary,
  TerminalSetupView,
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
/** The newest failed runs per project; "Needs you" shows the last 24 h of them. */
const FAILED_RUNS_LIMIT = 20;

export interface ProjectFacts {
  fleets: Map<string, FleetView>;
  approvals: Map<string, ApprovalsView>;
  /** Each project's latest failed runs; "Needs you" keeps the last 24 h. */
  failedRuns: Map<string, RunSummary[]>;
  /** Projects whose orchestrator has no profile, its own or the default. */
  missingProfile: Set<string>;
  /**
   * Each operator-or-up project's "Terminal → Board" checklist (#281). A
   * project whose checklist did not answer is absent — an API that predates the
   * endpoint must not read as a problem, so it is not in `failed`.
   */
  terminalSetup: Map<string, TerminalSetupView>;
  /** Projects where any of these did not answer — never shown as zero. */
  failed: ProjectSummary[];
}

/**
 * Every project's fleet, approvals, failed runs and orchestrator settings.
 * One project failing does not fail the rest: its id goes in `failed` and the
 * page says so beside the figures.
 */
async function loadProjectFacts(
  projects: ProjectSummary[],
): Promise<ProjectFacts> {
  const results = await Promise.all(
    projects.map(async (project) => {
      const base = `/projects/${project.id}`;
      const [fleet, approvals, runs, settings, setup] =
        await Promise.allSettled([
          api<FleetView>(`${base}/fleet`),
          api<ApprovalsView>(`${base}/approvals`),
          api<RunPage>(`${base}/runs?status=failed&limit=${FAILED_RUNS_LIMIT}`),
          api<OrchestratorSettingsView>(`${base}/orchestrator/settings`),
          project.role === 'viewer'
            ? Promise.reject(new Error('viewer'))
            : api<TerminalSetupView>(`${base}/terminal-setup`),
        ]);
      return { project, fleet, approvals, runs, settings, setup };
    }),
  );
  const facts: ProjectFacts = {
    fleets: new Map(),
    approvals: new Map(),
    failedRuns: new Map(),
    missingProfile: new Set(),
    terminalSetup: new Map(),
    failed: [],
  };
  for (const { project, fleet, approvals, runs, settings, setup } of results) {
    if (setup.status === 'fulfilled') {
      facts.terminalSetup.set(project.id, setup.value);
    }
    if (fleet.status === 'fulfilled') facts.fleets.set(project.id, fleet.value);
    if (approvals.status === 'fulfilled') {
      facts.approvals.set(project.id, approvals.value);
    }
    if (runs.status === 'fulfilled') {
      facts.failedRuns.set(project.id, runs.value.items);
    }
    if (
      settings.status === 'fulfilled' &&
      settings.value.effectiveProfile === null
    ) {
      facts.missingProfile.add(project.id);
    }
    if (
      fleet.status === 'rejected' ||
      approvals.status === 'rejected' ||
      runs.status === 'rejected' ||
      settings.status === 'rejected'
    ) {
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
