'use client';

import {
  isUnfilteredId,
  LAST_RUNNER_WITHOUT_FILTER_REASONS,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Section } from '@andrewbehma/glass-ui/section';
import { SegmentedControl } from '@andrewbehma/glass-ui/segmented-control';
import { Settings } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import {
  CostPerRoundTable,
  CostPerRoundWeeksTable,
  UnmeasuredKindsNote,
} from '../../../../../components/token-saver/cost-per-round';
import { SavingsChart } from '../../../../../components/token-saver/savings-chart';
import {
  FilterTable,
  PromptCacheTable,
  RunKindTable,
  UnfilteredProgramTable,
  UnfilteredReasonTable,
} from '../../../../../components/token-saver/summary-tables';
import {
  PromptCacheTile,
  SummaryTiles,
} from '../../../../../components/token-saver/summary-tiles';
import { describeTokenSaverError } from '../../../../../lib/token-saver/format';
import {
  mostPassedThrough,
  runnerTooOldForReasons,
} from '../../../../../lib/token-saver/summary';
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
 * #648: why commands went unfiltered, which programs, and the prompt cache
 * as usage measured it. #663 D5: led by cost per round by session kind —
 * the fact the token saver is judged by (ADR-0068); saved bytes follow.
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
        description="What this project's rounds cost, measured from usage, and what the runner's filter kept out of what its agents read. Figures marked ≈ are estimates (bytes ÷ 4, priced at the model's input price)."
        link={Link}
        primaryAction={{
          label: 'Settings',
          href: settingsHref,
          icon: Settings,
        }}
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
        isEmpty={(data) =>
          data === null ||
          (data.totals.commands === 0 && data.costPerRound.length === 0)
        }
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
              {runnerTooOldForReasons(summary) ? (
                <Banner
                  tone="info"
                  title="The runner is too old to say why commands go unfiltered"
                >
                  {`This project's runner reports version ${summary.runnerVersion}; runners up to ${LAST_RUNNER_WITHOUT_FILTER_REASONS} record every unfiltered command as a plain “No filter”. Update the runner to see whether a command was compound, uncovered or run in a permission mode that never filters.`}
                </Banner>
              ) : null}

              <Section
                title="Cost per round"
                description="What a round of each session kind really cost, measured from its requests: the newest week in the range, and how the median moved since the oldest. Peak context is a round's largest request; turns and peak are medians."
                surface="none"
                pad="none"
              >
                <div className="flex flex-col gap-3">
                  <CostPerRoundTable
                    rows={summary.costPerRound}
                    empty={
                      <p className="text-ink-3 text-sm">
                        No ended round has usage in this range.
                      </p>
                    }
                  />
                  <UnmeasuredKindsNote />
                </div>
              </Section>

              {summary.costPerRound.length > 0 ? (
                <Section
                  title="Cost per round by week"
                  description="Each session kind week by week (ISO weeks, UTC), so a release shows as the week its cost changed."
                  surface="none"
                  pad="none"
                >
                  <CostPerRoundWeeksTable rows={summary.costPerRound} />
                </Section>
              ) : null}

              <Section title="Savings over time" surface="none" pad="none">
                <SavingsChart byDay={summary.byDay} />
              </Section>

              <div className="grid gap-6 lg:grid-cols-2">
                <Section
                  title="By filter"
                  description="Most saved first."
                  surface="none"
                  pad="none"
                >
                  <FilterTable
                    label="Savings by filter"
                    passThrough
                    filters={summary.byFilter.filter(
                      (f) => !isUnfilteredId(f.filter),
                    )}
                    empty={
                      <p className="text-ink-3 text-sm">
                        No filter saved anything in this range.
                      </p>
                    }
                  />
                </Section>
                <Section
                  title="By run kind"
                  description="The launch that ran the command."
                  surface="none"
                  pad="none"
                >
                  <RunKindTable rows={summary.byRunKind} empty={null} />
                </Section>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <Section
                  title="Why commands went unfiltered"
                  description="Every command no filter ran on, by the reason the runner gave."
                  surface="none"
                  pad="none"
                >
                  <UnfilteredReasonTable filters={summary.byFilter} />
                </Section>
                <Section
                  title="Most frequent unfiltered programs"
                  description="The program and its subcommand, never its arguments."
                  surface="none"
                  pad="none"
                >
                  <UnfilteredProgramTable
                    programs={summary.unfilteredPrograms}
                    empty={
                      <p className="text-ink-3 text-sm">
                        No unfiltered command named its program in this range —
                        runners up to {LAST_RUNNER_WITHOUT_FILTER_REASONS} do
                        not report one.
                      </p>
                    }
                  />
                </Section>
              </div>

              <Section
                title="Prompt cache, measured"
                description="From the usage of ended runs started in this range — not the filter's estimate. Input counts uncached tokens, cache reads and cache writes."
                surface="none"
                pad="none"
              >
                <div className="grid gap-3 lg:grid-cols-[16rem_1fr]">
                  <PromptCacheTile summary={summary} />
                  <PromptCacheTable
                    rows={summary.promptCache}
                    empty={
                      <p className="text-ink-3 text-sm">
                        No ended run has usage in this range.
                      </p>
                    }
                  />
                </div>
              </Section>

              <Section
                title="Filters that most often returned the original"
                description="Output the filter could not safely shorten, so the agent read it whole. The “No filter” reasons are the extreme case. A filter high here is a candidate for improvement."
                surface="none"
                pad="none"
              >
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
              </Section>
            </div>
          ) : null
        }
      </AsyncSection>
    </>
  );
}
