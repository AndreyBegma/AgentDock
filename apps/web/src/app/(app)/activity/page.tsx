'use client';

import { useCurrentUser } from '../../../components/shell/user-context';
import { ActivityFeed } from './feed';

export default function ActivityPage() {
  const user = useCurrentUser();
  return (
    <>
      <h1 className="text-xl font-semibold">Activity</h1>
      <p className="mb-4 text-sm text-ink-2">
        What happened across your projects: pull requests, blockers, runner
        changes and schedule runs.
      </p>
      <ActivityFeed isAdmin={user.role === 'admin'} />
    </>
  );
}
