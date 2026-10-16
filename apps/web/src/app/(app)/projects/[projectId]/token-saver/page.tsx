'use client';

import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SegmentedControl } from '@andrewbehma/glass-ui/segmented-control';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { SavingsChart } from '../../../../../components/token-saver/savings-chart';
import {
  FilterTable,
  RunKindTable,
} from '../../../../../components/token-saver/summary-tables';
import { SummaryTiles } from '../../../../../components/token-saver/summary-tiles';
import { describeTokenSaverError } from '../../../../../lib/token-saver/format';
import { mostPassedThrough } from '../../../../../lib/token-saver/summary';
import { useTokenSaverSummary } from '../../../../../lib/token-saver/use-token-saver-summary';
import { presetRange } from '../../../../../lib/usage/format';
import { Segment } from '../../../workflows/segment';

const PRESETS = ['7d', '30d'] as const;
type Preset = (typeof PRESETS)[number];
const TOP = 10;

/**
 * #445 D13: the project's Token saver dashboard — savings over time, by
 * filter, by run kind, the bypass rate, and the filters that most often
 * returned the original (where a filter gets in the way or does not reach).
 */
export default function TokenSaverPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [preset, setPreset] = useState<Preset>('30d');
  // A preset moves with the clock only on a new choice, as on Usage.
  const range = useMemo(() => presetRange(preset), [preset]);
  const ids = useMemo(() => [projectId], [projectId]);
  const section = useTokenSaverSummary(ids, range);

  const settingsHref = `/projects/${encodeURIComponent(projectId)}/settings?tab=token-saver`;
  const empty = (
    <EmptyState
      title="Nothing filtered in this range"
      description="Token saver counts a command when an agent runs it through the runner's filter. Try a longer range, or check that the setting is on."
      link={({ href, className, children, ...rest }) => (
        <Link href={href} className={className} {...rest}>
          {children}
        </Link>
      )}
      action={{ label: 'Open the setting', href: settingsHref }}
    />
  );

  return (
    <>
      <PageHeader
        title="Token saver"
        description="What the runner's filter kept out of what this project's agents read. Figures marked ≈ are estimates (bytes ÷ 4, priced at the model's input price); the fact — cost per run before and after — is on Usage."
        actions={
          <SegmentedControl size="sm" aria-label="Range">
            {PRESETS.map((p) => (
              <Segment
                key={p}
                layoutId="token-saver-range"
                size="sm"
                active={preset === p}
                onSelect={() => setPreset(p)}
              >
                {p === '7d' ? 'Last 7 days' : 'Last 30 days'}
              </Segment>
            ))}
          </SegmentedControl>
        }
      />
      <AsyncSection
        section={section}
        isEmpty={(data) => data === null || data.totals.commands === 0}
        unavailable={{
          title: 'Token saver is not answering',
          stillWorks: describeTokenSaverError(section.error),
        }}
        empty={empty}
      >
        {(summary) =>
          summary ? (
            <div className="flex flex-col gap-6">
              <SummaryTiles summary={summary} />

              <section aria-labelledby="ts-over-time">
                <SectionHeader
                  className="mb-2"
                  headingId="ts-over-time"
                  title="Savings over time"
                />
                <SavingsChart byDay={summary.byDay} />
              </section>

              <div className="grid gap-6 lg:grid-cols-2">
                <section aria-labelledby="ts-by-filter">
                  <SectionHeader
                    className="mb-2"
                    headingId="ts-by-filter"
                    title="By filter"
                    description="Most saved first."
                  />
                  <FilterTable
                    label="Savings by filter"
                    passThrough
                    filters={summary.byFilter.filter(
                      (f) => f.filter !== 'none',
                    )}
                    empty={
                      <p className="text-ink-3 text-sm">
                        No filter saved anything in this range.
                      </p>
                    }
                  />
                </section>
                <section aria-labelledby="ts-by-kind">
                  <SectionHeader
                    className="mb-2"
                    headingId="ts-by-kind"
                    title="By run kind"
                    description="The launch that ran the command."
                  />
                  <RunKindTable rows={summary.byRunKind} empty={null} />
                </section>
              </div>

              <section aria-labelledby="ts-original">
                <SectionHeader
                  className="mb-2"
                  headingId="ts-original"
                  title="Filters that most often returned the original"
                  description="Output the filter could not safely shorten, so the agent read it whole. “No filter” is a command no family covers. A filter high here is a candidate for improvement."
                />
                <FilterTable
                  label="Filters that returned the original"
                  passThrough
                  filters={mostPassedThrough(summary.byFilter, TOP)}
                  empty={
                    <p className="text-ink-3 text-sm">
                      Every filtered command was shortened.
                    </p>
                  }
                />
              </section>
            </div>
          ) : null
        }
      </AsyncSection>
    </>
  );
}
