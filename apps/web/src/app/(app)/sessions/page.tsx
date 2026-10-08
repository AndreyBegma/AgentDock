'use client';

import type {
  ProjectSummary,
  SessionListQuery,
  SessionListResponse,
  SessionSummary,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { Checkbox } from 'glass-ui/checkbox';
import { DateInput } from 'glass-ui/date-input';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input, Select } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import Link from 'next/link';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api } from '../../../lib/api';
import { useLive } from '../../../lib/live/use-live';
import {
  cacheTokens,
  describeSessionError,
  EMPTY_FILTERS,
  formatCost,
  formatDuration,
  formatTime,
  formatTokens,
  liveTopicFor,
  queryString,
  type SessionFilterForm,
  toQuery,
} from '../../../lib/sessions/format';

const PAGE_SIZE = 50;
/** Without a project filter there is no single topic to follow, so poll (like /projects). */
const POLL_MS = 15_000;

function Filters({
  form,
  projects,
  isAdmin,
  onChange,
  onApply,
  onReset,
}: {
  form: SessionFilterForm;
  projects: ProjectSummary[];
  isAdmin: boolean;
  onChange: (patch: Partial<SessionFilterForm>) => void;
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
      <Field label="Project" htmlFor="sessions-project">
        <Select
          id="sessions-project"
          value={form.projectId}
          disabled={form.unassigned}
          onChange={(e) => onChange({ projectId: e.target.value })}
        >
          <option value="">All my projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Runtime" htmlFor="sessions-runtime">
        <Select
          id="sessions-runtime"
          value={form.runtime}
          onChange={(e) => onChange({ runtime: e.target.value })}
        >
          <option value="">Any runtime</option>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </Select>
      </Field>
      <Field label="Model" htmlFor="sessions-model">
        <Input
          id="sessions-model"
          value={form.model}
          maxLength={200}
          placeholder="e.g. claude-opus-5-5"
          onChange={(e) => onChange({ model: e.target.value })}
        />
      </Field>
      <Field label="Slot" htmlFor="sessions-slot">
        <Input
          id="sessions-slot"
          value={form.slot}
          maxLength={200}
          placeholder="e.g. i42"
          onChange={(e) => onChange({ slot: e.target.value })}
        />
      </Field>
      <Field label="From" htmlFor="sessions-from">
        <DateInput
          id="sessions-from"
          value={form.fromDate}
          max={form.toDate || undefined}
          onChange={(e) => onChange({ fromDate: e.target.value })}
        />
      </Field>
      <Field label="To" htmlFor="sessions-to">
        <DateInput
          id="sessions-to"
          value={form.toDate}
          min={form.fromDate || undefined}
          onChange={(e) => onChange({ toDate: e.target.value })}
        />
      </Field>
      {isAdmin ? (
        <Checkbox
          label="Unassigned only"
          hint="Sessions with no project"
          checked={form.unassigned}
          onChange={(e) => onChange({ unassigned: e.target.checked })}
        />
      ) : null}
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

function SessionRow({ session }: { session: SessionSummary }) {
  const t = session.totals;
  return (
    <TableRow>
      <TableCell>
        <Link
          href={`/sessions/${session.id}`}
          className="underline-offset-2 hover:underline"
        >
          {formatTime(session.startedAt)}
        </Link>
        {session.title ? (
          <div className="max-w-64 truncate text-xs text-ink-3">
            {session.title}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        {session.projectName ?? <span className="text-ink-3">—</span>}
        {session.slotName ? (
          <span className="text-ink-3"> · {session.slotName}</span>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge tone="neutral" label={session.runtime} />
        {session.parsed ? null : (
          <span className="ms-2 text-xs text-ink-3">not parsed</span>
        )}
      </TableCell>
      <TableCell>{session.models.join(', ') || '—'}</TableCell>
      <TableCell>{session.turns}</TableCell>
      <TableCell>{t.requests}</TableCell>
      <TableCell>
        <span title="input / output / cache">
          {formatTokens(t.input)} / {formatTokens(t.output)} /{' '}
          {formatTokens(cacheTokens(t))}
        </span>
      </TableCell>
      <TableCell>{formatCost(t.costUsd)}</TableCell>
      <TableCell>{formatDuration(session.durationMs)}</TableCell>
    </TableRow>
  );
}

export default function SessionsPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const [form, setForm] = useState<SessionFilterForm>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<SessionListQuery>({});
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [items, setItems] = useState<SessionSummary[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Only the newest request may write: a slow older one must not overwrite.
  const generation = useRef(0);

  const loadFirst = useCallback(async (query: SessionListQuery) => {
    const mine = ++generation.current;
    try {
      const page = await api<SessionListResponse>(
        `/sessions${queryString(query, { limit: PAGE_SIZE })}`,
      );
      if (mine !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (mine !== generation.current) return;
      setItems((current) => current ?? []);
      toast.error(describeSessionError(err));
    }
  }, []);

  useEffect(() => {
    setItems(undefined);
    loadFirst(applied);
  }, [applied, loadFirst]);

  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter stays empty; the list still works.
      });
  }, []);

  const topic = liveTopicFor(applied);
  useLive(topic, (message) => {
    if (message.event === 'sessions.changed') loadFirst(applied);
  });

  // No topic to follow → poll the first page, like /projects does.
  useEffect(() => {
    if (topic) return;
    const timer = setInterval(() => loadFirst(applied), POLL_MS);
    return () => clearInterval(timer);
  }, [topic, applied, loadFirst]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<SessionListResponse>(
        `/sessions${queryString(applied, { cursor: nextCursor, limit: PAGE_SIZE })}`,
      );
      setItems((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      toast.error(describeSessionError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const reset = () => {
    setForm(EMPTY_FILTERS);
    setApplied({});
  };

  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Sessions</h1>

      <div className="mb-6">
        <Filters
          form={form}
          projects={projects}
          isAdmin={isAdmin}
          onChange={(patch) => setForm((c) => ({ ...c, ...patch }))}
          onApply={() => setApplied(toQuery(form))}
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
          title="No sessions"
          description="Nothing matches these filters, or no runner has reported a session yet."
        />
      ) : (
        <>
          <Table scroll>
            <TableHead>
              <TableRow>
                <TableCell head>Started</TableCell>
                <TableCell head>Project / slot</TableCell>
                <TableCell head>Runtime</TableCell>
                <TableCell head>Models</TableCell>
                <TableCell head>Turns</TableCell>
                <TableCell head>Requests</TableCell>
                <TableCell head>Tokens in / out / cache</TableCell>
                <TableCell head>Cost</TableCell>
                <TableCell head>Duration</TableCell>
              </TableRow>
            </TableHead>
            <tbody>
              {items.map((session) => (
                <SessionRow key={session.id} session={session} />
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
    </>
  );
}
