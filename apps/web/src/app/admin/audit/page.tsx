'use client';

import {
  type AdminRunner,
  type AdminUser,
  type AuditPage,
  type AuditRecordView,
  type AuditVerification,
  type AuditVerificationState,
  type ProjectSummary,
  USER_STATUSES,
  type WebhookView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import { ApiError, api } from '../../../lib/api';
import { actionLabel, RESULT_LABEL } from '../../../lib/audit/actions';
import {
  actorLabel,
  brokenChainCopy,
  describeAuditError,
  describeVerification,
  EMPTY_FILTERS,
  filtersQuery,
  hasFilters,
  RESULT_TONE,
  toFilters,
} from '../../../lib/audit/format';
import {
  buildNameIndex,
  type NameIndex,
  targetDisplay,
} from '../../../lib/audit/targets';
import { useUrlFilters } from '../../../lib/filters/use-url-filters';
import { Time } from '../../../lib/format/time';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { AuditFilters } from './audit-filters';
import { AUDIT_FILTER_CODEC } from './filters';
import { RecordSheet } from './record-sheet';

const PAGE_SIZE = 50;

function ChainStatus({
  verification,
  exportHref,
  onVerified,
}: {
  verification: AuditVerification | null | undefined;
  exportHref: string;
  onVerified: (v: AuditVerification) => void;
}) {
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const verify = async () => {
    setBusy(true);
    try {
      const result = await api<AuditVerification>('/admin/audit/verification', {
        method: 'POST',
      });
      onVerified(result);
      if (result.ok) toast.success('The chain is intact.');
      else showError(`The chain is broken at record ${result.firstBrokenSeq}.`);
    } catch (err) {
      showError(describeAuditError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {verification && !verification.ok ? (
        <Banner
          tone="danger"
          title="The audit chain is broken"
          action={
            <a
              href={exportHref}
              download
              className={buttonClassName({ variant: 'glass', size: 'sm' })}
            >
              Export CSV
            </a>
          }
        >
          {brokenChainCopy(verification)}
        </Banner>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {verification === undefined ? (
          <Skeleton className="h-6 w-64" />
        ) : verification === null ? (
          <Badge tone="neutral" label="Not verified yet" />
        ) : (
          <>
            <Badge
              tone={verification.ok ? 'ok' : 'danger'}
              label={verification.ok ? 'Verified ✓' : 'Broken ✗'}
            />
            <span className="text-sm text-ink-2">
              {describeVerification(verification)}
            </span>
          </>
        )}
        <Button variant="glass" size="sm" disabled={busy} onClick={verify}>
          {busy ? 'Verifying…' : 'Verify now'}
        </Button>
      </div>
      <p className="text-xs text-ink-3">
        Verify now re-checks every record against the hash of the one before it.
        A record changed or deleted in the database breaks the chain from there
        on. The server also checks on a schedule; this runs the check now.
      </p>
    </div>
  );
}

function AuditView() {
  const router = useRouter();
  const showError = useErrorToast();
  // The filters live in the URL; the API query is derived from them.
  const url = useUrlFilters(AUDIT_FILTER_CODEC);
  const filters = useMemo(() => toFilters(url.filters), [url.filters]);
  const [items, setItems] = useState<AuditRecordView[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [verification, setVerification] = useState<
    AuditVerification | null | undefined
  >();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<AuditRecordView>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  /** A 401 goes to sign-in, a 403 away from the admin area. */
  const handleAccess = useCallback(
    (err: unknown): boolean => {
      if (!(err instanceof ApiError)) return false;
      if (err.status === 401) router.replace('/login');
      else if (err.status === 403) router.replace('/account');
      else return false;
      return true;
    },
    [router],
  );

  const loadPage = useCallback(
    async (active: typeof filters, cursor?: string) =>
      api<AuditPage>(
        `/admin/audit${filtersQuery(active, { cursor, limit: PAGE_SIZE })}`,
      ),
    [],
  );

  // First page for the filters in the URL; a newer change wins over a slow older one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again
  useEffect(() => {
    let cancelled = false;
    setItems(undefined);
    setLoadError(undefined);
    loadPage(filters)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled || handleAccess(err)) return;
        // Rule R2: a failure is said as one, never as "no records".
        setLoadError(describeAuditError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filters, loadPage, handleAccess, attempt]);

  useEffect(() => {
    api<AuditVerificationState>('/admin/audit/verification')
      .then((state) => setVerification(state.last))
      .catch((err: unknown) => {
        if (!handleAccess(err)) showError(describeAuditError(err));
      });
    Promise.all(
      USER_STATUSES.map((status) =>
        api<AdminUser[]>(`/admin/users?status=${status}`),
      ),
    )
      .then((lists) => setUsers(lists.flat()))
      .catch(() => {
        // The actor filter just stays empty; the rest of the page works.
      });
  }, [handleAccess, showError]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await loadPage(filters, nextCursor);
      setItems((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      showError(describeAuditError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const exportHref = `/api/admin/audit/export.csv${filtersQuery(filters)}`;

  // Names for ids (rule R2): fetched once, the page works without them.
  const [names, setNames] = useState<NameIndex>(new Map());
  useEffect(() => {
    Promise.all([
      api<AdminRunner[]>('/admin/runners').catch(() => []),
      api<ProjectSummary[]>('/projects').catch(() => []),
      api<WebhookView[]>('/admin/webhooks').catch(() => []),
    ]).then(([runner, project, webhook]) =>
      setNames(buildNameIndex({ user: users, runner, project, webhook })),
    );
  }, [users]);

  const columns: Column<AuditRecordView>[] = [
    {
      id: 'time',
      header: 'Time',
      cell: (record) => (
        <Time
          value={record.ts}
          format="datetime"
          className="num whitespace-nowrap"
        />
      ),
    },
    {
      id: 'actor',
      header: 'Actor',
      cell: (record) => (
        <span className="truncate">{actorLabel(record, names)}</span>
      ),
    },
    {
      id: 'action',
      header: 'Action',
      cell: (record) => (
        <span className="truncate" title={record.action}>
          {actionLabel(record.action)}
        </span>
      ),
    },
    {
      id: 'target',
      header: 'Target',
      cell: (record) => {
        const target = targetDisplay(record, names);
        return (
          <span className="truncate" title={target.title}>
            {target.text}
          </span>
        );
      },
    },
    {
      id: 'result',
      header: 'Result',
      cell: (record) => (
        <Badge
          tone={RESULT_TONE[record.result]}
          label={RESULT_LABEL[record.result]}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, admin change and command sent to a runner, in order. Records cannot be edited here."
        actions={
          <a
            href={exportHref}
            download
            className={buttonClassName({ variant: 'glass' })}
          >
            Export CSV
          </a>
        }
      />

      <div className="mb-6">
        <ChainStatus
          verification={verification}
          exportHref={exportHref}
          onVerified={setVerification}
        />
      </div>

      <div className="mb-6">
        <AuditFilters url={url} users={users} />
      </div>

      {loadError ? (
        <SectionUnavailable
          title="The audit log is not answering"
          stillWorks="Actions are still recorded on the server."
          detail={loadError}
          action={
            <Button
              variant="glass"
              size="sm"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          }
        />
      ) : items === undefined ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : items.length === 0 ? (
        hasFilters(filters) ? (
          <EmptyState
            title="Nothing matches these filters"
            description="Other records are hidden by the filters above."
            action={
              <Button
                variant="glass"
                onClick={() => url.replace(EMPTY_FILTERS)}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="Every sign-in and admin change"
            description="Records appear here as people sign in and change things. There are none yet."
          />
        )
      ) : (
        <>
          <ScrollX>
            <DataTable
              rows={items}
              getRowId={(record) => record.seq}
              columns={columns}
              onRowActivate={setSelected}
              stickyHeader={false}
              rowHeight={52}
            />
          </ScrollX>
          {nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Button variant="glass" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <RecordSheet
        record={selected}
        names={names}
        onClose={() => setSelected(undefined)}
      />
    </>
  );
}

export default function AdminAuditPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <AuditView />
    </Suspense>
  );
}
