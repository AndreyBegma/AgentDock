'use client';

import type { GitHubAppView, GitHubResyncResult } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useEffect, useState } from 'react';
import { PageHeader } from '../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../components/prerequisites/async-section';
import { PrerequisiteBanner } from '../../../../components/prerequisites/prerequisite-banner';
import { api } from '../../../../lib/api';
import { Time } from '../../../../lib/format/time';
import {
  describeCallbackError,
  describeGitHubAppError,
  githubAppDeliveriesUrl,
} from '../../../../lib/github-app/format';
import {
  ENCRYPTION_KEY_REMEDY,
  PUBLIC_URL_REMEDY,
} from '../../../../lib/prerequisites/copy';
import { useSection } from '../../../../lib/section/use-section';
import { ManualCard, RegisterCard } from './register-cards';

type Registered = Extract<GitHubAppView, { registered: true }>;

const when = (iso: string | null) => <Time value={iso} />;

/** Rule R4: without a key nothing can be stored, or a stored App opened. */
function NoKeyBanner({ registered }: { registered: boolean }) {
  return (
    <PrerequisiteBanner
      tone={registered ? 'danger' : 'warn'}
      title="No APP_ENCRYPTION_KEY on the server"
      body={
        registered
          ? `The App’s stored secrets cannot be opened, so deliveries fail their signature check and AgentDock cannot call GitHub. ${ENCRYPTION_KEY_REMEDY} Use the key the App was registered with.`
          : `Both ways to register below stay off: the App’s secrets are stored encrypted. ${ENCRYPTION_KEY_REMEDY}`
      }
    />
  );
}

export default function GitHubAppPage() {
  const section = useSection(() => api<GitHubAppView>('/admin/github-app'), []);
  const view = section.data;
  const load = section.retry;
  const [callbackError, setCallbackError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      load();
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
      load();
    } catch (err) {
      toast.error(describeGitHubAppError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="GitHub App"
        description="A read-only App that tells AgentDock the moment an issue, pull request or check changes. Without it everything still works — runners poll GitHub every 60 s."
      />

      {callbackError ? (
        <Banner tone="danger" title="Registration failed">
          {callbackError}
        </Banner>
      ) : null}

      {view && !view.encryptionAvailable ? (
        <NoKeyBanner registered={view.registered} />
      ) : null}

      <AsyncSection
        section={section}
        unavailable={{
          title: 'The GitHub App settings are not answering',
          stillWorks: 'Runners keep polling GitHub every 60 s meanwhile.',
        }}
        isEmpty={() => false}
        empty={null}
        skeleton={<Skeleton className="h-48 w-full" />}
      >
        {(loaded) =>
          loaded.registered ? (
            <AppDetails
              app={loaded}
              busy={busy}
              onResync={() => void resync()}
              onDelete={() => setConfirmDelete(true)}
            />
          ) : (
            <>
              <RegisterCard view={loaded} />
              <ManualCard view={loaded} onSaved={load} />
            </>
          )
        }
      </AsyncSection>

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

/** GitHub's Recent deliveries list for this App: why each delivery failed. */
function DeliveriesLink({ app }: { app: Registered }) {
  return (
    <a
      href={githubAppDeliveriesUrl(app)}
      target="_blank"
      rel="noreferrer"
      className={buttonClassName({ variant: 'glass', size: 'sm' })}
    >
      Recent deliveries on GitHub
    </a>
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
      {app.hookActive ? null : app.publicUrl ? (
        <Banner
          tone="warn"
          title="Webhook inactive"
          action={<DeliveriesLink app={app} />}
        >
          The App was registered before PUBLIC_URL was set, so its webhook on
          GitHub is off. Remove the App here and register it again to turn it
          on. Runners keep polling every 60 s meanwhile.
        </Banner>
      ) : (
        <Banner tone="warn" title="Webhook inactive">
          No PUBLIC_URL is configured, so GitHub cannot reach this server.
          Runners keep polling every 60 s. {PUBLIC_URL_REMEDY} Then remove the
          App here and register it again.
        </Banner>
      )}
      {app.hookActive && app.hookCheckOk === false ? (
        <Banner
          tone="warn"
          title="GitHub cannot deliver to this server"
          action={<DeliveriesLink app={app} />}
        >
          The last resync found failed deliveries. GitHub’s Recent deliveries
          list shows why each one failed — usually PUBLIC_URL is not reachable
          from the internet. Runners keep polling every 60 s meanwhile.
        </Banner>
      ) : null}
      {app.signatureFailures > 0 ? (
        <Banner tone="warn" title="Signature failures">
          {app.signatureFailures} delivery(ies) failed the signature check
          {app.lastSignatureFailureAt ? (
            <>
              , the last <Time value={app.lastSignatureFailureAt} />
            </>
          ) : null}
          . The webhook secret here and on GitHub may differ: set a new secret
          on GitHub, then remove the App here and enter its credentials by hand
          with that secret.
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
              className="text-accent-ink underline"
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
          action={
            <a
              href={app.installUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClassName({ variant: 'solid', size: 'sm' })}
            >
              Install on GitHub
            </a>
          }
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
                <TableCell>
                  <Time value={installation.syncedAt} />
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
