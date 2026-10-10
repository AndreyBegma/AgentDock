'use client';

import type { GitHubAppView, GitHubResyncResult } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { formatAgo } from '../../../../lib/fleet/format';
import {
  describeCallbackError,
  describeGitHubAppError,
} from '../../../../lib/github-app/format';
import { ManualCard, RegisterCard } from './register-cards';

type Registered = Extract<GitHubAppView, { registered: true }>;

const when = (iso: string | null): string => (iso ? formatAgo(iso) : '—');

export default function GitHubAppPage() {
  const [view, setView] = useState<GitHubAppView>();
  const [callbackError, setCallbackError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api<GitHubAppView>('/admin/github-app'));
    } catch (err) {
      toast.error(describeGitHubAppError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The API’s callback redirects here with `?registered=1` or `?error=<code>`.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) setCallbackError(describeCallbackError(error));
    else if (params.get('registered')) toast.success('GitHub App registered.');
    if (error || params.has('registered')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const resync = async () => {
    setBusy(true);
    try {
      const result = await api<GitHubResyncResult>('/admin/github-app/resync', {
        method: 'POST',
      });
      toast.success(
        `Synced ${result.installations} installation(s), ${result.repos} repo(s).`,
      );
      await load();
    } catch (err) {
      toast.error(describeGitHubAppError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api('/admin/github-app', { method: 'DELETE' });
      setConfirmDelete(false);
      toast.success('GitHub App removed.');
      await load();
    } catch (err) {
      toast.error(describeGitHubAppError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">GitHub App</h1>
        <p className="max-w-prose text-sm text-ink-2">
          A read-only App that tells AgentDock the moment an issue, pull request
          or check changes. Without it everything still works — runners poll
          GitHub every 60 s.
        </p>
      </div>

      {callbackError ? (
        <Banner tone="danger" title="Registration failed">
          {callbackError}
        </Banner>
      ) : null}

      {!view ? (
        <Skeleton className="h-48 w-full" />
      ) : view.registered ? (
        <AppDetails
          app={view}
          busy={busy}
          onResync={() => void resync()}
          onDelete={() => setConfirmDelete(true)}
        />
      ) : (
        <>
          <RegisterCard view={view} />
          <ManualCard onSaved={() => void load()} />
        </>
      )}

      <DialogRoot
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(false);
        }}
      >
        <DialogContent
          title="Remove the GitHub App?"
          description="AgentDock forgets the App and its stored secrets, and runners go back to polling every 60 s. The App itself stays on GitHub — delete it there too."
          footer={
            <>
              <Button variant="glass" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                Remove
              </Button>
            </>
          }
        >
          {null}
        </DialogContent>
      </DialogRoot>
    </div>
  );
}

function AppDetails({
  app,
  busy,
  onResync,
  onDelete,
}: {
  app: Registered;
  busy: boolean;
  onResync: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      {app.hookActive ? null : (
        <Banner tone="warn" title="Webhook inactive">
          {app.publicUrl
            ? 'GitHub is not delivering to this server.'
            : 'No PUBLIC_URL is configured, so GitHub cannot reach this server.'}{' '}
          Runners keep polling every 60 s.
        </Banner>
      )}
      {app.signatureFailures > 0 ? (
        <Banner tone="warn" title="Signature failures">
          {app.signatureFailures} delivery(ies) failed the signature check
          {app.lastSignatureFailureAt
            ? `, the last ${formatAgo(app.lastSignatureFailureAt)}`
            : ''}
          . The webhook secret here and on GitHub may differ.
        </Banner>
      ) : null}

      <Card pad="lg">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{app.slug}</h2>
          <div className="flex flex-wrap gap-3">
            <a
              href={app.installUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex"
            >
              <Button variant="solid" tabIndex={-1}>
                Install on GitHub
              </Button>
            </a>
            <Button variant="glass" disabled={busy} onClick={onResync}>
              Resync
            </Button>
            <Button variant="danger" disabled={busy} onClick={onDelete}>
              Remove
            </Button>
          </div>
        </div>
        <dl className="grid max-w-xl grid-cols-[11rem_1fr] gap-y-2 text-sm">
          <dt className="text-ink-3">App</dt>
          <dd>
            <a
              href={app.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {app.slug}
            </a>{' '}
            <span className="text-ink-3">
              (ID {app.appId}, owner {app.ownerLogin})
            </span>
          </dd>
          <dt className="text-ink-3">Webhook</dt>
          <dd>
            <Badge
              tone={app.hookActive ? 'ok' : 'warn'}
              label={app.hookActive ? 'active' : 'inactive'}
            />
          </dd>
          <dt className="text-ink-3">Hook reachable</dt>
          <dd>
            {app.hookCheckOk === null ? (
              '—'
            ) : (
              <Badge
                tone={app.hookCheckOk ? 'ok' : 'danger'}
                label={app.hookCheckOk ? 'yes' : 'no'}
              />
            )}{' '}
            <span className="text-xs text-ink-3">
              checked {when(app.hookCheckedAt)}
            </span>
          </dd>
          <dt className="text-ink-3">Last delivery</dt>
          <dd>{when(app.lastDeliveryAt)}</dd>
          <dt className="text-ink-3">Signature failures</dt>
          <dd>{app.signatureFailures}</dd>
          <dt className="text-ink-3">Credentials</dt>
          <dd className="text-ink-2">Stored encrypted; never shown.</dd>
        </dl>
      </Card>

      <h2 className="text-lg font-bold">Installations</h2>
      {app.installations.length === 0 ? (
        <EmptyState
          title="Not installed anywhere"
          description="Install the App on the account that owns your repositories, then resync."
        />
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>Account</TableCell>
              <TableCell head>Repositories</TableCell>
              <TableCell head>Projects</TableCell>
              <TableCell head>Synced</TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {app.installations.map((installation) => (
              <TableRow key={installation.id}>
                <TableCell>
                  <span className="font-medium">
                    {installation.accountLogin}
                  </span>
                  <div className="text-xs text-ink-3">
                    {installation.accountType}
                  </div>
                  {installation.suspended ? (
                    <Badge tone="danger" label="suspended" />
                  ) : null}
                </TableCell>
                <TableCell>
                  {installation.repos.length === 0 ? (
                    '—'
                  ) : (
                    <ul className="font-mono text-sm">
                      {installation.repos.map((repo) => (
                        <li key={repo.fullName}>{repo.fullName}</li>
                      ))}
                    </ul>
                  )}
                </TableCell>
                <TableCell>
                  {installation.repos.flatMap((repo) => repo.projects)
                    .length === 0 ? (
                    '—'
                  ) : (
                    <ul className="text-sm">
                      {installation.repos
                        .flatMap((repo) => repo.projects)
                        .map((project) => (
                          <li key={project.id}>{project.displayName}</li>
                        ))}
                    </ul>
                  )}
                </TableCell>
                <TableCell>{formatAgo(installation.syncedAt)}</TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
