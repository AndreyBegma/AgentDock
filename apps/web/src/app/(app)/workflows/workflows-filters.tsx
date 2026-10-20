'use client';

import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { Select } from '@andrewbehma/glass-ui/field';
import { SegmentedControl } from '@andrewbehma/glass-ui/segmented-control';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import type { ProjectRuntimeProfile, ProjectSummary } from '@nautelle/shared';
import { useMemo } from 'react';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import {
  type UrlFilters,
  useFilterChips,
} from '../../../lib/filters/use-url-filters';
import { RANGE_PRESETS, type RangePreset } from '../../../lib/usage/format';
import {
  type WorkflowsFilters as Filters,
  workflowsChipDefs,
} from '../../../lib/workflows/format';
import { Segment } from './segment';

const PRESET_LABEL: Record<RangePreset, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  custom: 'Custom',
};

/**
 * The canonical filter bar (#213): the range as a view, project and runtime
 * profile as instant selects, custom days when the range is Custom, and
 * every filter in force — the graph's included — as a removable chip.
 */
export function WorkflowsFilters({
  url,
  projects,
  profiles,
}: {
  url: UrlFilters<Filters>;
  projects: ProjectSummary[];
  /**
   * The chosen project's runtime profiles; null when the select is not
   * offered (no project, or a viewer — the route is operator+).
   */
  profiles: ProjectRuntimeProfile[] | null;
}) {
  const { filters, set } = url;
  const defs = useMemo(() => {
    const projectNames = new Map(projects.map((p) => [p.id, p.displayName]));
    const profileNames = new Map((profiles ?? []).map((p) => [p.key, p.label]));
    return workflowsChipDefs({
      project: (id) => projectNames.get(id) ?? id,
      profile: (key) => profileNames.get(key) ?? key,
    });
  }, [projects, profiles]);
  const chips = useFilterChips(url, defs);

  const range = (size: 'sm' | 'md') => (
    <SegmentedControl size={size} aria-label="Time range">
      {RANGE_PRESETS.map((p) => (
        <Segment
          key={p}
          layoutId={`workflows-range-${size}`}
          size={size}
          active={filters.range === p}
          onSelect={() => set({ range: p })}
        >
          {PRESET_LABEL[p]}
        </Segment>
      ))}
    </SegmentedControl>
  );

  return (
    <>
      {/* A phone gives the ranges a row of their own, tap-sized, as Usage. */}
      <div className="mb-3 sm:hidden">
        <ScrollX>{range('md')}</ScrollX>
      </div>
      <Toolbar
        aria-label="Filter workflows"
        collapseBelow="sm"
        activeFilters={chips.activeFilters}
        onClearAll={chips.onClearAll}
        views={<div className="hidden sm:block">{range('sm')}</div>}
        filters={
          <>
            <Select
              aria-label="Project"
              value={filters.projectId}
              className="w-full sm:w-48"
              // A profile key belongs to one project's runner: a new project drops it.
              onChange={(e) =>
                set({ projectId: e.target.value, profileKey: '' })
              }
            >
              <option value="">All my projects</option>
              {filters.projectId &&
              !projects.some((p) => p.id === filters.projectId) ? (
                <option value={filters.projectId}>{filters.projectId}</option>
              ) : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.displayName}
                </option>
              ))}
            </Select>
            {profiles ? (
              <Select
                aria-label="Runtime profile"
                value={filters.profileKey}
                className="w-full sm:w-44"
                onChange={(e) => set({ profileKey: e.target.value })}
              >
                <option value="">Every profile</option>
                {filters.profileKey &&
                !profiles.some((p) => p.key === filters.profileKey) ? (
                  <option value={filters.profileKey}>
                    {filters.profileKey}
                  </option>
                ) : null}
                {profiles.map((profile) => (
                  <option key={profile.key} value={profile.key}>
                    {profile.label}
                  </option>
                ))}
              </Select>
            ) : null}
            {filters.range === 'custom' ? (
              <>
                <DateInput
                  aria-label="From"
                  value={filters.fromDate}
                  max={filters.toDate || undefined}
                  className="w-full sm:w-40"
                  onChange={(e) => set({ fromDate: e.target.value })}
                />
                <DateInput
                  aria-label="To (inclusive)"
                  value={filters.toDate}
                  min={filters.fromDate || undefined}
                  className="w-full sm:w-40"
                  onChange={(e) => set({ toDate: e.target.value })}
                />
              </>
            ) : null}
          </>
        }
      />
    </>
  );
}
