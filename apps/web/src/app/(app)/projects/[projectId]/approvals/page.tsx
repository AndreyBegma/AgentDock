'use client';

import {
  APPROVALS_LIVE_EVENT,
  type ApprovalItemView,
  type ApprovalsView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { Tab, TabGroup, TabList, TabPanel } from '@andrewbehma/glass-ui/tabs';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ActionRequestsPanel } from '../../../../../components/approvals/action-requests-panel';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { LiveStatusBadge } from '../../../../../components/shell/live-status-badge';
import { api } from '../../../../../lib/api';
import {
  APPROVAL_TABS,
  type ApprovalTab,
  pendingRequests,
} from '../../../../../lib/approvals/action-requests';
import {
  approvalSettingsHref,
  deciderLabel,
  emptyWaitingCopy,
  isNotFound,
  mismatchSentence,
  SOURCE_LABEL,
  SOURCE_TOOLTIP,
  STATUS_LABEL,
  STATUS_TONE,
} from '../../../../../lib/approvals/format';
import { useActionRequests } from '../../../../../lib/approvals/use-action-requests';
import { CHECKS_LABEL, CHECKS_TONE } from '../../../../../lib/fleet/format';
import { Time } from '../../../../../lib/format/time';
import { useLive } from '../../../../../lib/live/use-live';
import { useTabParam } from '../../../../../lib/projects/use-tab-param';
import { safeHttpsUrl } from '../../../../../lib/queue/format';
import { useSection } from '../../../../../lib/section/use-section';
import { useProjectDetail } from '../use-project-detail';
import { ApprovalSheet } from './approval-sheet';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** "Waiting 3 min" is relative to now. */
const AGE_TICK_MS = 30_000;

function PrLink({ item }: { item: ApprovalItemView }) {
  const href = safeHttpsUrl(item.url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline-offset-2 hover:underline"
    >
      #{item.pr}
    </a>
  ) : (
    <>#{item.pr}</>
  );
}

function SourceBadge({ item }: { item: ApprovalItemView }) {
  return (
    <Tooltip content={SOURCE_TOOLTIP[item.source]}>
      <span className="inline-flex">
        <Badge
          tone={item.source === 'derived' ? 'neutral' : 'ok'}
          label={SOURCE_LABEL[item.source]}
        />
      </span>
    </Tooltip>
  );
}

function ChecksCell({ item }: { item: ApprovalItemView }) {
  if (!item.checks) return <>—</>;
  const label = CHECKS_LABEL[item.checks];
  return (
    <span className="inline-flex items-center gap-2">
      <Badge dot tone={CHECKS_TONE[item.checks]} aria-hidden="true" />
      {label}
    </span>
  );
}

function ActionCell({
  item,
  onSelect,
}: {
  item: ApprovalItemView;
  onSelect: (item: ApprovalItemView) => void;
}) {
  return (
    <div className="flex justify-end">
      <Button
        variant="glass"
        size="sm"
        aria-label={`Details for pull request ${item.pr}`}
        onClick={() => onSelect(item)}
      >
        Details
      </Button>
    </div>
  );
}

export default function ApprovalsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  /** Bumped by a live push; the approvals and the sheet depend on it. */
  const [version, setVersion] = useState(0);
  const [, setNow] = useState(0);
  const [selected, setSelected] = useState<ApprovalItemView>();

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== APPROVALS_LIVE_EVENT) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // The role gates the buttons; the API stays the authority (403 on a viewer).
  const project = useProjectDetail(projectId).data;
  const canOperate = project !== undefined && project.role !== 'viewer';

  const approvals = useSection(
    () => api<ApprovalsView>(`/projects/${projectId}/approvals`),
    [projectId, version],
  );

  const actionRequests = useActionRequests(projectId);
  const [tab, setTab] = useTabParam(APPROVAL_TABS);

  if (approvals.data === undefined && isNotFound(approvals.error)) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
        action={
          <Link href="/projects" className="text-sm text-accent-ink underline">
            Open Projects
          </Link>
        }
      />
    );
  }

  const pendingActions = actionRequests.data
    ? pendingRequests(actionRequests.data).length
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <PageHeader
          className="mb-0"
          title="Approvals"
          description="Pull requests that wait for a person before the orchestrator merges them, and what Claude Code sessions ask you to decide. AgentDock never merges itself."
          actions={<LiveStatusBadge />}
        />
        {project ? <RunnerOfflineBanner project={project} /> : null}
      </div>

      <TabGroup
        value={tab}
        onValueChange={(next) => setTab(next as ApprovalTab)}
      >
        <TabList aria-label="Approvals">
          <Tab value="pull-requests">Pull requests</Tab>
          <Tab value="action-requests">
            <span className="inline-flex items-center gap-2">
              Action requests
              {pendingActions > 0 ? (
                <Badge
                  tone="warn"
                  label={String(pendingActions)}
                  aria-label={`${pendingActions} waiting`}
                />
              ) : null}
            </span>
          </Tab>
        </TabList>

        <TabPanel value="pull-requests" className="pt-6">
          <AsyncSection
            section={approvals}
            unavailable={{
              title: 'Approvals could not be loaded',
              stillWorks:
                'Nothing was decided. Fleet and queue are still available.',
            }}
            empty={null}
            isEmpty={() => false}
          >
            {(view) => (
              <ApprovalsBody
                view={view}
                projectId={projectId}
                onSelect={setSelected}
              />
            )}
          </AsyncSection>
        </TabPanel>

        <TabPanel value="action-requests" className="pt-6">
          <AsyncSection
            section={actionRequests}
            unavailable={{
              title: 'Action requests could not be loaded',
              stillWorks:
                'Nothing was decided. Pull request approvals are still available.',
            }}
            empty={null}
            isEmpty={() => false}
          >
            {(rows) => (
              <ActionRequestsPanel
                projectId={projectId}
                rows={rows}
                canOperate={canOperate}
                onChanged={actionRequests.retry}
              />
            )}
          </AsyncSection>
        </TabPanel>
      </TabGroup>

      <ApprovalSheet
        projectId={projectId}
        runnerName={project?.runnerName}
        pr={selected?.pr}
        title={selected?.title}
        canOperate={canOperate}
        version={version}
        onClose={() => setSelected(undefined)}
        onChanged={() => setVersion((v) => v + 1)}
      />
    </div>
  );
}

function ApprovalsBody({
  view,
  projectId,
  onSelect: setSelected,
}: {
  view: ApprovalsView;
  projectId: string;
  onSelect: (item: ApprovalItemView) => void;
}) {
  const mismatch = mismatchSentence(view.mergeApproval, view.configMismatch);
  const empty = emptyWaitingCopy(view.mergeApproval.agentdock);
  const settingsLink = (
    <Link
      href={approvalSettingsHref(projectId)}
      className={buttonClassName({ variant: 'glass', size: 'sm' })}
    >
      Open Settings
    </Link>
  );
  return (
    <>
      {mismatch ? (
        <Banner
          tone="warn"
          title="Merge approval settings disagree"
          action={settingsLink}
        >
          {mismatch}
        </Banner>
      ) : null}

      {view.waiting.length === 0 ? (
        <EmptyState
          title={empty.title}
          description={empty.description}
          action={view.mergeApproval.agentdock ? undefined : settingsLink}
        />
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>PR</TableCell>
              <TableCell head>Title</TableCell>
              <TableCell head>Slot</TableCell>
              <TableCell head>Checks</TableCell>
              <TableCell head>Waiting</TableCell>
              <TableCell head>Source</TableCell>
              <TableCell head>
                <span className="sr-only">Details</span>
              </TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {view.waiting.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <PrLink item={item} />
                </TableCell>
                <TableCell>
                  <span className="font-medium">{item.title ?? '—'}</span>
                  {item.issue !== null ? (
                    <span className="block text-xs text-ink-3">
                      issue #{item.issue}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{item.slot ?? '—'}</TableCell>
                <TableCell>
                  <ChecksCell item={item} />
                </TableCell>
                <TableCell>
                  <Time value={item.waitingSince} />
                </TableCell>
                <TableCell>
                  <SourceBadge item={item} />
                </TableCell>
                <TableCell>
                  <ActionCell item={item} onSelect={setSelected} />
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

      {view.recent.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Recent decisions</h2>
          <Table scroll>
            <TableHead>
              <TableRow>
                <TableCell head>PR</TableCell>
                <TableCell head>Decision</TableCell>
                <TableCell head>By</TableCell>
                <TableCell head>When</TableCell>
                <TableCell head>Note</TableCell>
                <TableCell head>
                  <span className="sr-only">Details</span>
                </TableCell>
              </TableRow>
            </TableHead>
            <tbody>
              {view.recent.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <PrLink item={item} />
                    {item.title ? (
                      <span className="block text-xs text-ink-3">
                        {item.title}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge
                      tone={STATUS_TONE[item.status]}
                      label={STATUS_LABEL[item.status]}
                    />
                  </TableCell>
                  <TableCell>{deciderLabel(item)}</TableCell>
                  <TableCell>
                    <Time value={item.decidedAt ?? item.updatedAt} />
                  </TableCell>
                  <TableCell>
                    <span className="line-clamp-2 break-words">
                      {item.note ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ActionCell item={item} onSelect={setSelected} />
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}
    </>
  );
}
