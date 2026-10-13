'use client';

import { useParams } from 'next/navigation';
import { useCurrentUser } from '../../../../../components/shell/user-context';
import { ActivityFeed } from '../../../activity/feed';
import { ProjectRunnerBanner } from '../project-runner-banner';

export default function ProjectActivityPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const user = useCurrentUser();
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Activity</h1>
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
