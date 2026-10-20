'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Combobox } from '@andrewbehma/glass-ui/combobox';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@andrewbehma/glass-ui/popover';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { type AdminUser, AUDIT_ACTIONS, AUDIT_RESULTS } from '@nautelle/shared';
import { ListFilter } from 'lucide-react';
import { useMemo } from 'react';
import {
  ACTION_LABEL,
  actionGroupLabel,
  RESULT_LABEL,
} from '../../../lib/audit/actions';
import { type AuditFilterForm, actionGroups } from '../../../lib/audit/format';
import {
  type UrlFilters,
  useFilterChips,
  useSearchDraft,
} from '../../../lib/filters/use-url-filters';
import { auditChipDefs, moreFilterCount } from './filters';

const ACTION_GROUPS = actionGroups(AUDIT_ACTIONS);

/** A text filter: applies once typing pauses, or at once on Enter. */
function TextFilter({
  label,
  value,
  maxLength,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  maxLength: number;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const draft = useSearchDraft(value, onCommit);
  return (
    <Field label={label}>
      <Input
        aria-label={label}
        value={draft.draft}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => draft.setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') draft.flush();
        }}
      />
    </Field>
  );
}

/** Days and the target: each applies as it changes (#213 — no Apply). */
function MoreFilters({ url }: { url: UrlFilters<AuditFilterForm> }) {
  const { filters: form, set } = url;
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
          <TextFilter
            label="Target type"
            value={form.targetType}
            maxLength={100}
            placeholder="e.g. runner"
            onCommit={(value) => set({ targetType: value })}
          />
          <TextFilter
            label="Target id"
            value={form.targetId}
            maxLength={320}
            onCommit={(value) => set({ targetId: value })}
          />
          <TextFilter
            label="Project id"
            value={form.projectId}
            maxLength={200}
            onCommit={(value) => set({ projectId: value })}
          />
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * The Audit log's filter bar — the canonical one (#213): Action, Result and
 * Actor as instant controls, the rest under "More filters", the filters in
 * force as chips with Clear all, all of it in the URL. Below `sm` it folds
 * into "Filters (n)" and a sheet.
 */
export function AuditFilters({
  url,
  users,
}: {
  url: UrlFilters<AuditFilterForm>;
  users: AdminUser[];
}) {
  const { filters: form, set } = url;
  const defs = useMemo(() => {
    const names = new Map(users.map((u) => [u.id, u.email]));
    return auditChipDefs((id) => names.get(id) ?? 'the chosen actor');
  }, [users]);
  const chips = useFilterChips(url, defs);
  const actors = useMemo(
    () => users.map((u) => ({ value: u.id, label: u.email })),
    [users],
  );

  return (
    <Toolbar
      aria-label="Filter the audit log"
      collapseBelow="sm"
      activeFilters={chips.activeFilters}
      onClearAll={chips.onClearAll}
      filters={
        <>
          <Select
            aria-label="Action"
            value={form.action}
            className="w-full sm:w-52"
            onChange={(e) => set({ action: e.target.value })}
          >
            <option value="">Any action</option>
            {ACTION_GROUPS.map((group) => (
              <optgroup key={group} label={actionGroupLabel(group)}>
                <option value={group}>All {actionGroupLabel(group)}</option>
                {AUDIT_ACTIONS.filter((a) => a.startsWith(group)).map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABEL[a]}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <Select
            aria-label="Result"
            value={form.result}
            className="w-full sm:w-40"
            onChange={(e) => set({ result: e.target.value })}
          >
            <option value="">Any result</option>
            {AUDIT_RESULTS.map((r) => (
              <option key={r} value={r}>
                {RESULT_LABEL[r]}
              </option>
            ))}
          </Select>
          <div className="w-full sm:w-52">
            <Combobox
              aria-label="Actor"
              placeholder="Any user"
              value={form.actorUserId || null}
              onValueChange={(value) => set({ actorUserId: value ?? '' })}
              options={actors}
            />
          </div>
          <MoreFilters url={url} />
        </>
      }
    />
  );
}
