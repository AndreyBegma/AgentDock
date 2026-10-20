'use client';

import type {
  AdminRunner,
  GitHubProjectAppStatus,
  OrchestratorSettingsView,
  ProjectDetail,
  ProjectSummary,
} from '@nautelle/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '../../components/shell/user-context';
import { api } from '../api';
import {
  type GitHubAppFact,
  gitHubAppFact,
  type Loadable,
  type ProfileFact,
  type ProjectRunnerFact,
  profileFact,
  projectRunnerFact,
  type RunnersFact,
  runnersFact,
} from './facts';

export interface PrerequisitesOptions {
  /** Load the runner fleet fact (admins only; others get `unknown`). */
  runners?: boolean;
  /** Load the project count. */
  projects?: boolean;
  /** Load the facts about this project. */
  projectId?: string;
  /** Reload this often while mounted, e.g. while waiting for a runner. */
  pollMs?: number;
}

export interface ProjectFacts {
  runner: Loadable<ProjectRunnerFact>;
  profile: Loadable<ProfileFact>;
  githubApp: Loadable<GitHubAppFact>;
}

export interface Prerequisites {
  runners: Loadable<RunnersFact>;
  projects: Loadable<{ count: number }>;
  /** Present when `projectId` was passed. */
  project: ProjectFacts | undefined;
  reload: () => void;
}

const LOADING = { state: 'loading' } as const;

/** One request as a `Loadable`; a later response replaces an earlier one. */
function useFact<T>(
  load: (() => Promise<T>) | null,
  key: string,
  tick: number,
): Loadable<T> {
  const [fact, setFact] = useState<Loadable<T>>(LOADING);
  const loadedKey = useRef(key);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `load` fetches
  useEffect(() => {
    // Another project's fact is not this one's: start over.
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      setFact(LOADING);
    }
    if (!load) return;
    let current = true;
    load().then(
      (value) => {
        if (current) setFact({ state: 'ready', value });
      },
      (error: unknown) => {
        // Keep a fact we already had: a failed refresh is not news.
        if (current) {
          setFact((previous) =>
            previous.state === 'ready' ? previous : { state: 'error', error },
          );
        }
      },
    );
    return () => {
      current = false;
    };
  }, [key, tick]);
  return fact;
}

/**
 * What a page depends on, read from existing endpoints (issue #132): whether
 * any runner can be reached, how many projects there are, and for one project
 * whether its runner is online, a runtime profile is set, and the GitHub App
 * covers it. Ask only for what the page shows — each is a request.
 */
export function usePrerequisites(
  options: PrerequisitesOptions = {},
): Prerequisites {
  const { runners = false, projects = false, projectId, pollMs } = options;
  const isAdmin = useCurrentUser().role === 'admin';
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(reload, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, reload]);

  const runnersLoaded = useFact(
    runners && isAdmin
      ? () => api<AdminRunner[]>('/admin/runners').then(runnersFact)
      : null,
    `runners:${runners && isAdmin}`,
    tick,
  );
  const projectsLoaded = useFact(
    projects
      ? () =>
          api<ProjectSummary[]>('/projects').then((list) => ({
            count: list.length,
          }))
      : null,
    `projects:${projects}`,
    tick,
  );
  const runner = useFact(
    projectId
      ? () =>
          api<ProjectDetail>(`/projects/${projectId}`).then(projectRunnerFact)
      : null,
    `runner:${projectId}`,
    tick,
  );
  const profile = useFact(
    projectId
      ? () =>
          api<OrchestratorSettingsView>(
            `/projects/${projectId}/orchestrator/settings`,
          ).then(profileFact)
      : null,
    `profile:${projectId}`,
    tick,
  );
  const githubApp = useFact(
    projectId
      ? () =>
          api<GitHubProjectAppStatus>(`/projects/${projectId}/github-app`).then(
            gitHubAppFact,
          )
      : null,
    `github:${projectId}`,
    tick,
  );

  return {
    runners:
      runners && !isAdmin
        ? { state: 'ready', value: { kind: 'unknown' } }
        : runnersLoaded,
    projects: projectsLoaded,
    project: projectId ? { runner, profile, githubApp } : undefined,
    reload,
  };
}
