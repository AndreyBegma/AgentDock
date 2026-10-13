'use client';

import type {
  ProjectSummary,
  RunDetail,
  SessionDetail,
  SkillRunDetail,
} from '@agentdock/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { type CrumbNames, runLabel, sessionLabel } from './crumbs';

/** The detail page at `pathname`, if it is one whose name needs a GET. */
function detailOf(pathname: string): { id: string; path: string } | null {
  const skillRun = /^\/projects\/([^/]+)\/skills\/runs\/([^/]+)$/.exec(
    pathname,
  );
  if (skillRun) {
    return {
      id: skillRun[2] ?? '',
      path: `/projects/${skillRun[1]}/skill-runs/${skillRun[2]}`,
    };
  }
  const run = /^\/projects\/([^/]+)\/history\/([^/]+)$/.exec(pathname);
  if (run) {
    return {
      id: run[2] ?? '',
      path: `/projects/${run[1]}/runs/${run[2]}`,
    };
  }
  const session = /^\/sessions\/([^/]+)$/.exec(pathname);
  if (session) return { id: session[1] ?? '', path: `/sessions/${session[1]}` };
  return null;
}

type Detail = RunDetail | SessionDetail | SkillRunDetail;

function labelOf(detail: Detail): string {
  if ('session' in detail) return sessionLabel(detail.session);
  if ('skill' in detail) return detail.skill;
  return runLabel(detail);
}

/**
 * Names for the ids in the breadcrumb (#159): projects from the list the shell
 * already holds, and the run, skill run or session of a detail page from its
 * own GET. A failed GET leaves the id unnamed, and the trail shows its kind.
 */
export function useCrumbNames(
  pathname: string,
  projects: readonly ProjectSummary[],
): CrumbNames {
  const detail = detailOf(pathname);
  const detailPath = detail?.path ?? null;
  const [named, setNamed] = useState<{ id: string; label: string } | null>(
    null,
  );

  useEffect(() => {
    if (!detailPath) return;
    let cancelled = false;
    const id = detailOf(pathname)?.id ?? '';
    api<Detail>(detailPath)
      .then((value) => {
        if (!cancelled) setNamed({ id, label: labelOf(value) });
      })
      .catch(() => {
        // The trail keeps the kind ("Run"); the page says what went wrong.
      });
    return () => {
      cancelled = true;
    };
  }, [detailPath, pathname]);

  return useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects) names.set(project.id, project.displayName);
    if (named) names.set(named.id, named.label);
    return names;
  }, [projects, named]);
}
