'use client';

import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { Select } from '@andrewbehma/glass-ui/field';
import { SegmentedControl } from '@andrewbehma/glass-ui/segmented-control';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import type { ProjectSummary } from '@nautelle/shared';
import { useMemo } from 'react';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import {
  type UrlFilters,
  useFilterChips,
} from '../../../lib/filters/use-url-filters';
import {
  type UsageFilters as Filters,
  USAGE_PRESET_LABEL,
  USAGE_PRESETS,
  usageChipDefs,
} from '../../../lib/usage/filters';
import { timeZones } from '../../../lib/usage/format';
import { Segment } from '../workflows/segment';

/**
 * Usage's filter bar — the canonical one (#213): the range as a view, the
 * project and time zone as instant selects, custom days when the range is
 * Custom, the filters in force as chips. Everything is in the URL.
 */
export function UsageFilters({
  url,
  projects,
  zone,
}: {
  url: UrlFilters<Filters>;
  projects: ProjectSummary[];
  /** The zone in force: the URL's, else the viewer's own. */
  zone: string;
}) {
  const { filters, set } = url;
  const zones = useMemo(() => timeZones(), []);
  const defs = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.displayName]));
    return usageChipDefs((id) => names.get(id) ?? id);
  }, [projects]);
  const chips = useFilterChips(url, defs);

  const range = (size: 'sm' | 'md') => (
    <SegmentedControl size={size} aria-label="Time range">
      {USAGE_PRESETS.map((p) => (
        <Segment
          key={p}
          layoutId={`usage-range-${size}`}
          size={size}
          active={filters.range === p}
          onSelect={() => set({ range: p })}
        >
          {USAGE_PRESET_LABEL[p]}
        </Segment>
      ))}
    </SegmentedControl>
  );

  return (
    <>
      {/* A phone gives the five ranges a row of their own, tap-sized; in
          the bar they would push "Filters" out of reach. */}
      <div className="mb-3 sm:hidden">
        <ScrollX>{range('md')}</ScrollX>
      </div>
      <Toolbar
        aria-label="Filter usage"
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
              onChange={(e) => set({ projectId: e.target.value })}
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
            <Select
              aria-label="Time zone"
              value={zone}
              className="w-full sm:w-48"
              onChange={(e) => set({ tz: e.target.value })}
            >
              {zones.includes(zone) ? null : (
                <option value={zone}>{zone}</option>
              )}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
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
