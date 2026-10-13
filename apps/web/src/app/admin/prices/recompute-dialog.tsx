'use client';

import type {
  PriceVersionSummary,
  RecomputeProgress,
  RecomputeRequest,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { Progress } from '@andrewbehma/glass-ui/progress';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import { api } from '../../../lib/api';
import { REPRICE_STATUS_LABEL, SOURCE_LABEL } from '../../../lib/prices/format';
import {
  customRange,
  describeUsageError,
  formatTime,
  isRecomputeRunning,
  RECOMPUTE_POLL_MS,
} from '../../../lib/usage/format';

const TERMINAL = ['done', 'failed'] as const;

/** Re-price a date range with a chosen version, and follow the job to its end. */
export function RecomputeDialog({
  open,
  versions,
  currentId,
  onClose,
  onFinished,
}: {
  open: boolean;
  versions: PriceVersionSummary[];
  currentId: string | undefined;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  // '' = "the current version", so a reload of the list never resets the choice.
  const [chosenId, setVersionId] = useState('');
  const versionId = chosenId || currentId || versions[0]?.id || '';
  const [job, setJob] = useState<RecomputeProgress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);

  // Only opening resets the dialog: the page reloads versions when a job ends,
  // and that must not wipe the finished job's result.
  useEffect(() => {
    if (!open) return;
    setVersionId('');
    setJob(undefined);
    setError(undefined);
    setConflict(false);
  }, [open]);

  const jobId = job?.id;
  const jobDone = job ? TERMINAL.includes(job.status as 'done') : true;

  // Follow a running job; stop at done or failed.
  useEffect(() => {
    if (!jobId || jobDone) return;
    const timer = setInterval(() => {
      api<RecomputeProgress>(`/admin/prices/recompute/${jobId}`)
        .then((next) => {
          setJob(next);
          if (TERMINAL.includes(next.status as 'done')) onFinished();
        })
        .catch((err: unknown) => setError(describeUsageError(err)));
    }, RECOMPUTE_POLL_MS);
    return () => clearInterval(timer);
  }, [jobId, jobDone, onFinished]);

  const range = customRange(fromDate, toDate);
  const running = job !== undefined && !jobDone;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!range || !versionId) return;
    setBusy(true);
    setError(undefined);
    setConflict(false);
    try {
      const body: RecomputeRequest = { ...range, versionId };
      const started = await api<RecomputeProgress>('/admin/prices/recompute', {
        method: 'POST',
        body,
      });
      setJob(started);
      if (TERMINAL.includes(started.status as 'done')) onFinished();
    } catch (err) {
      if (isRecomputeRunning(err)) setConflict(true);
      else setError(describeUsageError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Re-price requests"
        description="Re-prices every request in the range with the chosen version and rebuilds the usage totals for those hours. Earlier versions are not touched. Budgets are not: run Recompute budget totals under Budgets afterwards."
      >
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="From" htmlFor="recompute-from">
              <DateInput
                id="recompute-from"
                value={fromDate}
                max={toDate || undefined}
                disabled={running}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </Field>
            <Field label="To (inclusive)" htmlFor="recompute-to">
              <DateInput
                id="recompute-to"
                value={toDate}
                min={fromDate || undefined}
                disabled={running}
                onChange={(e) => setToDate(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Price version" htmlFor="recompute-version">
            <Select
              id="recompute-version"
              value={versionId}
              disabled={running}
              onChange={(e) => setVersionId(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number} · {SOURCE_LABEL[v.source]} ·{' '}
                  {formatTime(v.createdAt)}
                  {v.id === currentId ? ' (current)' : ''}
                </option>
              ))}
            </Select>
          </Field>

          {conflict ? (
            <Banner tone="warn" title="A re-price is already running">
              Only one runs at a time. Wait for it to finish, then start this
              one.
            </Banner>
          ) : null}
          {error ? (
            <Banner tone="danger" title="Re-price failed to start">
              {error}
            </Banner>
          ) : null}

          {job ? (
            <div className="flex flex-col gap-2" aria-live="polite">
              <div className="flex items-center gap-2 text-sm">
                <Badge
                  tone={
                    job.status === 'done'
                      ? 'ok'
                      : job.status === 'failed'
                        ? 'danger'
                        : 'neutral'
                  }
                  label={REPRICE_STATUS_LABEL[job.status]}
                />
                <span className="text-ink-2">
                  v{job.versionNumber} · {job.processed.toLocaleString()} of{' '}
                  {job.total.toLocaleString()} requests
                </span>
              </div>
              <Progress
                label="Progress"
                value={job.processed}
                max={Math.max(job.total, 1)}
                tone={
                  job.status === 'failed'
                    ? 'danger'
                    : job.status === 'done'
                      ? 'ok'
                      : 'neutral'
                }
              />
              {job.error ? (
                <p className="text-sm text-danger" role="alert">
                  {job.error}
                </p>
              ) : null}
            </div>
          ) : null}

          {job?.status === 'done' ? (
            <p className="text-sm text-ink-2">
              Costs are updated. Budgets still count the old costs until you run{' '}
              <Link
                href="/admin/budgets"
                className="text-accent-ink underline underline-offset-2"
              >
                Recompute budget totals
              </Link>
              .
            </p>
          ) : null}

          <div className="flex flex-col items-end gap-1">
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={onClose}>
                {job && jobDone ? 'Close' : 'Cancel'}
              </Button>
              <Button
                variant="solid"
                type="submit"
                disabled={busy || running || !range || !versionId}
                aria-describedby={
                  !running && !range ? 'reprice-reason' : undefined
                }
              >
                {busy ? 'Starting…' : 'Re-price'}
              </Button>
            </div>
            {!running && !range ? (
              <DisabledReason id="reprice-reason">
                Pick the first and the last day to re-price.
              </DisabledReason>
            ) : null}
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
