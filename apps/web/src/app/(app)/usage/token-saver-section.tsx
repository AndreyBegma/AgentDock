'use client';

import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Section } from '@andrewbehma/glass-ui/section';
import type { TokenSaverSummary } from '@nautelle/shared';
import Link from 'next/link';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import {
  BeforeAfterTable,
  FilterTable,
  RunKindTable,
} from '../../../components/token-saver/summary-tables';
import { SummaryTiles } from '../../../components/token-saver/summary-tiles';
import { describeTokenSaverError } from '../../../lib/token-saver/format';
import { topFilters } from '../../../lib/token-saver/summary';
import { useTokenSaverSummary } from '../../../lib/token-saver/use-token-saver-summary';
import type { UsageRange } from '../../../lib/usage/format';

const TOP_FILTERS = 8;

/**
 * #748: the saving by the launch that ran the command. The "Manual session"
 * row is priced from each session's own model and turns (the API's figure),
 * so it is not the project's input price times its tokens.
 */
export function RunKindBlock({
  rows,
}: {
  rows: TokenSaverSummary['byRunKind'];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">Saved by run kind</h3>
      <RunKindTable rows={rows} empty={null} />
      {rows.some((r) => r.runKind === 'manual') ? (
        <p className="text-ink-3 text-sm">
          Manual session is priced from each session's own model and turns.
        </p>
      ) : null}
    </div>
  );
}

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
    <Section
      className="mt-6"
      title="Token saver"
      surface="none"
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
    >
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
              <RunKindBlock rows={summary.byRunKind} />
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
    </Section>
  );
}
