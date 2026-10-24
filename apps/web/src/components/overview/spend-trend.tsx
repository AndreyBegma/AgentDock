import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Sparkline } from '@andrewbehma/glass-ui/sparkline';
import Link from 'next/link';
import { spendDays } from '../../lib/overview/dashboard';
import { Retry } from './shared';
import type { useDashboard } from './use-dashboard';

/** API-equivalent cost per day for the last 7 days, today's figure beside it. */
export function SpendTrend({
  spend,
}: {
  spend: ReturnType<typeof useDashboard>['spend'];
}) {
  const days = spend.data ? spendDays(spend.data) : undefined;

  return (
    <Section
      title="Spend"
      actions={
        <Link href="/usage" className="text-sm text-ink-2 hover:underline">
          Usage
        </Link>
      }
    >
      {days ? (
        <Link
          href="/usage"
          aria-label="Open Usage"
          className="flex items-end justify-between gap-4 rounded-surface"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span className="num text-2xl font-semibold tracking-tight">
              {days.today || '—'}
            </span>
            <span className="text-sm text-ink-2">
              Today · API-equivalent, last 7 days
            </span>
          </div>
          <div className="max-w-full overflow-hidden">
            <Sparkline
              values={days.values}
              width={160}
              height={48}
              area
              label="API-equivalent cost per day, last 7 days"
            />
          </div>
        </Link>
      ) : spend.error !== null ? (
        <Retry title="Usage is not answering" section={spend} />
      ) : (
        <Skeleton className="h-24" />
      )}
    </Section>
  );
}
