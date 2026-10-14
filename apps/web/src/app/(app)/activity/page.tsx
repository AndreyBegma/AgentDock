'use client';

import { PageHeader } from '../../../components/page-header/page-header';
import { useCurrentUser } from '../../../components/shell/user-context';
import { ActivityFeed } from './feed';

export default function ActivityPage() {
  const user = useCurrentUser();
  return (
    <>
      <PageHeader
        title="Activity"
        description="What happened across your projects: pull requests, blockers, runner changes and schedule runs."
      />
      <ActivityFeed isAdmin={user.role === 'admin'} />
    </>
  );
}
