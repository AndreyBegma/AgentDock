'use client';

import type { GitHubProjectAppStatus } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Card } from 'glass-ui/card';
import { Skeleton } from 'glass-ui/skeleton';
import { useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import { formatAgo } from '../../../../../lib/fleet/format';
import {
  HEALTH_REASON_LABEL,
  HEALTH_TONE,
} from '../../../../../lib/github-app/format';

/**
 * How the GitHub App covers this project (spec 27): whether its repository is
 * in an installation, and whether pushes are arriving. Read-only — the App is
 * managed on the admin page.
 */
export function GitHubAppRow({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<GitHubProjectAppStatus | null>();

  useEffect(() => {
    setStatus(undefined);
    api<GitHubProjectAppStatus>(`/projects/${projectId}/github-app`)
      .then(setStatus)
      // Not deployed or not readable: the row simply is not shown.
      .catch(() => setStatus(null));
  }, [projectId]);

  if (status === null) return null;
  if (status === undefined) return <Skeleton className="h-20 w-full" />;

  return (
    <Card pad="lg">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">GitHub App</h2>
        <Badge
          tone={HEALTH_TONE[status.state]}
          label={status.state === 'healthy' ? 'healthy' : 'unhealthy'}
        />
        <Badge
          tone={status.covered ? 'ok' : 'neutral'}
          label={status.covered ? 'covered' : 'not covered'}
        />
      </div>
      <p className="mt-2 max-w-prose text-sm text-ink-2">
        {status.reason
          ? HEALTH_REASON_LABEL[status.reason]
          : 'Deliveries from GitHub are arriving; the runner polls every 10 minutes instead of every minute.'}
      </p>
      <p className="mt-1 text-xs text-ink-3">
        Checked {status.checkedAt ? formatAgo(status.checkedAt) : 'never'}
      </p>
    </Card>
  );
}
