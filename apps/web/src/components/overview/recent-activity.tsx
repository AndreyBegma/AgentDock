import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Timeline } from '@andrewbehma/glass-ui/timeline';
import type { ProjectSummary } from '@nautelle/shared';
import Link from 'next/link';
import { toTimelineItem } from '../../lib/activity/format';
import { Retry } from './shared';
import type { useDashboard } from './use-dashboard';

/** The newest events across every project, each opening where `/activity` opens it. */
export function RecentActivity({
  projects,
  recent,
}: {
  projects: ProjectSummary[];
  recent: ReturnType<typeof useDashboard>['recent'];
}) {
  const names = new Map(projects.map((p) => [p.id, p.displayName]));
  const items = recent.data?.items.map((item) => toTimelineItem(item, names));

  return (
    <Section
      title="Recent activity"
      actions={
        <Link href="/activity" className="text-sm text-ink-2 hover:underline">
          All activity
        </Link>
      }
    >
      {items ? (
        <Timeline
          items={items}
          dayHeadingLevel={3}
          className="[&_li]:rounded-none [&_li]:bg-transparent [&_ol]:divide-y [&_ol]:divide-line"
          empty={
            <EmptyState
              title="No activity yet"
              description="Events appear here as the orchestrator opens pull requests, hits blockers and finishes work."
            />
          }
        />
      ) : recent.error !== null ? (
        <Retry title="Activity is not answering" section={recent} />
      ) : (
        <Skeleton className="h-24" />
      )}
    </Section>
  );
}
