'use client';

import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Tab, TabGroup, TabList, TabPanel } from '@andrewbehma/glass-ui/tabs';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { AiDigestPanel } from '../../../../../components/ai/digest-panel';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { useCurrentUser } from '../../../../../components/shell/user-context';
import { useTabParam } from '../../../../../lib/projects/use-tab-param';
import { ActivityFeed } from '../../../activity/feed';
import { ProjectRunnerBanner } from '../project-runner-banner';
import { RunsTab } from './runs-tab';

/** Feed first; `?tab=runs` is where the former History lives (C-285). */
const TAB_IDS: readonly string[] = ['feed', 'runs'];

function ProjectActivity() {
  const { projectId } = useParams<{ projectId: string }>();
  const user = useCurrentUser();
  const [tab, setTab] = useTabParam(TAB_IDS);
  return (
    <>
      <PageHeader
        title="Activity"
        description="Everything that happened in this project, newest first: its events, and every run of its slots, skills and schedules."
        className="mb-4"
      />
      <div className="mb-4">
        <ProjectRunnerBanner projectId={projectId} />
      </div>
      <TabGroup value={tab} onValueChange={setTab}>
        <TabList aria-label="Activity">
          <Tab value="feed">Feed</Tab>
          <Tab value="runs">Runs</Tab>
        </TabList>
        <TabPanel value="feed" className="pt-4">
          {/* Only the open tab loads: the other one fetches nothing. */}
          {tab === 'feed' ? (
            <>
              <AiDigestPanel
                key={projectId}
                single
                projects={[{ id: projectId, displayName: '' }]}
              />
              <ActivityFeed
                key={projectId}
                projectId={projectId}
                isAdmin={user.role === 'admin'}
              />
            </>
          ) : null}
        </TabPanel>
        <TabPanel value="runs" className="pt-4">
          {tab === 'runs' ? (
            <RunsTab key={projectId} projectId={projectId} />
          ) : null}
        </TabPanel>
      </TabGroup>
    </>
  );
}

export default function ProjectActivityPage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ProjectActivity />
    </Suspense>
  );
}
