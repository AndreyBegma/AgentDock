'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@andrewbehma/glass-ui/popover';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import type { ProjectSummary } from '@nautelle/shared';
import { ListFilter } from 'lucide-react';
import { useMemo } from 'react';
import {
  type UrlFilters,
  useFilterChips,
  useSearchDraft,
} from '../../../lib/filters/use-url-filters';
import {
  moreSessionFilterCount,
  RUNTIME_LABEL,
  sessionChipDefs,
} from '../../../lib/sessions/filters';
import {
  ORIGIN_FILTERS,
  ORIGIN_LABEL,
  type SessionFilterForm,
} from '../../../lib/sessions/format';

/** Dates, model and slot: each applies as it changes; the text once typing pauses. */
function MoreFilters({
  url,
  isAdmin,
}: {
  url: UrlFilters<SessionFilterForm>;
  isAdmin: boolean;
}) {
  const { filters: form, set } = url;
  const model = useSearchDraft(form.model, (value) => set({ model: value }));
  const slot = useSearchDraft(form.slot, (value) => set({ slot: value }));
  const count = moreSessionFilterCount(form);

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button variant="glass" size="sm" className="shrink-0">
          <ListFilter size={14} aria-hidden="true" />
          More filters
          {count > 0 ? <Badge tone="ink" count={count} /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent title="More filters" align="end" className="w-80">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <DateInput
                aria-label="From"
                value={form.fromDate}
                max={form.toDate || undefined}
                onChange={(e) => set({ fromDate: e.target.value })}
              />
            </Field>
            <Field label="To">
              <DateInput
                aria-label="To"
                value={form.toDate}
                min={form.fromDate || undefined}
                onChange={(e) => set({ toDate: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Model">
            <Input
              aria-label="Model"
              value={model.draft}
              maxLength={200}
              placeholder="e.g. claude-opus-5-5"
              onChange={(e) => model.setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') model.flush();
              }}
            />
          </Field>
          <Field
            label="Slot"
            hint="The orchestrator slot, as in the Project column."
          >
            <Input
              aria-label="Slot"
              value={slot.draft}
              maxLength={200}
              placeholder="e.g. i42"
              onChange={(e) => slot.setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') slot.flush();
              }}
            />
          </Field>
          {isAdmin ? (
            <Checkbox
              label="Unassigned only"
              hint="Sessions with no project; turns the project filter off."
              checked={form.unassigned}
              onChange={(e) => set({ unassigned: e.target.checked })}
            />
          ) : null}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * The sessions filter bar — the canonical one (#213): project, runtime and
 * origin as instant selects, "More filters" in a popover, the filters in
 * force as chips with Clear all. Below `sm` it folds into "Filters (n)" and
 * a sheet.
 */
export function SessionsFilters({
  url,
  projects,
  isAdmin,
}: {
  url: UrlFilters<SessionFilterForm>;
  projects: ProjectSummary[];
  isAdmin: boolean;
}) {
  const { filters: form, set } = url;
  const defs = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.displayName]));
    return sessionChipDefs((id) => names.get(id) ?? 'another project');
  }, [projects]);
  const chips = useFilterChips(url, defs);

  return (
    <Toolbar
      aria-label="Filter sessions"
      collapseBelow="sm"
      activeFilters={chips.activeFilters}
      onClearAll={chips.onClearAll}
      filters={
        <>
          <Select
            aria-label="Project"
            value={form.projectId}
            disabled={form.unassigned}
            className="w-full sm:w-48"
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
            aria-label="Runtime"
            value={form.runtime}
            className="w-full sm:w-40"
            onChange={(e) => set({ runtime: e.target.value })}
          >
            <option value="">Any runtime</option>
            {Object.entries(RUNTIME_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Origin"
            value={form.origin}
            className="w-full sm:w-40"
            onChange={(e) => set({ origin: e.target.value })}
          >
            <option value="">Any origin</option>
            {ORIGIN_FILTERS.map((origin) => (
              <option key={origin} value={origin}>
                {ORIGIN_LABEL[origin]}
              </option>
            ))}
          </Select>
          <MoreFilters url={url} isAdmin={isAdmin} />
        </>
      }
    />
  );
}
