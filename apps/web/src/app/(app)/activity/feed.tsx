'use client';

import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_ITEM_LIVE_EVENT,
  type ActivityItem,
  type ActivityPage,
  type ActivityQuery,
  type LiveTopic,
  type ProjectSummary,
} from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { DateInput } from 'glass-ui/date-input';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input, Select } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { Timeline } from 'glass-ui/timeline';
import { toast } from 'glass-ui/toast';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type ActivityFilterForm,
  CATEGORY_LABEL,
  EMPTY_ACTIVITY_FILTERS,
  isNotFound,
  matchesQuery,
  mergeItems,
  PAGE_SIZE,
  POLL_MS,
  parseLiveItem,
  planLive,
  queryString,
  SCROLLED_PX,
  toActivityQuery,
  toTimelineItem,
} from '../../../lib/activity/format';
import { api, describeError } from '../../../lib/api';
import { useLive } from '../../../lib/live/use-live';

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

function Filters({
  form,
  projects,
  showProject,
  onChange,
  onApply,
  onReset,
}: {
  form: ActivityFilterForm;
  projects: ProjectSummary[];
  showProject: boolean;
  onChange: (patch: Partial<ActivityFilterForm>) => void;
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
      {showProject ? (
        <Field label="Project" htmlFor="activity-project">
          <Select
            id="activity-project"
            value={form.projectId}
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
      ) : null}
      <Field label="Category" htmlFor="activity-category">
        <Select
          id="activity-category"
          value={form.category}
          onChange={(e) => onChange({ category: e.target.value })}
        >
          <option value="">Any category</option>
          {ACTIVITY_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABEL[category]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Type" htmlFor="activity-type">
        <Input
          id="activity-type"
          value={form.type}
          maxLength={200}
          placeholder="e.g. pr.merged"
          onChange={(e) => onChange({ type: e.target.value })}
        />
      </Field>
      <Field label="Actor" htmlFor="activity-actor">
        <Input
          id="activity-actor"
          value={form.actor}
          maxLength={200}
          placeholder="user or runner id"
          onChange={(e) => onChange({ actor: e.target.value })}
        />
      </Field>
      <Field label="Slot" htmlFor="activity-slot">
        <Input
          id="activity-slot"
          value={form.slot}
          maxLength={200}
          placeholder="e.g. i42"
          onChange={(e) => onChange({ slot: e.target.value })}
        />
      </Field>
      <Field label="From" htmlFor="activity-from">
        <DateInput
          id="activity-from"
          value={form.fromDate}
          max={form.toDate || undefined}
          onChange={(e) => onChange({ fromDate: e.target.value })}
        />
      </Field>
      <Field label="To" htmlFor="activity-to">
        <DateInput
          id="activity-to"
          value={form.toDate}
          min={form.fromDate || undefined}
          onChange={(e) => onChange({ toDate: e.target.value })}
        />
      </Field>
      <div className="flex gap-2">
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

/**
 * The activity feed (spec 21 UI): filters, a day-grouped timeline, load more,
 * and live insertion. `projectId` fixes it to one project; without it the feed
 * is the caller's whole feed, with a project filter.
 */
export function ActivityFeed({
  projectId,
  isAdmin,
}: {
  projectId?: string;
  isAdmin: boolean;
}) {
  const fixed = projectId !== undefined;
  const [form, setForm] = useState<ActivityFilterForm>(EMPTY_ACTIVITY_FILTERS);
  const [applied, setApplied] = useState<ActivityQuery>({});
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [items, setItems] = useState<ActivityItem[]>();
  const [pending, setPending] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const generation = useRef(0);
  const topRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<ActivityItem[] | undefined>(undefined);
  const pendingRef = useRef<ActivityItem[]>([]);
  itemsRef.current = items;
  pendingRef.current = pending;

  const appliedRef = useRef(applied);
  appliedRef.current = applied;

  const base = fixed ? `/projects/${projectId}/activity` : '/activity';

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
        else toast.error(describeError(err));
        setItems((current) => current ?? []);
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
    loadFirst(applied, true);
  }, [applied, loadFirst]);

  useEffect(() => {
    if (fixed) return;
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter stays empty; the feed still works.
      });
  }, [fixed]);

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
      toast.error(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const reset = () => {
    setForm(EMPTY_ACTIVITY_FILTERS);
    setApplied({});
  };

  const projectNames = useMemo(
    () => new Map(projects.map((p) => [p.id, p.displayName])),
    [projects],
  );
  const timelineItems = useMemo(
    () => (items ?? []).map((item) => toTimelineItem(item, projectNames)),
    [items, projectNames],
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

      <div className="mb-6">
        <Filters
          form={form}
          projects={projects}
          showProject={!fixed}
          onChange={(patch) => setForm((c) => ({ ...c, ...patch }))}
          onApply={() => setApplied(toActivityQuery(form))}
          onReset={reset}
        />
      </div>

      <div ref={topRef} />
      {items === undefined ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <Timeline
          items={timelineItems}
          hasMore={nextCursor !== null}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          newCount={pending.length}
          onShowNew={showNew}
          dayHeadingLevel={2}
          empty={
            <EmptyState
              title="No activity"
              description="Nothing matches these filters, or nothing has happened yet."
            />
          }
        />
      )}
    </>
  );
}
