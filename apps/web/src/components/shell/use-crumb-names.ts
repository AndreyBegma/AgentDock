'use client';

import type {
  PlanDetail,
  ProjectSummary,
  SessionDetail,
  SkillRunDetail,
} from '@nautelle/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { type CrumbNames, planLabel, sessionLabel } from './crumbs';

/**
 * A segment of the pathname as it goes into an API path: decoded once, then
 * encoded, so `a%2F..%2Fb` stays one segment; null when it does not decode
 * (C-165).
 */
function apiSegment(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return encodeURIComponent(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/** The GET for `id` at `path`, or null when a segment does not decode. */
function detail(
  id: string | undefined,
  build: (...segments: string[]) => string,
  ...raw: (string | undefined)[]
): { id: string; path: string } | null {
  const segments = raw.map(apiSegment);
  if (segments.some((s) => s === null)) return null;
  return { id: id ?? '', path: build(...(segments as string[])) };
}

/** The detail page at `pathname`, if it is one whose name needs a GET. */
export function detailOf(
  pathname: string,
): { id: string; path: string } | null {
  const skillRun = /^\/projects\/([^/]+)\/skills\/runs\/([^/]+)$/.exec(
    pathname,
  );
  if (skillRun) {
    return detail(
      skillRun[2],
      (project, run) => `/projects/${project}/skill-runs/${run}`,
      skillRun[1],
      skillRun[2],
    );
  }
  const plan = /^\/projects\/([^/]+)\/planner\/([^/]+)$/.exec(pathname);
  if (plan) {
    return detail(
      plan[2],
      (project, id) => `/projects/${project}/plans/${id}`,
      plan[1],
      plan[2],
    );
  }
  const session = /^\/sessions\/([^/]+)$/.exec(pathname);
  if (session) {
    return detail(session[1], (id) => `/sessions/${id}`, session[1]);
  }
  return null;
}

type Detail = SessionDetail | SkillRunDetail | PlanDetail;

function labelOf(detail: Detail): string {
  if ('session' in detail) return sessionLabel(detail.session);
  if ('skill' in detail) return detail.skill;
  return planLabel(detail);
}

/**
 * Names for the ids in the breadcrumb (#159): projects from the list the shell
 * already holds, and the skill run, plan or session of a detail page from its
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
        // The trail keeps the kind ("Session"); the page says what went wrong.
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
