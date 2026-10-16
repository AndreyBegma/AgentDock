'use client';

import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import Link from 'next/link';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import {
  BeforeAfterTable,
  FilterTable,
} from '../../../components/token-saver/summary-tables';
import { SummaryTiles } from '../../../components/token-saver/summary-tiles';
import { describeTokenSaverError } from '../../../lib/token-saver/format';
import { topFilters } from '../../../lib/token-saver/summary';
import { useTokenSaverSummary } from '../../../lib/token-saver/use-token-saver-summary';
import type { UsageRange } from '../../../lib/usage/format';

const TOP_FILTERS = 8;

/**
 * Usage's Token saver section (#445 D13): the period's savings, the cost per
 * run before and after, and the filters that saved most. One project when the
 * page is narrowed to it, otherwise the sum of the person's projects.
 */
export function TokenSaverSection({
  projectIds,
  singleProjectId,
  range,
}: {
  projectIds: readonly string[];
  /** The project the page is narrowed to; it links to that project's dashboard. */
  singleProjectId: string;
  range: UsageRange;
}) {
  const section = useTokenSaverSummary(projectIds, range);
  const dashboard = singleProjectId
    ? `/projects/${encodeURIComponent(singleProjectId)}/token-saver`
    : null;
  const empty = (
    <EmptyState
      title="No filtered commands in this range"
      description="Token saver counts a command when an agent runs it through the runner's filter. Try a longer range, or check the project's Token saver setting."
    />
  );
  return (
    <section className="mt-6" aria-labelledby="usage-token-saver">
      <SectionHeader
        className="mb-2"
        headingId="usage-token-saver"
        title="Token saver"
        description="What the runner's filter kept out of what agents read. Figures marked ≈ are estimates (bytes ÷ 4, priced at the model's input price)."
        actions={
          dashboard ? (
            <Link
              href={dashboard}
              className="text-accent-ink text-sm underline underline-offset-2"
            >
              Open the dashboard
            </Link>
          ) : undefined
        }
      />
      <AsyncSection
        section={section}
        isEmpty={(data) => data === null}
        unavailable={{
          title: 'Token saver is not answering',
          stillWorks: `${describeTokenSaverError(section.error)} The rest of Usage still works.`,
        }}
        empty={empty}
      >
        {(summary) =>
          summary ? (
            <div className="flex flex-col gap-4">
              <SummaryTiles summary={summary} />
              <div className="flex flex-col gap-2">
                <h3 className="font-medium text-sm">
                  Cost per run, before and after
                </h3>
                <BeforeAfterTable
                  rows={summary.beforeAfter}
                  empty={
                    <p className="text-ink-3 text-sm">
                      No run is priced on either side yet.
                    </p>
                  }
                />
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="font-medium text-sm">Top filters by savings</h3>
                <FilterTable
                  label="Top filters by savings"
                  passThrough
                  filters={topFilters(summary.byFilter, TOP_FILTERS)}
                  empty={
                    <p className="text-ink-3 text-sm">
                      No filter saved anything in this range.
                    </p>
                  }
                />
              </div>
            </div>
          ) : null
        }
      </AsyncSection>
    </section>
  );
}
