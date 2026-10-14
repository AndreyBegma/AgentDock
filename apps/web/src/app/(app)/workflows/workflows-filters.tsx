'use client';

import type { ProjectRuntimeProfile, ProjectSummary } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { ChipButton } from '@andrewbehma/glass-ui/chip';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { SegmentedControl } from '@andrewbehma/glass-ui/segmented-control';
import { X } from 'lucide-react';
import { RANGE_PRESETS, type RangePreset } from '../../../lib/usage/format';
import {
  clearNodeFilter,
  clearNodeFilters,
  type WorkflowsFilters as Filters,
  nodeFilterChips,
} from '../../../lib/workflows/format';
import { Segment } from './segment';
import { StatusSegment } from './workflows-header';

const PRESET_LABEL: Record<RangePreset, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  custom: 'Custom',
};

export function WorkflowsFilters({
  filters,
  onChange,
  projects,
  profiles,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  projects: ProjectSummary[];
  /**
   * The chosen project's runtime profiles; null when the select is not
   * offered (no project, or a viewer — the route is operator+).
   */
  profiles: ProjectRuntimeProfile[] | null;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 [&>*]:min-w-0 [&>*:not(:first-child)]:flex-[1_1_12rem]">
      {/* One first child, so the segments keep their size and the
          selects after them share the rest of the row. */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Below md the status segment lives here; the header holds it above. */}
        <div className="md:hidden">
          <Field label="Sessions">
            <StatusSegment
              status={filters.status}
              onStatus={(status) => onChange({ ...filters, status })}
              layoutId="workflows-status-filters"
            />
          </Field>
        </div>
        <Field label="Range">
          <SegmentedControl aria-label="Time range">
            {RANGE_PRESETS.map((p) => (
              <Segment
                key={p}
                layoutId="workflows-range"
                active={filters.range === p}
                onSelect={() => onChange({ ...filters, range: p })}
              >
                {PRESET_LABEL[p]}
              </Segment>
            ))}
          </SegmentedControl>
        </Field>
      </div>
      <Field label="Project" htmlFor="workflows-project">
        <Select
          id="workflows-project"
          value={filters.projectId}
          // A profile key belongs to one project's runner: a new project drops it.
          onChange={(e) =>
            onChange({ ...filters, projectId: e.target.value, profileKey: '' })
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
      </Field>
      {profiles ? (
        <Field label="Runtime profile" htmlFor="workflows-profile">
          <Select
            id="workflows-profile"
            value={filters.profileKey}
            onChange={(e) =>
              onChange({ ...filters, profileKey: e.target.value })
            }
          >
            <option value="">Every profile</option>
            {filters.profileKey &&
            !profiles.some((p) => p.key === filters.profileKey) ? (
              <option value={filters.profileKey}>{filters.profileKey}</option>
            ) : null}
            {profiles.map((profile) => (
              <option key={profile.key} value={profile.key}>
                {profile.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {filters.range === 'custom' ? (
        <>
          <Field label="From" htmlFor="workflows-from">
            <DateInput
              id="workflows-from"
              value={filters.fromDate}
              max={filters.toDate || undefined}
              onChange={(e) =>
                onChange({ ...filters, fromDate: e.target.value })
              }
            />
          </Field>
          <Field label="To (inclusive)" htmlFor="workflows-to">
            <DateInput
              id="workflows-to"
              value={filters.toDate}
              min={filters.fromDate || undefined}
              onChange={(e) => onChange({ ...filters, toDate: e.target.value })}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

/**
 * What the graph clicks filter on, each removable. A profile that came in on
 * the URL while no select is offered shows here too: a filter that applies
 * is never invisible.
 */
export function NodeFilterChips({
  filters,
  onChange,
  showProfile,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  showProfile: boolean;
}) {
  const chips = nodeFilterChips(filters);
  if (chips.length === 0 && !showProfile) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-3" id="workflows-chips-label">
        Filtered on
      </span>
      <ul
        aria-labelledby="workflows-chips-label"
        className="flex flex-wrap items-center gap-2"
      >
        {showProfile ? (
          <li>
            <RemoveChip
              label={`Runtime profile: ${filters.profileKey}`}
              onRemove={() => onChange({ ...filters, profileKey: '' })}
            />
          </li>
        ) : null}
        {chips.map((chip) => (
          <li key={chip.key}>
            <RemoveChip
              label={chip.label}
              onRemove={() => onChange(clearNodeFilter(filters, chip.key))}
            />
          </li>
        ))}
      </ul>
      {chips.length > 1 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(clearNodeFilters(filters))}
        >
          Clear graph filters
        </Button>
      ) : null}
    </div>
  );
}

/** A filter that is on: the whole chip removes it. */
function RemoveChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <ChipButton
      selected
      aria-label={`Remove ${label}`}
      onClick={onRemove}
      className="gap-1.5"
    >
      {label}
      <X aria-hidden="true" className="size-3" />
    </ChipButton>
  );
}
