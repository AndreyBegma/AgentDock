'use client';

import {
  type PlanDetail,
  type PlannerSettingsView,
  type PlanTaskView,
  projectRoleAtLeast,
  type UiProfileView,
} from '@agentdock/shared';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Conversation } from '../../../../../../components/planner/conversation';
import { PlanGraph } from '../../../../../../components/planner/plan-graph';
import { PlanHeader } from '../../../../../../components/planner/plan-header';
import { RewriteDialog } from '../../../../../../components/planner/rewrite-dialog';
import { SendDialog } from '../../../../../../components/planner/send-dialog';
import {
  type ReviewDecision,
  TaskCard,
} from '../../../../../../components/planner/task-card';
import { TaskPanel } from '../../../../../../components/planner/task-panel';
import { AsyncSection } from '../../../../../../components/prerequisites/async-section';
import { useCurrentUser } from '../../../../../../components/shell/user-context';
import { api } from '../../../../../../lib/api';
import { uiProfileApi } from '../../../../../../lib/design/href';
import {
  activeTurn,
  describePlannerError,
  failedTurn,
  isNotFound,
  turnsOf,
  writeBlock,
} from '../../../../../../lib/planner/format';
import { approvableDrafts } from '../../../../../../lib/planner/header';
import { planHref, plannerHref } from '../../../../../../lib/planner/href';
import { pastRounds } from '../../../../../../lib/planner/rounds';
import { usePlan } from '../../../../../../lib/planner/use-plan';
import { useSection } from '../../../../../../lib/section/use-section';
import { useProjectDetail } from '../../use-project-detail';

/**
 * A plan (spec 172 UI): the task cards on the left, the plan graph in the
 * centre — or, in dialogue mode before decomposition, the plan-level question
 * rounds — and the selected task's panel on the right. `?task=<key>` selects
 * a task; it is the deep link `/tasks` rows open.
 */
export default function PlanPage() {
  const { projectId, planId } = useParams<{
    projectId: string;
    planId: string;
  }>();
  const router = useRouter();
  const search = useSearchParams();
  const selectedKey = search.get('task');
  const select = (key: string | null) =>
    router.replace(planHref(projectId, planId, key), { scroll: false });

  const user = useCurrentUser();
  const project = useProjectDetail(projectId).data;
  const role = project?.role ?? 'viewer';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const section = usePlan(projectId, planId);
  const settings = useSection(
    () => api<PlannerSettingsView>(`/projects/${projectId}/planner/settings`),
    [projectId],
  );
  // D3: a project whose profile says it has no UI hides the design toggle.
  // A profile that does not load is treated as none: the toggle shows.
  const profile = useSection(
    () => api<UiProfileView>(uiProfileApi(projectId)),
    [projectId],
  );

  if (section.data === undefined && isNotFound(section.error)) {
    return (
      <EmptyState
        title="Plan not found"
        description="It was removed, or it is private to its author."
        action={
          <Link
            href={plannerHref(projectId)}
            className={buttonClassName({ variant: 'glass' })}
          >
            Open the Planner
          </Link>
        }
      />
    );
  }

  return (
    <AsyncSection
      section={section}
      unavailable={{
        title: 'The plan could not be loaded',
        stillWorks: 'Fleet, queue and history are still available.',
      }}
      empty={null}
    >
      {(plan) => (
        <PlanView
          plan={plan}
          projectId={projectId}
          selectedKey={selectedKey}
          onSelect={select}
          isAuthor={plan.author.id === user.id}
          isProjectAdmin={role === 'admin'}
          canOperate={canOperate}
          specOutput={settings.data?.specOutput}
          busy={section.busy}
          actions={section.actions}
          hasUi={profile.data?.current?.hasUi ?? null}
          onRefresh={section.retry}
          onArchived={() => router.push(plannerHref(projectId))}
        />
      )}
    </AsyncSection>
  );
}

type Plan = ReturnType<typeof usePlan>;

function PlanView({
  plan,
  projectId,
  selectedKey,
  onSelect,
  isAuthor,
  isProjectAdmin,
  canOperate,
  specOutput,
  busy,
  actions,
  hasUi,
  onRefresh,
  onArchived,
}: {
  plan: PlanDetail;
  projectId: string;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  isAuthor: boolean;
  isProjectAdmin: boolean;
  canOperate: boolean;
  specOutput: PlannerSettingsView['specOutput'] | undefined;
  busy: Plan['busy'];
  actions: Plan['actions'];
  /** The UI profile's `hasUi`; null with no profile (spec 223 D3). */
  hasUi: boolean | null;
  onRefresh: () => void;
  onArchived: () => void;
}) {
  const [rewriting, setRewriting] = useState<PlanTaskView | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [archiving, setArchiving] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const block = writeBlock(plan, canOperate);
  const canWrite = block === null;
  const active = activeTurn(plan);
  const selected = plan.tasks.find((t) => t.key === selectedKey) ?? null;
  const drafts = approvableDrafts(plan);

  // On a phone the panel stacks below the cards: bring it into view.
  useEffect(() => {
    if (selectedKey && window.matchMedia('(max-width: 1023px)').matches) {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedKey]);

  // One turn is active or failed per scope, so a cancel or a retry in
  // flight belongs to whichever scope shows its button.
  const turnBusy =
    busy?.kind === 'cancel' || busy?.kind === 'retry' ? busy.kind : null;

  const conversationFor = (taskKey: string | null) => {
    const turns = turnsOf(plan.turns, taskKey);
    const scopedActive = active && active.taskKey === taskKey ? active : null;
    const failed = failedTurn(plan.turns, taskKey);
    const task = taskKey
      ? plan.tasks.find((t) => t.key === taskKey)
      : undefined;
    const elsewhere =
      active && !scopedActive ? 'Another turn of this plan is running.' : null;
    return (
      <Conversation
        key={taskKey ?? 'plan'}
        projectId={projectId}
        label={
          taskKey
            ? `Message the planner about ${taskKey}`
            : 'Message the planner'
        }
        turns={turns}
        rounds={pastRounds(plan.turns, taskKey)}
        questions={taskKey ? (task?.questions ?? []) : plan.questions}
        active={scopedActive}
        failed={scopedActive ? null : failed}
        canWrite={canWrite && elsewhere === null}
        writeReason={block ?? elsewhere ?? undefined}
        busy={turnBusy}
        chat={taskKey !== null || plan.tasks.length === 0}
        onAnswers={(answers) =>
          taskKey
            ? actions.taskTurn(taskKey, { answers })
            : actions.planTurn({ answers })
        }
        onMessage={(message) =>
          taskKey
            ? actions.taskTurn(taskKey, { message })
            : actions.planTurn({ message })
        }
        onCancel={() => {
          if (scopedActive) {
            void actions.cancelTurn(scopedActive.id).catch(() => {});
          }
        }}
        onRetry={() => {
          if (failed) void actions.retryTurn(failed.id).catch(() => {});
        }}
      />
    );
  };

  const review = (task: PlanTaskView, decision: ReviewDecision) => {
    if (decision === 'rewrite') {
      setRewriting(task);
      return;
    }
    void actions.review(task.key, decision).catch(() => {});
  };

  const send = async () => {
    setSendError(undefined);
    try {
      await actions.send();
      setSending(false);
    } catch (error) {
      setSendError(describePlannerError(error));
    }
  };

  // Before decomposition there are no tasks: the plan-level conversation is
  // the whole page (dialogue mode's rounds, or batch mode's first turn).
  const planLevel = plan.tasks.length === 0;
  const planActive = active && active.taskKey === null;
  const planFailed = !planActive ? failedTurn(plan.turns, null) : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PlanHeader
        plan={plan}
        projectId={projectId}
        isAuthor={isAuthor}
        canWrite={canWrite}
        busy={busy !== null}
        approveCount={drafts.length}
        onShare={() => void actions.setVisibility('project').catch(() => {})}
        onApproveAll={() =>
          void actions.approveAll(drafts.map((t) => t.key)).catch(() => {})
        }
        onRevise={() => void actions.revise().catch(() => {})}
        onSend={() => {
          setSendError(undefined);
          setSending(true);
        }}
        onArchive={isAuthor || isProjectAdmin ? () => setArchiving(true) : null}
      />

      {planLevel ? (
        <section
          aria-labelledby="plan-questions"
          className="flex max-w-3xl flex-col gap-3"
        >
          <SectionHeader
            headingId="plan-questions"
            title={
              plan.mode === 'dialogue'
                ? 'Questions about the brief'
                : 'Splitting the brief'
            }
          />
          {conversationFor(null)}
        </section>
      ) : (
        <>
          {planActive || planFailed ? (
            <section aria-label="Plan turn" className="max-w-3xl">
              {conversationFor(null)}
            </section>
          ) : null}
          {/*
           * Tasks | graph, and the panel on the right once a task is open.
           * Three columns only fit at 2xl: below it a graph squeezed beside
           * the panel is drawn too small to read, so with a task open the
           * graph takes a full row above the tasks and the panel. On a phone
           * everything stacks, graph first.
           */}
          <div
            className={`grid min-w-0 gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] ${
              selected
                ? '2xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,440px)]'
                : ''
            }`}
          >
            <section
              aria-labelledby="plan-tasks"
              className={`flex min-w-0 flex-col gap-3 ${
                selected ? 'lg:order-2 2xl:order-1' : 'lg:order-1'
              }`}
            >
              <SectionHeader
                headingId="plan-tasks"
                title={
                  <>
                    Tasks{' '}
                    <span className="font-normal text-ink-3">
                      ({plan.tasks.length})
                    </span>
                  </>
                }
              />
              {plan.tasks.map((task) => (
                <TaskCard
                  key={task.key}
                  projectId={projectId}
                  planId={plan.id}
                  task={task}
                  selected={task.key === selectedKey}
                  canReview={canWrite && active === null}
                  canDesign={canWrite}
                  hasUi={hasUi}
                  busy={busy !== null}
                  onSelect={() =>
                    onSelect(task.key === selectedKey ? null : task.key)
                  }
                  onReview={(d) => review(task, d)}
                  onDesignChanged={onRefresh}
                />
              ))}
            </section>
            <section
              aria-labelledby="plan-graph"
              className={`order-first flex min-w-0 flex-col gap-3 ${
                selected
                  ? 'lg:order-1 lg:col-span-2 2xl:order-2 2xl:col-span-1'
                  : 'lg:order-2'
              }`}
            >
              <SectionHeader headingId="plan-graph" title="Dependencies" />
              <PlanGraph
                plan={plan}
                selectedKey={selectedKey}
                onSelect={onSelect}
              />
            </section>
            {selected ? (
              <div ref={panelRef} className="min-w-0 scroll-mt-4 lg:order-3">
                <TaskPanel
                  key={selected.key}
                  projectId={projectId}
                  planId={plan.id}
                  task={selected}
                  turns={turnsOf(plan.turns, selected.key)}
                  conversation={conversationFor(selected.key)}
                  onClose={() => onSelect(null)}
                />
              </div>
            ) : null}
          </div>
        </>
      )}

      <RewriteDialog
        task={rewriting}
        busy={busy?.kind === 'review'}
        onOpenChange={(open) => {
          if (!open) setRewriting(null);
        }}
        onSubmit={(comment) =>
          rewriting
            ? actions.review(rewriting.key, 'rewrite', comment)
            : Promise.resolve()
        }
      />
      <SendDialog
        plan={plan}
        open={sending}
        specOutput={specOutput}
        busy={busy?.kind === 'send' || busy?.kind === 'visibility'}
        error={sendError}
        onOpenChange={setSending}
        onConfirm={() => void send()}
      />
      <ConfirmDialog
        open={archiving}
        onOpenChange={(o) => busy === null && setArchiving(o)}
        title="Archive this plan?"
        consequence="The plan stays readable, takes no more turns, and its worktree on the runner is removed. Issues already created are not touched."
        verb="Archive"
        tone="danger"
        busy={busy?.kind === 'archive'}
        onConfirm={() =>
          void actions
            .archive()
            .then(() => {
              setArchiving(false);
              onArchived();
            })
            .catch(() => {})
        }
      />
    </div>
  );
}
