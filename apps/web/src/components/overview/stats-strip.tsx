import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import type { ReactNode } from 'react';
import {
  mergedPullRequests,
  mergedTodayHref,
  OVERVIEW_TILE_HREF,
  runningSlots,
} from '../../lib/overview/dashboard';
import type { Section as SectionState } from '../../lib/section/use-section';
import { costOrBlank } from '../../lib/usage/format';
import { notAnswering } from './shared';
import type { useDashboard } from './use-dashboard';

/** A tile's value: the figure, or a dash with the reason — never a false zero. */
function tileFigure<T>(
  section: SectionState<T>,
  figure: (data: T) => string,
): { value: ReactNode; failed: boolean } {
  if (section.data === undefined) {
    return { value: section.error !== null ? '—' : '', failed: true };
  }
  return {
    value: <span className="num">{figure(section.data)}</span>,
    failed: false,
  };
}

/** The compact strip above the columns: three figures, each a link. */
export function StatsStrip({
  facts,
  costToday,
  merged,
}: Pick<ReturnType<typeof useDashboard>, 'facts' | 'costToday' | 'merged'>) {
  const running = tileFigure(facts, (f) =>
    String(runningSlots(f.fleets.values())),
  );
  const cost = tileFigure(
    costToday,
    (s) =>
      costOrBlank(
        s.totals.costUsd,
        s.totals.requests,
        s.totals.unpricedRequests,
      ) || '—',
  );
  const mergedToday = tileFigure(merged, (page) => {
    const count = mergedPullRequests(page.items);
    return page.nextCursor ? `${count}+` : String(count);
  });
  const partial = facts.data ? notAnswering(facts.data.failed) : undefined;

  return (
    <div className="grid grid-cols-1 gap-2 tablet:grid-cols-3">
      {/* Each tile goes where its figure is explained (#213). */}
      <StatTile
        hue={2}
        label="Running slots"
        loading={facts.loading && !facts.data}
        value={running.value}
        hint={
          facts.error !== null && !facts.data
            ? 'Projects are not answering'
            : (partial ?? 'Agent sessions alive now')
        }
        href={OVERVIEW_TILE_HREF.running}
      />
      <StatTile
        hue={4}
        label="Cost today"
        loading={costToday.loading && !costToday.data}
        value={cost.value}
        hint={
          cost.failed
            ? 'Usage is not answering'
            : 'API-equivalent, since midnight'
        }
        href={OVERVIEW_TILE_HREF.cost}
      />
      <StatTile
        hue={3}
        label="PRs merged today"
        loading={merged.loading && !merged.data}
        value={mergedToday.value}
        hint={
          mergedToday.failed ? 'Activity is not answering' : 'Since midnight'
        }
        href={mergedTodayHref()}
      />
    </div>
  );
}
