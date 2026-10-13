'use client';

import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_ITEM_LIVE_EVENT,
  type ActivityCategory,
  type ActivityItem,
  type ActivityPage,
  type ActivityQuery,
  type ActivitySeverity,
  type LiveTopic,
  type ProjectSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@andrewbehma/glass-ui/popover';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Timeline, type TimelineItem } from '@andrewbehma/glass-ui/timeline';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { Bot, ListFilter, Server, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  type FormEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type ActivityFilterForm,
  actorName,
  CATEGORY_LABEL,
  EMPTY_ACTIVITY_FILTERS,
  type FeedRow,
  formFromSearch,
  formSearch,
  groupRows,
  hasActivityFilters,
  isNotFound,
  matchesQuery,
  mergeItems,
  moreFilterCount,
  PAGE_SIZE,
  POLL_MS,
  parseLiveItem,
  planLive,
  queryString,
  SCROLLED_PX,
  safeLink,
  severityTone,
  TYPE_OPTIONS,
  toActivityQuery,
  typeLabel,
} from '../../../lib/activity/format';
import { api, describeError, describeErrorHint } from '../../../lib/api';
import { pluralize } from '../../../lib/format';
import { useLive } from '../../../lib/live/use-live';
import { useErrorToast } from '../../../lib/section/use-error-toast';

const CATEGORY_ICON: Record<ActivityCategory, ReactNode> = {
  fleet: <Bot size={14} strokeWidth={2} />,
  runner: <Server size={14} strokeWidth={2} />,
  audit: <ShieldCheck size={14} strokeWidth={2} />,
};

const SEVERITY_RANK: Record<ActivitySeverity, number> = {
  info: 0,
  ok: 1,
  warn: 2,
  danger: 3,
};

/** `useLive` takes one topic; a feed may follow several, so one invisible subscriber each. */
function TopicListener({
  topic,
  onItem,
}: {
  topic: LiveTopic;
  onItem: (item: ActivityItem) => void;
}) {
  useLive(topic, (message) => {
    if (message.event !== ACTIVITY_ITEM_LIVE_EVENT) return;
    const item = parseLiveItem(message.data);
    if (item) onItem(item);
  });
  return null;
}

/** What an item is about, as tinted chips; the event code only in the tooltip (R2). */
function ItemMeta({
  item,
  projectName,
  extra,
}: {
  item: ActivityItem;
  projectName: string | null;
  extra?: ReactNode;
}) {
  return (
    <span
      className="mt-0.5 flex flex-wrap items-center gap-1.5"
      title={item.type}
    >
      <span>{CATEGORY_LABEL[item.category] ?? typeLabel(item.category)}</span>
      {projectName ? (
        <span className="max-w-48 truncate">· {projectName}</span>
      ) : null}
      {item.slot ? (
        <Chip size="sm" className="text-[11px]">
          {item.slot}
        </Chip>
      ) : null}
      {item.issue !== null ? (
        <Chip size="sm" className="text-[11px]">
          #{item.issue}
        </Chip>
      ) : null}
      {item.prNumber !== null ? (
        <Chip size="sm" tone="ok" className="text-[11px]">
          PR #{item.prNumber}
        </Chip>
      ) : null}
      {extra}
    </span>
  );
}

interface Names {
  projects: ReadonlyMap<string, string>;
  runners: ReadonlyMap<string, string>;
}

function projectNameOf(item: ActivityItem, names: Names, fixed: boolean) {
  if (fixed) return null;
  if (!item.projectId) return 'no project';
  return names.projects.get(item.projectId) ?? null;
}

function toEntry(item: ActivityItem, names: Names, fixed: boolean) {
  const name = actorName(item, names.runners);
  return {
    id: item.id,
    at: item.ts,
    tone: severityTone(item.severity),
    icon: CATEGORY_ICON[item.category],
    actor: name ? { name } : undefined,
    title: item.title,
    meta: (
      <ItemMeta item={item} projectName={projectNameOf(item, names, fixed)} />
    ),
    href: safeLink(item.link),
  } satisfies TimelineItem;
}

/**
 * Feed rows as Timeline items. A collapsed group is its newest item with
 * "N earlier" and opens in place; an open group is a header that closes it,
 * then every item.
 */
function toEntries(
  rows: FeedRow[],
  open: ReadonlySet<string>,
  toggle: (id: string) => void,
  names: Names,
  fixed: boolean,
): TimelineItem[] {
  const entries: TimelineItem[] = [];
  for (const row of rows) {
    if (row.kind === 'item') {
      entries.push(toEntry(row.item, names, fixed));
      continue;
    }
    const [newest] = row.items;
    const worst = row.items.reduce((a, b) =>
      SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a,
    );
    if (open.has(row.id)) {
      entries.push({
        id: row.id,
        at: newest.ts,
        tone: severityTone(worst.severity),
        icon: CATEGORY_ICON[newest.category],
        title: `${row.label}: ${pluralize(row.items.length, 'update')}`,
        meta: 'Hide the updates',
        onSelect: () => toggle(row.id),
      });
      for (const item of row.items) entries.push(toEntry(item, names, fixed));
      continue;
    }
    const earlier = row.items.length - 1;
    const name = actorName(newest, names.runners);
    entries.push({
      id: row.id,
      at: newest.ts,
      tone: severityTone(worst.severity),
      icon: CATEGORY_ICON[newest.category],
      actor: name ? { name } : undefined,
      title: newest.title,
      meta: (
        <ItemMeta
          item={newest}
          projectName={projectNameOf(newest, names, fixed)}
          extra={
            <span className="font-medium text-ink-2">
              · {pluralize(earlier, 'earlier update')}, show
            </span>
          }
        />
      ),
      onSelect: () => toggle(row.id),
    });
  }
  return entries;
}

function MoreFilters({
  form,
  actors,
  onApply,
}: {
  form: ActivityFilterForm;
  /** Who caused the items loaded so far, by id → name. */
  actors: ReadonlyMap<string, string>;
  onApply: (patch: Partial<ActivityFilterForm>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(form);
  const count = moreFilterCount(form);

  useEffect(() => {
    if (open) setDraft(form);
  }, [open, form]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply({
      type: draft.type,
      actor: draft.actor,
      slot: draft.slot.trim(),
      fromDate: draft.fromDate,
      toDate: draft.toDate,
    });
    setOpen(false);
  };
  const clear = () => {
    onApply({ type: '', actor: '', slot: '', fromDate: '', toDate: '' });
    setOpen(false);
  };
  const set = (patch: Partial<ActivityFilterForm>) =>
    setDraft((current) => ({ ...current, ...patch }));

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="glass" size="sm">
          <ListFilter size={14} aria-hidden="true" />
          More filters
          {count > 0 ? <Badge tone="ink" count={count} /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent title="More filters" align="end" className="w-80">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Type" htmlFor="activity-type">
            <Select
              id="activity-type"
              value={draft.type}
              onChange={(e) => set({ type: e.target.value })}
            >
              <option value="">Any type</option>
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Actor"
            htmlFor="activity-actor"
            hint="People and runners seen in the feed so far."
          >
            <Select
              id="activity-actor"
              value={draft.actor}
              onChange={(e) => set({ actor: e.target.value })}
            >
              <option value="">Anyone</option>
              {[...actors].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {draft.actor && !actors.has(draft.actor) ? (
                <option value={draft.actor}>The chosen actor</option>
              ) : null}
            </Select>
          </Field>
          <Field
            label="Slot"
            htmlFor="activity-slot"
            hint="An orchestrator slot's name."
          >
            <Input
              id="activity-slot"
              value={draft.slot}
              maxLength={200}
              placeholder="e.g. i42"
              onChange={(e) => set({ slot: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="activity-from">
              <DateInput
                id="activity-from"
                value={draft.fromDate}
                max={draft.toDate || undefined}
                onChange={(e) => set({ fromDate: e.target.value })}
              />
            </Field>
            <Field label="To" htmlFor="activity-to">
              <DateInput
                id="activity-to"
                value={draft.toDate}
                min={draft.fromDate || undefined}
                onChange={(e) => set({ toDate: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={clear}>
              Clear
            </Button>
            <Button variant="solid" size="sm" type="submit">
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </PopoverRoot>
  );
}

function FeedToolbar({
  form,
  projects,
  showProject,
  actors,
  onChange,
  onReset,
}: {
  form: ActivityFilterForm;
  projects: ProjectSummary[];
  showProject: boolean;
  actors: ReadonlyMap<string, string>;
  onChange: (patch: Partial<ActivityFilterForm>) => void;
  onReset: () => void;
}) {
  const filtered = hasActivityFilters(toActivityQuery(form));
  return (
    <Toolbar
      aria-label="Filter activity"
      filters={
        <div className="flex items-center gap-2">
          {showProject ? (
            <Select
              aria-label="Project"
              value={form.projectId}
              onChange={(e) => onChange({ projectId: e.target.value })}
              className="w-44"
            >
              <option value="">All my projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.displayName}
                </option>
              ))}
            </Select>
          ) : null}
          <Select
            aria-label="Category"
            value={form.category}
            onChange={(e) => onChange({ category: e.target.value })}
            className="w-36"
          >
            <option value="">Any category</option>
            {ACTIVITY_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABEL[category]}
              </option>
            ))}
          </Select>
        </div>
      }
      actions={
        <div className="flex items-center gap-1">
          <MoreFilters form={form} actors={actors} onApply={onChange} />
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={onReset}>
              Reset
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

type FeedProps = {
  projectId?: string;
  isAdmin: boolean;
};

/**
 * The activity feed (spec 21 UI): a filter toolbar whose state is the URL, a
 * day-grouped timeline with runs about one slot or PR folded, load more, and
 * live insertion. `projectId` fixes it to one project; without it the feed is
 * the caller's whole feed, with a project filter.
 */
export function ActivityFeed(props: FeedProps) {
  return (
    <Suspense fallback={<FeedSkeleton />}>
      <Feed {...props} />
    </Suspense>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function Feed({ projectId, isAdmin }: FeedProps) {
  const fixed = projectId !== undefined;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const form = useMemo(() => {
    const read = formFromSearch(new URLSearchParams(search));
    return fixed ? { ...read, projectId: '' } : read;
  }, [search, fixed]);
  const applied = useMemo(() => toActivityQuery(form), [form]);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [items, setItems] = useState<ActivityItem[]>();
  const [pending, setPending] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // A failed load is never "no activity": keep what is on screen and say so.
  const [failure, setFailure] = useState<unknown>(null);
  const showError = useErrorToast();
  const generation = useRef(0);
  const topRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<ActivityItem[] | undefined>(undefined);
  const pendingRef = useRef<ActivityItem[]>([]);
  itemsRef.current = items;
  pendingRef.current = pending;

  const appliedRef = useRef(applied);
  appliedRef.current = applied;

  const base = fixed ? `/projects/${projectId}/activity` : '/activity';

  const navigate = (next: ActivityFilterForm) =>
    router.replace(`${pathname}${formSearch(next)}`, { scroll: false });
  const change = (patch: Partial<ActivityFilterForm>) =>
    navigate({ ...form, ...patch });
  const reset = () => navigate(EMPTY_ACTIVITY_FILTERS);

  /** Reads refs only, so it is stable and never sees stale filters. */
  const receive = useCallback((incoming: ActivityItem[]) => {
    const current = itemsRef.current;
    if (!current) return;
    const known = new Set([
      ...current.map((i) => i.id),
      ...pendingRef.current.map((i) => i.id),
    ]);
    const fresh = incoming.filter(
      (item) => !known.has(item.id) && matchesQuery(item, appliedRef.current),
    );
    if (fresh.length === 0) return;
    // Scrolled away from the top? New items wait behind the "N new" pill.
    const top = topRef.current?.getBoundingClientRect().top ?? 0;
    if (top < -SCROLLED_PX) setPending((p) => mergeItems(p, fresh));
    else setItems((c) => mergeItems(c ?? [], fresh));
  }, []);

  const loadFirst = useCallback(
    async (query: ActivityQuery, reset: boolean) => {
      const mine = ++generation.current;
      try {
        const page = await api<ActivityPage>(
          `${base}${queryString(query, { limit: PAGE_SIZE })}`,
        );
        if (mine !== generation.current) return;
        setMissing(false);
        setFailure(null);
        if (reset) {
          setItems(page.items);
          setPending([]);
          setNextCursor(page.nextCursor);
        } else {
          receive(page.items);
        }
      } catch (err) {
        if (mine !== generation.current) return;
        if (isNotFound(err)) setMissing(true);
        else setFailure(err);
      }
    },
    [base, receive],
  );

  const showNew = () => {
    setItems((c) => mergeItems(c ?? [], pending));
    setPending([]);
    topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  useEffect(() => {
    setItems(undefined);
    setFailure(null);
    loadFirst(applied, true);
  }, [applied, loadFirst]);

  // The project filter, and the runners' names for actors.
  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter stays empty and runners read "runner"; the feed still works.
      });
  }, []);

  const plan = useMemo(
    () =>
      planLive({
        projectId: projectId ?? applied.projectId,
        projectIds: projects.map((p) => p.id),
        isAdmin,
      }),
    [projectId, applied.projectId, projects, isAdmin],
  );

  useEffect(() => {
    if (!plan.poll) return;
    const timer = setInterval(() => loadFirst(applied, false), POLL_MS);
    return () => clearInterval(timer);
  }, [plan.poll, applied, loadFirst]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<ActivityPage>(
        `${base}${queryString(applied, { cursor: nextCursor, limit: PAGE_SIZE })}`,
      );
      setItems((current) => mergeItems(current ?? [], page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      showError(describeErrorHint(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const names = useMemo<Names>(
    () => ({
      projects: new Map(projects.map((p) => [p.id, p.displayName])),
      runners: new Map(projects.map((p) => [p.runnerId, p.runnerName])),
    }),
    [projects],
  );
  const actors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items ?? []) {
      if (item.actorType === 'user' && item.actorId && item.actorEmail) {
        seen.set(item.actorId, item.actorEmail);
      }
    }
    for (const [id, name] of names.runners) seen.set(id, `${name} (runner)`);
    return seen;
  }, [items, names]);

  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const entries = useMemo(
    () => toEntries(groupRows(items ?? []), open, toggle, names, fixed),
    [items, open, toggle, names, fixed],
  );

  if (missing) {
    return (
      <EmptyState
        title="Project not found"
        description="It does not exist, or you are not a member of it."
      />
    );
  }

  return (
    <>
      {plan.topics.map((topic) => (
        <TopicListener key={topic} topic={topic} onItem={(i) => receive([i])} />
      ))}

      <div className="mb-4">
        <FeedToolbar
          form={form}
          projects={projects}
          showProject={!fixed}
          actors={actors}
          onChange={change}
          onReset={reset}
        />
      </div>

      <div ref={topRef} />
      {failure !== null ? (
        <div className="mb-4">
          <SectionUnavailable
            title="Activity is not answering"
            stillWorks={`${describeError(failure)} The filters above still work.`}
            action={
              <Button
                variant="glass"
                size="sm"
                onClick={() => loadFirst(applied, items === undefined)}
              >
                Try again
              </Button>
            }
          />
        </div>
      ) : null}
      {items === undefined ? (
        failure !== null ? null : (
          <FeedSkeleton />
        )
      ) : (
        <Timeline
          items={entries}
          hasMore={nextCursor !== null}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          newCount={pending.length}
          onShowNew={showNew}
          dayHeadingLevel={2}
          className="[&_li]:rounded-none [&_li]:bg-transparent [&_ol]:divide-y [&_ol]:divide-line"
          empty={
            hasActivityFilters(applied) ? (
              <EmptyState
                title="No activity matches these filters"
                description="Widen the date range or clear a filter to see more."
                action={
                  <Button variant="glass" onClick={reset}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No activity yet"
                description="Events appear here as the orchestrator opens pull requests, hits blockers and finishes work."
                action={
                  <Link
                    href={
                      fixed
                        ? `/projects/${projectId}/fleet`
                        : isAdmin
                          ? '/admin/runners'
                          : '/projects'
                    }
                    className={buttonClassName({ variant: 'glass' })}
                  >
                    {fixed
                      ? 'Open Fleet'
                      : isAdmin
                        ? 'Open Runners'
                        : 'Open Projects'}
                  </Link>
                }
              />
            )
          }
        />
      )}
    </>
  );
}
