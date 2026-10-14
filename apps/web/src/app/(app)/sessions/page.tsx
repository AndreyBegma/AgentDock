'use client';

import type {
  ProjectSummary,
  SessionListQuery,
  SessionListResponse,
  SessionSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import {
  LiveStatePill,
  OriginBadge,
} from '../../../components/sessions/origin-badge';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api } from '../../../lib/api';
import { formatNumber } from '../../../lib/format';
import { Time } from '../../../lib/format/time';
import { useLive } from '../../../lib/live/use-live';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import {
  appliedFilterCount,
  cacheTokens,
  describeSessionError,
  describeSessionHint,
  EMPTY_FILTERS,
  formatCost,
  formatDuration,
  formatTokens,
  hasSessionFilters,
  liveTopicFor,
  ORIGIN_FILTERS,
  ORIGIN_LABEL,
  queryString,
  type SessionFilterForm,
  sessionFormChanged,
  sessionName,
  toQuery,
} from '../../../lib/sessions/format';

const PAGE_SIZE = 50;
/** Without a project filter there is no single topic to follow, so poll (like /projects). */
const POLL_MS = 15_000;

function Filters({
  form,
  projects,
  isAdmin,
  changed,
  active,
  onChange,
  onApply,
  onReset,
}: {
  form: SessionFilterForm;
  projects: ProjectSummary[];
  isAdmin: boolean;
  /** The form holds filters that were not applied yet. */
  changed: boolean;
  /** How many filters are applied now. */
  active: number;
  onChange: (patch: Partial<SessionFilterForm>) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  // A phone gets one "Filters" button; a wider screen shows the bar.
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(
    () => form.model !== '' || form.slot !== '' || form.unassigned,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply();
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="glass"
        size="sm"
        className="self-start sm:hidden"
        aria-expanded={open}
        aria-controls="sessions-filters"
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontal aria-hidden="true" className="size-4" />
        Filters
        {active > 0 ? <Badge tone="neutral" label={String(active)} /> : null}
      </Button>
      <form
        id="sessions-filters"
        onSubmit={submit}
        className={`${open ? 'flex' : 'hidden'} flex-col gap-3 sm:flex`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end [&>*]:min-w-0 sm:[&>*]:flex-[1_1_10rem]">
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
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </Select>
          </Field>
          <Field label="Origin" htmlFor="sessions-origin">
            <Select
              id="sessions-origin"
              value={form.origin}
              onChange={(e) => onChange({ origin: e.target.value })}
            >
              <option value="">Any origin</option>
              {ORIGIN_FILTERS.map((origin) => (
                <option key={origin} value={origin}>
                  {ORIGIN_LABEL[origin]}
                </option>
              ))}
            </Select>
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
          <div className="flex flex-wrap items-center gap-2 sm:flex-none">
            <Button variant="solid" type="submit">
              Apply
            </Button>
            <Button variant="ghost" type="button" onClick={onReset}>
              Reset
            </Button>
          </div>
        </div>
        <Disclosure
          open={more}
          onOpenChange={setMore}
          trigger="More filters"
          triggerClassName="text-sm text-ink-2"
        >
          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:flex-wrap sm:items-end [&>*]:min-w-0 sm:[&>*]:flex-[1_1_12rem]">
            <Field label="Model" htmlFor="sessions-model">
              <Input
                id="sessions-model"
                value={form.model}
                maxLength={200}
                placeholder="e.g. claude-opus-5-5"
                onChange={(e) => onChange({ model: e.target.value })}
              />
            </Field>
            <Field
              label="Slot"
              htmlFor="sessions-slot"
              hint="The orchestrator slot, as in the Project column."
            >
              <Input
                id="sessions-slot"
                value={form.slot}
                maxLength={200}
                placeholder="e.g. i42"
                onChange={(e) => onChange({ slot: e.target.value })}
              />
            </Field>
            {isAdmin ? (
              <Checkbox
                label="Unassigned only"
                hint="Sessions with no project; turns the project filter off."
                checked={form.unassigned}
                onChange={(e) => onChange({ unassigned: e.target.checked })}
              />
            ) : null}
          </div>
        </Disclosure>
        {changed ? (
          <p className="text-xs text-ink-2" role="status">
            Filters changed. Press Apply to update the list.
          </p>
        ) : null}
      </form>
    </div>
  );
}

const RUNTIME_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const figure = (text: string) => <span className="num">{text}</span>;

function useColumns() {
  return useMemo(
    () => [
      {
        id: 'session',
        header: 'Session',
        width: 'minmax(12rem, 2fr)',
        cell: (s: SessionSummary) => (
          <span className="flex min-w-0 items-center gap-2">
            <Link
              href={`/sessions/${s.id}`}
              className="truncate font-medium underline-offset-2 hover:underline"
              // The row opens the session too; one activation, not two.
              onClick={(event) => event.stopPropagation()}
              tabIndex={-1}
            >
              {sessionName(s)}
            </Link>
            {s.parsed ? null : (
              <Tooltip content="The runner reported this session, but its transcript has not been read yet. Turns, tokens and cost may be missing.">
                <span className="shrink-0 cursor-help">
                  <Badge tone="warn" label="Not yet read" />
                </span>
              </Tooltip>
            )}
          </span>
        ),
      },
      {
        id: 'origin',
        header: 'Origin',
        cell: (s: SessionSummary) => (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <OriginBadge session={s} />
            <LiveStatePill session={s} />
          </span>
        ),
      },
      {
        id: 'started',
        header: 'Started',
        cell: (s: SessionSummary) => <Time value={s.startedAt} />,
      },
      {
        id: 'project',
        header: 'Project',
        cell: (s: SessionSummary) => (
          <span className="truncate">
            {s.projectName ?? <span className="text-ink-3">No project</span>}
            {s.slotName ? (
              <span className="text-ink-3"> · {s.slotName}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'runtime',
        header: 'Runtime',
        cell: (s: SessionSummary) => (
          <span className="truncate">
            {RUNTIME_LABEL[s.runtime] ?? s.runtime}
            {s.models.length > 0 ? (
              <span className="text-ink-3"> · {s.models.join(', ')}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'turns',
        header: 'Turns',
        align: 'end' as const,
        cell: (s: SessionSummary) => figure(formatNumber(s.turns)),
      },
      {
        id: 'requests',
        header: 'Requests',
        align: 'end' as const,
        cell: (s: SessionSummary) => figure(formatNumber(s.totals.requests)),
      },
      {
        id: 'tokens',
        header: (
          <Tooltip content="Input / output / cache tokens">
            <span className="cursor-help">Tokens</span>
          </Tooltip>
        ),
        align: 'end' as const,
        cell: (s: SessionSummary) =>
          figure(
            `${formatTokens(s.totals.input)} / ${formatTokens(s.totals.output)} / ${formatTokens(cacheTokens(s.totals))}`,
          ),
      },
      {
        id: 'cost',
        header: 'Cost',
        align: 'end' as const,
        cell: (s: SessionSummary) => figure(formatCost(s.totals.costUsd)),
      },
      {
        id: 'duration',
        header: 'Duration',
        align: 'end' as const,
        cell: (s: SessionSummary) => figure(formatDuration(s.durationMs)),
      },
    ],
    [],
  );
}

export default function SessionsPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const router = useRouter();
  const columns = useColumns();
  const [form, setForm] = useState<SessionFilterForm>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<SessionListQuery>({});
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [items, setItems] = useState<SessionSummary[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // A failed load is never "no sessions": keep what is on screen and say so.
  const [failure, setFailure] = useState<unknown>(null);
  const showError = useErrorToast();
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
      setFailure(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setFailure(err);
    }
  }, []);

  useEffect(() => {
    setItems(undefined);
    setFailure(null);
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
      showError(describeSessionHint(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const reset = () => {
    setForm(EMPTY_FILTERS);
    setApplied({});
  };

  const unavailable =
    failure !== null ? (
      <SectionUnavailable
        title="Sessions are not answering"
        stillWorks={`${describeSessionError(failure)} The filters above still work.`}
        action={
          <Button variant="glass" size="sm" onClick={() => loadFirst(applied)}>
            Try again
          </Button>
        }
      />
    ) : null;

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Every agent session your runners have reported, with its tokens and cost."
      />

      <div className="mb-6">
        <Filters
          form={form}
          projects={projects}
          isAdmin={isAdmin}
          changed={sessionFormChanged(form, applied)}
          active={appliedFilterCount(applied)}
          onChange={(patch) => setForm((c) => ({ ...c, ...patch }))}
          onApply={() => setApplied(toQuery(form))}
          onReset={reset}
        />
      </div>

      {items === undefined ? (
        (unavailable ?? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ))
      ) : items.length === 0 ? (
        <>
          {unavailable}
          {hasSessionFilters(applied) ? (
            <EmptyState
              title="No sessions match these filters"
              description="Widen the date range or clear a filter to see more."
              action={
                <Button variant="glass" onClick={reset}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No sessions yet"
              description="A session appears here when an agent runs on a paired runner and reports its transcript."
              action={
                <Link
                  href={isAdmin ? '/admin/runners' : '/projects'}
                  className={buttonClassName({ variant: 'glass' })}
                >
                  {isAdmin ? 'Open Runners' : 'Open Projects'}
                </Link>
              }
            />
          )}
        </>
      ) : (
        <>
          {unavailable}
          <ScrollX label="Sessions">
            <DataTable
              rows={items}
              getRowId={(s) => s.id}
              columns={columns}
              onRowActivate={(s) => router.push(`/sessions/${s.id}`)}
              stickyHeader={false}
              className="min-w-[68rem]"
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
    </>
  );
}
