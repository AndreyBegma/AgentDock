'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@andrewbehma/glass-ui/popover';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { ACTIVITY_CATEGORIES, type ProjectSummary } from '@nautelle/shared';
import { ListFilter } from 'lucide-react';
import { useMemo } from 'react';
import {
  type ActivityFilterForm,
  activityChipDefs,
  CATEGORY_LABEL,
  moreFilterCount,
  STEWARD_TYPE_OPTIONS,
  TYPE_OPTIONS,
} from '../../../lib/activity/format';
import {
  type UrlFilters,
  useFilterChips,
  useSearchDraft,
} from '../../../lib/filters/use-url-filters';

/**
 * Type, actor, slot and days: each applies as it changes (#213 — no Apply).
 * The slot applies once typing pauses.
 */
function MoreFilters({
  url,
  actors,
}: {
  url: UrlFilters<ActivityFilterForm>;
  /** Who caused the items loaded so far, by id → name. */
  actors: ReadonlyMap<string, string>;
}) {
  const { filters: form, set } = url;
  const slot = useSearchDraft(form.slot, (value) => set({ slot: value }));
  const count = moreFilterCount(form);

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
          <Field label="Type">
            <Select
              aria-label="Type"
              value={form.type}
              onChange={(e) => set({ type: e.target.value })}
            >
              <option value="">Any type</option>
              <optgroup label="Steward">
                {STEWARD_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Everything else">
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>
          <Field
            label="Actor"
            hint="People and runners seen in the feed so far."
          >
            <Select
              aria-label="Actor"
              value={form.actor}
              onChange={(e) => set({ actor: e.target.value })}
            >
              <option value="">Anyone</option>
              {[...actors].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {form.actor && !actors.has(form.actor) ? (
                <option value={form.actor}>The chosen actor</option>
              ) : null}
            </Select>
          </Field>
          <Field label="Slot" hint="An orchestrator slot's name.">
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
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * The feed's filter bar — the canonical one (#213): project and category as
 * instant selects with their names, "More filters" in a popover, the filters
 * in force as chips with Clear all. Below `sm` it folds into "Filters (n)"
 * and a sheet, where the project select has the sheet's whole width.
 */
export function FeedToolbar({
  url,
  projects,
  showProject,
  actors,
}: {
  url: UrlFilters<ActivityFilterForm>;
  projects: ProjectSummary[];
  showProject: boolean;
  actors: ReadonlyMap<string, string>;
}) {
  const { filters: form, set } = url;
  const defs = useMemo(() => {
    const projectNames = new Map(projects.map((p) => [p.id, p.displayName]));
    return activityChipDefs({
      project: (id) => projectNames.get(id) ?? 'another project',
      actor: (id) => actors.get(id) ?? 'the chosen actor',
    });
  }, [projects, actors]);
  const chips = useFilterChips(url, defs);

  return (
    <Toolbar
      aria-label="Filter activity"
      collapseBelow="sm"
      activeFilters={chips.activeFilters}
      onClearAll={chips.onClearAll}
      filters={
        <>
          {showProject ? (
            <Select
              aria-label="Project"
              value={form.projectId}
              onChange={(e) => set({ projectId: e.target.value })}
              className="w-full sm:w-48"
            >
              <option value="">All my projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.displayName}
                </option>
              ))}
            </Select>
          ) : null}
          <Select
            aria-label="Category"
            value={form.category}
            onChange={(e) => set({ category: e.target.value })}
            className="w-full sm:w-40"
          >
            <option value="">Any category</option>
            {ACTIVITY_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABEL[category]}
              </option>
            ))}
          </Select>
          <MoreFilters url={url} actors={actors} />
        </>
      }
    />
  );
}
