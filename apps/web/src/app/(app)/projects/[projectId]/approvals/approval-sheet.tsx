'use client';

import type { ApprovalDetail } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Disclosure } from 'glass-ui/disclosure';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Skeleton } from 'glass-ui/skeleton';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  deciderLabel,
  describeApprovalError,
  formatDiffStat,
  SOURCE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
} from '../../../../../lib/approvals/format';
import { formatAgo } from '../../../../../lib/fleet/format';
import { safeHttpsUrl } from '../../../../../lib/queue/format';
import { ApproveDialog, RequestChangesDialog } from './decision-dialogs';

const CHECK_TONE = { pass: 'ok', wait: 'warn', fail: 'danger' } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function Detail({
  projectId,
  detail,
  canOperate,
  onChanged,
}: {
  projectId: string;
  detail: ApprovalDetail;
  canOperate: boolean;
  onChanged: () => void;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const inspection = detail.inspection;
  const href = safeHttpsUrl(inspection?.url ?? detail.url);

  const waiting = detail.status === 'waiting';
  const decidable =
    waiting && inspection !== null && inspection.state === 'open';

  return (
    <dl className="flex flex-col gap-4">
      <Row label="Status">
        <span className="flex flex-wrap items-center gap-2">
          <Badge
            tone={STATUS_TONE[detail.status]}
            label={STATUS_LABEL[detail.status]}
          />
          <span className="text-xs text-ink-2">
            {SOURCE_LABEL[detail.source]}
            {detail.source === 'derived' ? ' (derived by AgentDock)' : ''} ·
            waiting {formatAgo(detail.waitingSince)}
          </span>
        </span>
      </Row>

      {canOperate && waiting ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button disabled={!decidable} onClick={() => setApproving(true)}>
              Approve
            </Button>
            <Button
              variant="glass"
              disabled={!decidable}
              onClick={() => setRequesting(true)}
            >
              Request changes
            </Button>
          </div>
          {decidable ? null : (
            <span className="text-xs text-ink-2">
              {inspection
                ? 'The pull request is no longer open on GitHub.'
                : 'Decisions are disabled until the runner inspects the pull request: the decision binds to the head commit it reports.'}
            </span>
          )}
        </div>
      ) : null}

      {detail.inspectionError ? (
        <Banner tone="warn" title="The pull request could not be inspected">
          {detail.inspectionError.message}
        </Banner>
      ) : null}

      <Row label="Merge summary">
        {detail.summary ? (
          <pre className="whitespace-pre-wrap rounded-control bg-surface p-3 font-sans text-sm">
            {detail.summary}
          </pre>
        ) : (
          <span className="text-ink-2">no summary written</span>
        )}
      </Row>

      <Row label="Head commit">
        {inspection ? (
          <code className="font-mono text-xs">{inspection.headSha}</code>
        ) : (
          (detail.headSha ?? '—')
        )}
      </Row>

      {inspection ? (
        <>
          <Row label="Diff">
            {formatDiffStat(inspection.additions, inspection.deletions)} in{' '}
            {inspection.changedFiles} file
            {inspection.changedFiles === 1 ? '' : 's'} · mergeable{' '}
            {inspection.mergeable.toLowerCase()} (
            {inspection.mergeStateStatus.toLowerCase()})
          </Row>
          <Row label="Checks">
            {inspection.checkList.length === 0 ? (
              '—'
            ) : (
              <ul className="flex flex-col gap-1">
                {inspection.checkList.map((check) => {
                  const link = safeHttpsUrl(check.url ?? null);
                  return (
                    <li
                      key={`${check.name}/${check.state}`}
                      className="flex items-center gap-2"
                    >
                      <Badge dot tone={CHECK_TONE[check.state]} aria-hidden />
                      {link ? (
                        <a
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          className="underline-offset-2 hover:underline"
                        >
                          {check.name}
                        </a>
                      ) : (
                        check.name
                      )}
                      <span className="text-xs text-ink-3">{check.state}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Row>
          <Disclosure
            open={filesOpen}
            onOpenChange={setFilesOpen}
            trigger={`Changed files (${inspection.changedFiles})`}
          >
            <ul className="flex flex-col gap-1 px-4 pb-3 font-mono text-xs">
              {inspection.files.map((file) => (
                <li key={file.path} className="flex justify-between gap-3">
                  <span className="break-all">{file.path}</span>
                  <span className="shrink-0 text-ink-2">
                    {formatDiffStat(file.additions, file.deletions)}
                  </span>
                </li>
              ))}
              {inspection.filesTruncated ? (
                <li className="text-ink-3">
                  Only the first {inspection.files.length} files are listed.
                </li>
              ) : null}
            </ul>
          </Disclosure>
        </>
      ) : null}

      {detail.status !== 'waiting' ? (
        <Row label="Decision">
          {deciderLabel(detail)}
          {detail.decidedAt ? `, ${formatAgo(detail.decidedAt)}` : ''}
          {detail.note ? (
            <pre className="mt-1 whitespace-pre-wrap rounded-control bg-surface p-3 font-sans text-sm">
              {detail.note}
            </pre>
          ) : null}
        </Row>
      ) : null}

      {detail.history.length > 0 ? (
        <Row label="Earlier decisions on this pull request">
          <ol className="flex flex-col gap-1">
            {detail.history.map((entry) => (
              <li key={entry.id} className="text-xs text-ink-2">
                {STATUS_LABEL[entry.status]}
                {entry.decidedBy ? ` by ${deciderLabel(entry)}` : ''} ·{' '}
                {formatAgo(entry.updatedAt)}
                {entry.note ? ` — ${entry.note}` : ''}
              </li>
            ))}
          </ol>
        </Row>
      ) : null}

      {href ? (
        <Row label="On GitHub">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {href}
          </a>
        </Row>
      ) : null}

      {inspection ? (
        <>
          <ApproveDialog
            projectId={projectId}
            pr={detail.pr}
            headSha={inspection.headSha}
            open={approving}
            onOpenChange={setApproving}
            onChanged={onChanged}
          />
          <RequestChangesDialog
            projectId={projectId}
            pr={detail.pr}
            headSha={inspection.headSha}
            open={requesting}
            onOpenChange={setRequesting}
            onChanged={onChanged}
          />
        </>
      ) : null}
    </dl>
  );
}

/** The latest detail for PR `pr`, refetched when `version` changes (a live push). */
export function ApprovalSheet({
  projectId,
  pr,
  title,
  canOperate,
  version,
  onClose,
  onChanged,
}: {
  projectId: string;
  pr: number | undefined;
  title: string | null | undefined;
  canOperate: boolean;
  version: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ApprovalDetail>();
  const [error, setError] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    if (pr === undefined) return;
    let cancelled = false;
    api<ApprovalDetail>(`/projects/${projectId}/approvals/${pr}`)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeApprovalError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, pr, version]);

  const close = () => {
    setDetail(undefined);
    setError(undefined);
    onClose();
  };

  return (
    <SheetRoot
      open={pr !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {pr !== undefined ? (
        <SheetContent
          side="right"
          title={`#${pr} ${title ?? ''}`.trim()}
          description="Merge approval"
        >
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : detail && detail.pr === pr ? (
            <Detail
              projectId={projectId}
              detail={detail}
              canOperate={canOperate}
              onChanged={onChanged}
            />
          ) : (
            <Skeleton className="h-64 w-full" />
          )}
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}
