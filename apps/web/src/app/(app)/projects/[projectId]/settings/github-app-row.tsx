'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Card } from '@andrewbehma/glass-ui/card';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import type { GitHubProjectAppStatus } from '@nautelle/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import { Time } from '../../../../../lib/format/time';
import { HEALTH_REASON_LABEL } from '../../../../../lib/github-app/format';
import { githubAppState } from '../../../../../lib/projects/format';

/**
 * How the GitHub App covers this project (spec 27): whether its repository is
 * in an installation, and whether pushes are arriving. Read-only — the App is
 * managed on the admin page, linked from here.
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

  const state = githubAppState(status);
  return (
    <Card pad="lg">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">GitHub App</h2>
        <Badge
          className="h-5 px-2 text-xs"
          tone={state.tone}
          label={state.label}
        />
        <Link
          href="/admin/integrations"
          className="ml-auto text-sm text-accent-ink underline underline-offset-2"
        >
          Manage in Integrations
        </Link>
      </div>
      <p className="mt-2 max-w-prose text-sm text-ink-2">
        {status.reason
          ? HEALTH_REASON_LABEL[status.reason]
          : 'Deliveries from GitHub are arriving; the runner polls every 10 minutes instead of every minute.'}
      </p>
      <p className="mt-1 text-xs text-ink-3">
        Checked <Time value={status.checkedAt} fallback="never" />
      </p>
    </Card>
  );
}
