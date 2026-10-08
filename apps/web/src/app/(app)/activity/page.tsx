'use client';

import { useCurrentUser } from '../../../components/shell/user-context';
import { ActivityFeed } from './feed';

export default function ActivityPage() {
  const user = useCurrentUser();
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Activity</h1>
      <ActivityFeed isAdmin={user.role === 'admin'} />
    </>
  );
}
