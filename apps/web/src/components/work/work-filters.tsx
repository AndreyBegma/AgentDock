'use client';

import {
  type ProjectSummary,
  WORK_QUERY_TEXT_MAX,
  WORK_SOURCES,
  WORK_STATUSES,
} from '@agentdock/shared';
import { SearchField, Select } from '@andrewbehma/glass-ui/field';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { useMemo } from 'react';
import {
  type UrlFilters,
  useFilterChips,
  useSearchDraft,
} from '../../lib/filters/use-url-filters';
import {
  type WorkFilters as Filters,
  WORK_KIND_LABEL,
  WORK_SOURCE_LABEL,
  WORK_STATUS_LABEL,
  workChipDefs,
} from '../../lib/work/format';

/**
 * The filters of `/work` — the canonical bar (#213): a search that applies
 * when typing pauses, four instant selects, the filters in force as chips.
 * Below `sm` they fold into "Filters (n)" and a sheet.
 */
export function WorkFilters({
  url,
  projects,
}: {
  url: UrlFilters<Filters>;
  projects: ProjectSummary[];
}) {
  const { filters, set } = url;
  const search = useSearchDraft(filters.q, (q) => set({ q }));
  const defs = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.displayName]));
    return workChipDefs((id) => names.get(id) ?? 'another project');
  }, [projects]);
  const chips = useFilterChips(url, defs);

  return (
    <Toolbar
      aria-label="Filter work"
      collapseBelow="sm"
      activeFilters={chips.activeFilters}
      onClearAll={chips.onClearAll}
      filters={
        <>
          <SearchField
            aria-label="Search work"
            value={search.draft}
            maxLength={WORK_QUERY_TEXT_MAX}
            placeholder="Title, C-12, t3 or #12"
            className="w-full sm:w-52"
            onChange={(e) => search.setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search.flush();
            }}
          />
          <Select
            aria-label="Project"
            value={filters.projectId}
            className="w-full sm:w-44"
            onChange={(e) => set({ projectId: e.target.value })}
          >
            <option value="">All my projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.displayName}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Source"
            value={filters.source}
            className="w-full sm:w-36"
            onChange={(e) =>
              set({ source: e.target.value as Filters['source'] })
            }
          >
            <option value="">Any source</option>
            {WORK_SOURCES.map((source) => (
              <option key={source} value={source}>
                {WORK_SOURCE_LABEL[source]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Kind"
            value={filters.kind}
            className="w-full sm:w-36"
            onChange={(e) => set({ kind: e.target.value as Filters['kind'] })}
          >
            <option value="">Any kind</option>
            {(
              Object.keys(WORK_KIND_LABEL) as Array<
                keyof typeof WORK_KIND_LABEL
              >
            ).map((kind) => (
              <option key={kind} value={kind}>
                {WORK_KIND_LABEL[kind]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status"
            value={filters.status}
            className="w-full sm:w-40"
            onChange={(e) =>
              set({ status: e.target.value as Filters['status'] })
            }
          >
            <option value="">Any status</option>
            {WORK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {WORK_STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </>
      }
    />
  );
}
