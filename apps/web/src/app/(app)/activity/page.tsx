'use client';

import { AiDigestPanel } from '../../../components/ai/digest-panel';
import { PageHeader } from '../../../components/page-header/page-header';
import { useProjects } from '../../../components/shell/use-shell-data';
import { useCurrentUser } from '../../../components/shell/user-context';
import { ActivityFeed } from './feed';

export default function ActivityPage() {
  const user = useCurrentUser();
  const projects = useProjects();
  return (
    <>
      <PageHeader
        title="Activity"
        description="What happened across your projects: pull requests, blockers, runner changes and schedule runs."
      />
      <AiDigestPanel projects={projects} />
      <ActivityFeed isAdmin={user.role === 'admin'} />
    </>
  );
}
