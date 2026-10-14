'use client';

import { PLAN_TASK_KINDS, type ProjectSummary } from '@agentdock/shared';
import { SearchField, Select } from '@andrewbehma/glass-ui/field';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { useMemo } from 'react';
import {
  type UrlFilters,
  useFilterChips,
  useSearchDraft,
} from '../../../lib/filters/use-url-filters';
import {
  TASK_KIND_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  type TaskFilters,
  taskChipDefs,
} from '../../../lib/tasks/format';

/**
 * The filters of `/tasks` — the canonical bar (#213): a search that applies
 * when typing pauses, three instant selects, the filters in force as chips.
 * Below `sm` they fold into "Filters (n)" and a sheet.
 */
export function TasksFilters({
  url,
  projects,
}: {
  url: UrlFilters<TaskFilters>;
  projects: ProjectSummary[];
}) {
  const { filters, set } = url;
  const search = useSearchDraft(filters.q, (q) => set({ q }));
  const defs = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.displayName]));
    return taskChipDefs((id) => names.get(id) ?? 'another project');
  }, [projects]);
  const chips = useFilterChips(url, defs);

  return (
    <Toolbar
      aria-label="Filter tasks"
      collapseBelow="sm"
      activeFilters={chips.activeFilters}
      onClearAll={chips.onClearAll}
      filters={
        <>
          <SearchField
            aria-label="Search tasks"
            value={search.draft}
            maxLength={200}
            placeholder="Title or key"
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
            aria-label="Kind"
            value={filters.kind}
            className="w-full sm:w-36"
            onChange={(e) =>
              set({ kind: e.target.value as TaskFilters['kind'] })
            }
          >
            <option value="">Any kind</option>
            {PLAN_TASK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TASK_KIND_LABEL[kind]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status"
            value={filters.status}
            className="w-full sm:w-40"
            onChange={(e) =>
              set({ status: e.target.value as TaskFilters['status'] })
            }
          >
            <option value="">Any status</option>
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {TASK_STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </>
      }
    />
  );
}
