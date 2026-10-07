'use client';

import {
  type AdminUser,
  AUDIT_ACTIONS,
  AUDIT_RESULTS,
  type AuditFilters,
  type AuditPage,
  type AuditRecordView,
  type AuditVerification,
  type AuditVerificationState,
  USER_STATUSES,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button, buttonClassName } from 'glass-ui/button';
import { Combobox } from 'glass-ui/combobox';
import { DateInput } from 'glass-ui/date-input';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input, Select } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../../lib/api';
import {
  type AuditFilterForm,
  actionGroups,
  actorLabel,
  describeAuditError,
  describeVerification,
  EMPTY_FILTERS,
  filtersQuery,
  formatTime,
  RESULT_TONE,
  targetLabel,
  toFilters,
} from '../../../lib/audit/format';
import { RecordSheet } from './record-sheet';

const PAGE_SIZE = 50;
const ACTION_GROUPS = actionGroups(AUDIT_ACTIONS);

function ChainStatus({
  verification,
  onVerified,
}: {
  verification: AuditVerification | null | undefined;
  onVerified: (v: AuditVerification) => void;
}) {
  const [busy, setBusy] = useState(false);

  const verify = async () => {
    setBusy(true);
    try {
      const result = await api<AuditVerification>('/admin/audit/verification', {
        method: 'POST',
      });
      onVerified(result);
      if (result.ok) toast.success('The chain is intact.');
      else toast.error(`The chain is broken at seq ${result.firstBrokenSeq}.`);
    } catch (err) {
      toast.error(describeAuditError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
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
  );
}

function Filters({
  form,
  users,
  onChange,
  onApply,
  onReset,
}: {
  form: AuditFilterForm;
  users: AdminUser[];
  onChange: (patch: Partial<AuditFilterForm>) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply();
  };

  return (
    <form
      onSubmit={submit}
      className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Field label="From" htmlFor="audit-from">
        <DateInput
          id="audit-from"
          value={form.fromDate}
          max={form.toDate || undefined}
          onChange={(e) => onChange({ fromDate: e.target.value })}
        />
      </Field>
      <Field label="To" htmlFor="audit-to">
        <DateInput
          id="audit-to"
          value={form.toDate}
          min={form.fromDate || undefined}
          onChange={(e) => onChange({ toDate: e.target.value })}
        />
      </Field>
      <Field label="Action" htmlFor="audit-action">
        <Select
          id="audit-action"
          value={form.action}
          onChange={(e) => onChange({ action: e.target.value })}
        >
          <option value="">Any action</option>
          {ACTION_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              <option value={group}>{group}* (all)</option>
              {AUDIT_ACTIONS.filter((a) => a.startsWith(group)).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <Field label="Result" htmlFor="audit-result">
        <Select
          id="audit-result"
          value={form.result}
          onChange={(e) => onChange({ result: e.target.value })}
        >
          <option value="">Any result</option>
          {AUDIT_RESULTS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Actor">
        <Combobox
          aria-label="Actor"
          placeholder="Any user"
          value={form.actorUserId || null}
          onValueChange={(value) => onChange({ actorUserId: value ?? '' })}
          options={users.map((u) => ({ value: u.id, label: u.email }))}
        />
      </Field>
      <Field label="Target type" htmlFor="audit-target-type">
        <Input
          id="audit-target-type"
          value={form.targetType}
          maxLength={100}
          placeholder="e.g. runner"
          onChange={(e) => onChange({ targetType: e.target.value })}
        />
      </Field>
      <Field label="Target id" htmlFor="audit-target-id">
        <Input
          id="audit-target-id"
          value={form.targetId}
          maxLength={320}
          onChange={(e) => onChange({ targetId: e.target.value })}
        />
      </Field>
      <Field label="Project id" htmlFor="audit-project">
        <Input
          id="audit-project"
          value={form.projectId}
          maxLength={200}
          onChange={(e) => onChange({ projectId: e.target.value })}
        />
      </Field>
      <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
        <Button variant="solid" type="submit">
          Apply
        </Button>
        <Button variant="ghost" type="button" onClick={onReset}>
          Reset
        </Button>
      </div>
    </form>
  );
}

function AuditView() {
  const router = useRouter();
  const [form, setForm] = useState<AuditFilterForm>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>({});
  const [items, setItems] = useState<AuditRecordView[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [verification, setVerification] = useState<
    AuditVerification | null | undefined
  >();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<AuditRecordView>();

  /** Sends the visitor away as AuthGate does for the sibling pages. */
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
    async (active: AuditFilters, cursor?: string) =>
      api<AuditPage>(
        `/admin/audit${filtersQuery(active, { cursor, limit: PAGE_SIZE })}`,
      ),
    [],
  );

  // First page for the applied filters; a newer apply wins over a slow older one.
  useEffect(() => {
    let cancelled = false;
    setItems(undefined);
    loadPage(filters)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled || handleAccess(err)) return;
        setItems([]);
        setNextCursor(null);
        toast.error(describeAuditError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filters, loadPage, handleAccess]);

  useEffect(() => {
    api<AuditVerificationState>('/admin/audit/verification')
      .then((state) => setVerification(state.last))
      .catch((err: unknown) => {
        if (!handleAccess(err)) toast.error(describeAuditError(err));
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
  }, [handleAccess]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await loadPage(filters, nextCursor);
      setItems((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      toast.error(describeAuditError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const reset = () => {
    setForm(EMPTY_FILTERS);
    setFilters({});
  };

  const exportHref = `/api/admin/audit/export.csv${filtersQuery(filters)}`;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <a href={exportHref} download className={buttonClassName()}>
          Export CSV
        </a>
      </div>

      <div className="mb-6">
        <ChainStatus verification={verification} onVerified={setVerification} />
      </div>

      <div className="mb-6">
        <Filters
          form={form}
          users={users}
          onChange={(patch) => setForm((c) => ({ ...c, ...patch }))}
          onApply={() => setFilters(toFilters(form))}
          onReset={reset}
        />
      </div>

      {items === undefined ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No records"
          description="Nothing matches these filters."
        />
      ) : (
        <>
          <Table scroll>
            <TableHead>
              <TableRow>
                <TableCell head>Time</TableCell>
                <TableCell head>Actor</TableCell>
                <TableCell head>Action</TableCell>
                <TableCell head>Target</TableCell>
                <TableCell head>Result</TableCell>
                <TableCell head>
                  <span className="sr-only">Details</span>
                </TableCell>
              </TableRow>
            </TableHead>
            <tbody>
              {items.map((record) => (
                <TableRow key={record.seq}>
                  <TableCell>{formatTime(record.ts)}</TableCell>
                  <TableCell>{actorLabel(record)}</TableCell>
                  <TableCell>{record.action}</TableCell>
                  <TableCell>{targetLabel(record)}</TableCell>
                  <TableCell>
                    <Badge
                      tone={RESULT_TONE[record.result]}
                      label={record.result}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        variant="glass"
                        size="sm"
                        aria-label={`Details for record ${record.seq}`}
                        onClick={() => setSelected(record)}
                      >
                        Details
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
          {nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Button variant="glass" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <RecordSheet record={selected} onClose={() => setSelected(undefined)} />
    </>
  );
}

export default function AdminAuditPage() {
  return <AuditView />;
}
