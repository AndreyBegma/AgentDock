'use client';

import { PLAN_TASK_KINDS, type ProjectSummary } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Field, SearchField, Select } from '@andrewbehma/glass-ui/field';
import { SlidersHorizontal } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import {
  hasTaskFilters,
  TASK_KIND_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  type TaskFilters,
  taskFilterCount,
} from '../../../lib/tasks/format';

/**
 * The filters of `/tasks`. Selects apply at once; the search applies on
 * Enter. A phone gets one "Filters" button that opens the bar (390 px).
 */
export function TasksFilters({
  filters,
  projects,
  onChange,
  onReset,
}: {
  filters: TaskFilters;
  projects: ProjectSummary[];
  onChange: (patch: Partial<TaskFilters>) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(filters.q);
  // The URL is the truth: a back navigation or a reset rewrites the field.
  useEffect(() => setQ(filters.q), [filters.q]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onChange({ q: q.trim() });
    setOpen(false);
  };
  const count = taskFilterCount(filters);

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="glass"
        size="sm"
        className="self-start sm:hidden"
        aria-expanded={open}
        aria-controls="tasks-filters"
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontal aria-hidden="true" className="size-4" />
        Filters
        {count > 0 ? <Badge tone="neutral" label={String(count)} /> : null}
      </Button>
      <form
        id="tasks-filters"
        onSubmit={submit}
        className={`${open ? 'flex' : 'hidden'} flex-col gap-3 sm:flex`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end [&>*]:min-w-0 sm:[&>*]:flex-[1_1_10rem]">
          <Field label="Search" htmlFor="tasks-q">
            <SearchField
              id="tasks-q"
              value={q}
              maxLength={200}
              placeholder="Title or key"
              onChange={(e) => setQ(e.target.value)}
            />
          </Field>
          <Field label="Project" htmlFor="tasks-project">
            <Select
              id="tasks-project"
              value={filters.projectId}
              onChange={(e) => onChange({ projectId: e.target.value })}
            >
              <option value="">All my projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Kind" htmlFor="tasks-kind">
            <Select
              id="tasks-kind"
              value={filters.kind}
              onChange={(e) =>
                onChange({ kind: e.target.value as TaskFilters['kind'] })
              }
            >
              <option value="">Any kind</option>
              {PLAN_TASK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {TASK_KIND_LABEL[kind]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="tasks-status">
            <Select
              id="tasks-status"
              value={filters.status}
              onChange={(e) =>
                onChange({ status: e.target.value as TaskFilters['status'] })
              }
            >
              <option value="">Any status</option>
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABEL[status]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:flex-none">
            <Button variant="solid" type="submit">
              Search
            </Button>
            {hasTaskFilters(filters) ? (
              <Button variant="ghost" type="button" onClick={onReset}>
                Reset
              </Button>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}
