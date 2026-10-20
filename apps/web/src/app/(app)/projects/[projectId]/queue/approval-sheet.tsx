'use client';

import type { ApprovalDetail } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { DisabledReason } from '../../../../../components/prerequisites/disabled-reason';
import { api } from '../../../../../lib/api';
import {
  deciderLabel,
  decisionDisabledReason,
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

/**
 * Approve and Request changes on a waiting pull request, with their dialogs.
 * Nothing for a viewer or a decided row. In a sheet it is the pinned footer, so
 * on a phone the decision stays under the thumb however long the detail is.
 */
function PrDecision({
  projectId,
  runnerName,
  detail,
  canOperate,
  onChanged,
  className,
}: {
  projectId: string;
  runnerName?: string | null;
  detail: ApprovalDetail;
  canOperate: boolean;
  onChanged: () => void;
  className?: string;
}) {
  const [approving, setApproving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const inspection = detail.inspection;
  const decisionReason = decisionDisabledReason(inspection, runnerName);
  const decidable = decisionReason === null;

  if (!canOperate || detail.status !== 'waiting' || !inspection) return null;
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      <div className="flex gap-2">
        <Button
          variant="glass"
          className="max-tablet:min-h-11 max-tablet:flex-1"
          disabled={!decidable}
          onClick={() => setRequesting(true)}
        >
          Request changes
        </Button>
        <Button
          variant="glass"
          className="max-tablet:min-h-11 max-tablet:flex-1"
          disabled={!decidable}
          onClick={() => setApproving(true)}
        >
          <Check aria-hidden="true" className="size-4" />
          Approve
        </Button>
      </div>
      {decisionReason ? (
        <DisabledReason>{decisionReason}</DisabledReason>
      ) : null}
      <ApproveDialog
        projectId={projectId}
        runnerName={runnerName}
        pr={detail.pr}
        headSha={inspection.headSha}
        open={approving}
        onOpenChange={setApproving}
        onChanged={onChanged}
      />
      <RequestChangesDialog
        projectId={projectId}
        runnerName={runnerName}
        pr={detail.pr}
        headSha={inspection.headSha}
        open={requesting}
        onOpenChange={setRequesting}
        onChanged={onChanged}
      />
    </div>
  );
}

/** What the decision is based on: the PR's status, summary, commits and checks. */
function Detail({ detail }: { detail: ApprovalDetail }) {
  const [filesOpen, setFilesOpen] = useState(false);
  const inspection = detail.inspection;
  const href = safeHttpsUrl(inspection?.url ?? detail.url);

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
            {detail.source === 'derived' ? ' (inferred by Nautelle)' : ''} ·
            waiting {formatAgo(detail.waitingSince)}
          </span>
        </span>
      </Row>

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
    </dl>
  );
}

/** The latest detail for PR `pr`, refetched when `version` changes (a live push). */
function useApprovalDetail(
  projectId: string,
  pr: number | undefined,
  version: number,
  runnerName: string | null | undefined,
) {
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
        if (!cancelled) setError(describeApprovalError(err, runnerName));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, pr, version, runnerName]);

  const reset = () => {
    setDetail(undefined);
    setError(undefined);
  };
  // A detail of the previously shown PR is never drawn under this one's title.
  const current = detail && detail.pr === pr ? detail : undefined;
  return { detail: current, error, reset };
}

interface ApprovalViewProps {
  projectId: string;
  /** The project's runner, named when a decision needs it. */
  runnerName?: string | null;
  pr: number | undefined;
  title: string | null | undefined;
  canOperate: boolean;
  version: number;
  onChanged: () => void;
}

function DetailError({ error }: { error: string }) {
  return (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  );
}

/**
 * A pull request's merge approval in the page, beside the Approvals list from
 * tablet up (C-284): the decision first, then what it is based on.
 */
export function ApprovalPane({
  projectId,
  runnerName,
  pr,
  title,
  canOperate,
  version,
  onChanged,
}: ApprovalViewProps) {
  const { detail, error } = useApprovalDetail(
    projectId,
    pr,
    version,
    runnerName,
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-ink-2">Merge approval</p>
        <h3 className="text-base font-semibold break-words">
          {`#${pr} ${title ?? ''}`.trim()}
        </h3>
      </div>
      {error ? (
        <DetailError error={error} />
      ) : detail ? (
        <>
          <PrDecision
            projectId={projectId}
            runnerName={runnerName}
            detail={detail}
            canOperate={canOperate}
            onChanged={onChanged}
          />
          <Detail detail={detail} />
        </>
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </div>
  );
}

/**
 * A pull request's merge approval in a sheet: from the right, or from the
 * bottom on a phone with the decision pinned in its footer.
 */
export function ApprovalSheet({
  side = 'right',
  onClose,
  ...props
}: ApprovalViewProps & { side?: 'right' | 'bottom'; onClose: () => void }) {
  const { projectId, runnerName, pr, title, canOperate, version, onChanged } =
    props;
  const { detail, error, reset } = useApprovalDetail(
    projectId,
    pr,
    version,
    runnerName,
  );

  const close = () => {
    reset();
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
          side={side}
          title={`#${pr} ${title ?? ''}`.trim()}
          description="Merge approval"
          footer={
            detail ? (
              <PrDecision
                projectId={projectId}
                runnerName={runnerName}
                detail={detail}
                canOperate={canOperate}
                onChanged={onChanged}
              />
            ) : undefined
          }
        >
          {error ? (
            <DetailError error={error} />
          ) : detail ? (
            <Detail detail={detail} />
          ) : (
            <Skeleton className="h-64 w-full" />
          )}
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}
