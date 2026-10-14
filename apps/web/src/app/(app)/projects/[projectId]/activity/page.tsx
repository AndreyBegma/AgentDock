'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { useCurrentUser } from '../../../../../components/shell/user-context';
import { ActivityFeed } from '../../../activity/feed';
import { ProjectRunnerBanner } from '../project-runner-banner';

export default function ProjectActivityPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const user = useCurrentUser();
  return (
    <>
      <PageHeader
        title="Activity"
        description="What happened in this project: its slots, runs, pull requests and approvals."
        className="mb-4"
      />
      <div className="mb-4">
        <ProjectRunnerBanner projectId={projectId} />
      </div>
      <ActivityFeed
        key={projectId}
        projectId={projectId}
        isAdmin={user.role === 'admin'}
      />
    </>
  );
}
