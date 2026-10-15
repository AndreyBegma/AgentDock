'use client';

import type {
  AdminRunner,
  AdminRunnerDetail,
  PairingCodeResponse,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import { api } from '../../../lib/api';
import { pluralize } from '../../../lib/format';
import { Time } from '../../../lib/format/time';
import {
  capabilitySummary,
  describeRunnerError,
  formatLoad,
  LOAD_LABEL,
  profilesSummary,
  runnerRemedy,
  STATUS_TONE,
  statusLabel,
} from '../../../lib/runners/format';
import { ADD_RUNNER_PARAM, INSTALL_PATH } from '../../../lib/runners/install';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';
import { PairingDialog } from './pairing-dialog';
import { RunnerSheet } from './runner-sheet';

/** The page polls; live updates over WebSocket come with M1.8 (spec). */
const POLL_MS = 10_000;

function AddRunnerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: PairingCodeResponse) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      onCreated(
        await api<PairingCodeResponse>('/admin/runners', {
          method: 'POST',
          body: { name: trimmed },
        }),
      );
    } catch (err) {
      showError(describeRunnerError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title="Add runner"
        description="Name the machine. You get a one-time pairing code to run on it."
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="solid"
              type="submit"
              form="add-runner"
              disabled={busy || !name.trim()}
            >
              Create
            </Button>
          </>
        }
      >
        <form id="add-runner" onSubmit={submit}>
          <Field label="Name" htmlFor="add-runner-name" required>
            <Input
              id="add-runner-name"
              value={name}
              maxLength={100}
              placeholder="e.g. build-box"
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

/** Status, and for a runner that is not online, the next step under it. */
function StatusCell({ runner }: { runner: AdminRunner }) {
  const remedy = runnerRemedy(runner);
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-2">
        <Badge dot tone={STATUS_TONE[runner.status]} aria-hidden="true" />
        {statusLabel(runner.status, runner.pairedAt, runner.lastSeenAt)}
      </span>
      {remedy ? (
        <span className="text-xs text-ink-2">
          {remedy.text}
          {remedy.command ? (
            <code className="ml-1 font-mono text-ink">{remedy.command}</code>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

const DETAIL_LIMIT = 20;

/** Profiles, capabilities and load live on the detail; the list has a count. */
function useRunnerDetails(runners: AdminRunner[] | undefined) {
  const [details, setDetails] = useState<Record<string, AdminRunnerDetail>>({});
  const ids = (runners ?? [])
    .filter((runner) => runner.status !== 'revoked')
    .slice(0, DETAIL_LIMIT)
    .map((runner) => runner.id)
    .join(',');
  // Each poll that changed something also refreshes what is shown inline.
  const stamp = (runners ?? []).map((runner) => runner.lastSeenAt).join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` re-fetches after a poll that changed something
  useEffect(() => {
    if (!ids) return;
    let current = true;
    for (const id of ids.split(',')) {
      api<AdminRunnerDetail>(`/admin/runners/${id}`)
        .then((detail) => {
          if (current) setDetails((all) => ({ ...all, [id]: detail }));
        })
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  }, [ids, stamp]);

  return details;
}

function RunnerRows({
  runners,
  details,
  onDetails,
}: {
  runners: AdminRunner[];
  details: Record<string, AdminRunnerDetail>;
  onDetails: (id: string) => void;
}) {
  const columns: Column<AdminRunner>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: (runner) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{runner.name}</span>
          <span className="truncate text-xs text-ink-3">
            {[runner.hostname, runner.version && `v${runner.version}`]
              .filter(Boolean)
              .join(' · ') || '—'}
          </span>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (runner) => <StatusCell runner={runner} />,
    },
    {
      id: 'profiles',
      header: 'Profiles',
      cell: (runner) => {
        const detail = details[runner.id];
        const summary = detail ? profilesSummary(detail.profiles) : '';
        return (
          <div className="flex min-w-0 flex-col">
            <span className="truncate">
              {summary || (runner.profilesCount === 0 ? '—' : '…')}
            </span>
            <span className="text-xs text-ink-3">
              {pluralize(runner.profilesCount, 'profile')}
            </span>
          </div>
        );
      },
    },
    {
      id: 'capabilities',
      header: 'Capabilities',
      cell: (runner) => {
        const capabilities = details[runner.id]?.capabilities;
        return (
          <span className="truncate">
            {capabilities ? capabilitySummary(capabilities) || '—' : '—'}
          </span>
        );
      },
    },
    {
      id: 'load',
      header: <span title={LOAD_LABEL}>Load</span>,
      align: 'end',
      cell: (runner) => {
        const heartbeat = details[runner.id]?.heartbeat;
        return heartbeat ? (
          <span className="num" title={LOAD_LABEL}>
            {formatLoad(heartbeat.load)}
          </span>
        ) : (
          '—'
        );
      },
    },
    {
      id: 'lastSeen',
      header: 'Last seen',
      cell: (runner) => <Time value={runner.lastSeenAt} fallback="never" />,
    },
  ];

  return (
    <DataTable
      rows={runners}
      columns={columns}
      getRowId={(runner) => runner.id}
      onRowActivate={(runner) => onDetails(runner.id)}
      stickyHeader={false}
      rowHeight={64}
    />
  );
}

function RunnersTable() {
  const section = useSection(() => api<AdminRunner[]>('/admin/runners'), []);
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<PairingCodeResponse | null>(null);
  const [selected, setSelected] = useState<string>();
  const showError = useErrorToast();
  const router = useRouter();
  const pathname = usePathname();

  const details = useRunnerDetails(section.data);
  const load = section.retry;
  useEffect(() => {
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get(ADD_RUNNER_PARAM) === null) return;
    setAdding(true);
    params.delete(ADD_RUNNER_PARAM);
    const rest = params.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname);
  }, [pathname, router]);

  // The pairing dialog follows its runner through this page's poll.
  const pairingRunner = pairing
    ? section.data?.find((runner) => runner.id === pairing.runner.id)
    : undefined;

  const showCode = (result: PairingCodeResponse) => {
    setAdding(false);
    setPairing(result);
    load();
  };

  // Called from the pairing dialog once its code has expired.
  const reissue = async (runnerId: string) => {
    try {
      showCode(
        await api<PairingCodeResponse>(
          `/admin/runners/${runnerId}/pairing-code`,
          { method: 'POST' },
        ),
      );
    } catch (err) {
      showError(describeRunnerError(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Runners"
        description="The AgentDock daemon on each machine that holds your repositories."
        actions={
          <Button variant="solid" onClick={() => setAdding(true)}>
            Add runner
          </Button>
        }
      />

      <AsyncSection
        section={section}
        unavailable={{ title: 'Runners are not answering' }}
        empty={
          <EmptyState
            title="Pair your first runner"
            description="A runner is the AgentDock daemon on the machine that holds your repositories: it runs the agents and reads the code, and it dials out to AgentDock, so the machine needs no open port. Add one to get a pairing command to run there."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="solid"
                  size="sm"
                  onClick={() => setAdding(true)}
                >
                  Add runner
                </Button>
                <Link
                  href={INSTALL_PATH}
                  className={buttonClassName({ variant: 'glass', size: 'sm' })}
                >
                  How to install the runner
                </Link>
              </div>
            }
          />
        }
      >
        {(runners) => (
          <ScrollX>
            <RunnerRows
              runners={runners}
              details={details}
              onDetails={setSelected}
            />
          </ScrollX>
        )}
      </AsyncSection>

      <AddRunnerDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={showCode}
      />
      <PairingDialog
        result={pairing}
        runner={pairingRunner}
        onClose={() => setPairing(null)}
        onNewCode={reissue}
      />
      <RunnerSheet
        runnerId={selected}
        onClose={() => setSelected(undefined)}
        onChanged={load}
        onPairing={setPairing}
      />
    </>
  );
}

export default function AdminRunnersPage() {
  return <RunnersTable />;
}
