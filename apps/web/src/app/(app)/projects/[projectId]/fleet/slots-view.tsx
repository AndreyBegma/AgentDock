'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import {
  SLOT_STATUSES,
  type SlotPage,
  type SlotStatus,
  type SlotSummary,
} from '@nautelle/shared';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { api } from '../../../../../lib/api';
import {
  EMPTY_FLEET_DESCRIPTION,
  parseIssueFilter,
  slotStatusOptions,
  slotsQuery,
} from '../../../../../lib/fleet/format';
import { useSection } from '../../../../../lib/section/use-section';
import { SlotList } from './slot-list';

const PAGE_SIZE = 50;

/**
 * The Fleet's slot list: the active slots, or every slot with filters and
 * paging once "Show ended" is on.
 */
export function SlotsView({
  projectId,
  active,
  version,
  nobodyYet,
  focus,
  onSelect,
}: {
  projectId: string;
  /** The fleet's active slots, shown while "Show ended" is off. */
  active: SlotSummary[];
  /** Bumped by a live push; the paged list refetches on it. */
  version: number;
  /** What an empty fleet shows. */
  nobodyYet: ReactNode;
  /** The slot whose panel is open. */
  focus?: string | null;
  onSelect: (slot: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [issueText, setIssueText] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  const status = SLOT_STATUSES.find((s) => s === statusFilter);
  const issue = parseIssueFilter(issueText);
  const filtered = status !== undefined || issue !== undefined;

  // The "all slots" view: first page for the filters, refetched on a push.
  // Nothing while the view is off, so a toggle shows a skeleton, not an empty list.
  const history = useSection<SlotPage | undefined>(
    () =>
      showAll
        ? api<SlotPage>(
            `/projects/${projectId}/slots${slotsQuery({ status, issue, limit: PAGE_SIZE })}`,
          )
        : Promise.resolve(undefined),
    [projectId, showAll, status, issue, version],
  );

  const loadMore = async () => {
    const cursor = history.data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api<SlotPage>(
        `/projects/${projectId}/slots${slotsQuery({ status, issue, cursor, limit: PAGE_SIZE })}`,
      );
      history.setData((current) =>
        current
          ? {
              items: [...current.items, ...page.items],
              nextCursor: page.nextCursor,
            }
          : current,
      );
    } catch {
      // The list stays as it is; the button is still there to try again.
    } finally {
      setLoadingMore(false);
    }
  };

  const clearFilters = () => {
    setStatusFilter('');
    setIssueText('');
  };

  const slotsList = (slots: SlotSummary[]) => (
    <Section title="Agents" pad="none">
      <SlotList
        slots={slots}
        focus={focus ?? null}
        onSelect={(s) => onSelect(s.name)}
      />
    </Section>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-center gap-2 text-sm">
          <Toggle
            labelledBy="fleet-show-ended"
            checked={showAll}
            onChange={setShowAll}
          />
          <span id="fleet-show-ended">Show ended</span>
        </div>
        {showAll ? (
          <>
            <Field label="Status" htmlFor="fleet-status">
              <Select
                id="fleet-status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">Any status</option>
                {slotStatusOptions().map(
                  (o: { value: SlotStatus; label: string }) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Issue" htmlFor="fleet-issue">
              <Input
                id="fleet-issue"
                value={issueText}
                inputMode="numeric"
                placeholder="e.g. 42"
                maxLength={10}
                onChange={(e) => setIssueText(e.target.value)}
              />
            </Field>
          </>
        ) : null}
      </div>

      {showAll ? (
        <AsyncSection
          section={history}
          unavailable={{
            title: 'Slots could not be loaded',
            stillWorks: 'The active slots above are still current.',
          }}
          isEmpty={(page) => page === undefined || page.items.length === 0}
          empty={
            filtered ? (
              <EmptyState
                title="No matching slots"
                description="No slot matches these filters."
                action={
                  <Button variant="glass" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No slots yet"
                description={EMPTY_FLEET_DESCRIPTION}
                action={
                  <Link
                    href={`/projects/${projectId}/queue`}
                    className="text-sm text-accent-ink underline"
                  >
                    Open Queue
                  </Link>
                }
              />
            )
          }
          skeleton={<Skeleton className="h-40 w-full" />}
        >
          {(page) => (
            <>
              {slotsList(page?.items ?? [])}
              {page?.nextCursor ? (
                <div className="flex justify-center">
                  <Button
                    variant="glass"
                    disabled={loadingMore}
                    onClick={loadMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </AsyncSection>
      ) : active.length === 0 ? (
        nobodyYet
      ) : (
        slotsList(active)
      )}
    </div>
  );
}
