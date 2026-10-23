'use client';

import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { Section } from '@andrewbehma/glass-ui/section';
import type {
  CreatePlanCardsResponse,
  PlanDetail,
  PlannerSettingsView,
  PlanTaskView,
} from '@nautelle/shared';
import { useEffect, useRef, useState } from 'react';
import {
  activeTurn,
  describePlannerError,
  failedTurn,
  turnsOf,
  writeBlock,
} from '../../lib/planner/format';
import { approvableDrafts, sharePlanCopy } from '../../lib/planner/header';
import { pastRounds } from '../../lib/planner/rounds';
import type { usePlan } from '../../lib/planner/use-plan';
import { ConfirmGate } from '../confirm/confirm-gate';
import { NARROW_QUERY } from '../shell/narrow';
import { Conversation } from './conversation';
import { PlanGraph } from './plan-graph';
import { PlanHeader } from './plan-header';
import { RewriteDialog } from './rewrite-dialog';
import { SendDialog } from './send-dialog';
import { type ReviewDecision, TaskCard } from './task-card';
import { TaskPanel } from './task-panel';

type Plan = ReturnType<typeof usePlan>;

/** #337 D11: why the retired Planner page does not take a turn. */
export const READ_ONLY_REASON =
  'This plan is read-only here. New work starts on the Board.';

/**
 * A plan (spec 172 UI): the task cards, the plan graph — or, in dialogue
 * mode before decomposition, the plan-level question rounds — and the
 * selected task's panel. It is the Board's plan panel (#337 D7), where it
 * ends in **Create cards** or **Send to fleet**, and the retired Planner
 * page, where it is `readOnly` (D11). `compact` stacks everything in one
 * column, for the panel.
 */
export function PlanWorkspace({
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
  onCardsCreated,
  readOnly = false,
  compact = false,
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
  /** #337 D7: Create cards is offered when this is given. */
  onCardsCreated?: (created: CreatePlanCardsResponse) => void;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const [rewriting, setRewriting] = useState<PlanTaskView | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [archiving, setArchiving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [creatingCards, setCreatingCards] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const block = readOnly ? READ_ONLY_REASON : writeBlock(plan, canOperate);
  const canWrite = block === null;
  const active = activeTurn(plan);
  const selected = plan.tasks.find((t) => t.key === selectedKey) ?? null;
  const drafts = approvableDrafts(plan);

  // On a phone the panel stacks below the cards: bring it into view.
  useEffect(() => {
    if (selectedKey && (compact || window.matchMedia(NARROW_QUERY).matches)) {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedKey, compact]);

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
        chat={!readOnly && (taskKey !== null || plan.tasks.length === 0)}
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

  const createCards = async () => {
    try {
      const created = await actions.createCards();
      setCreatingCards(false);
      onCardsCreated?.(created);
    } catch {
      // Toasted by the hook; the dialog stays for another try.
    }
  };

  // Before decomposition there are no tasks: the plan-level conversation is
  // the whole view (dialogue mode's rounds, or batch mode's first turn).
  const planLevel = plan.tasks.length === 0;
  const planActive = active && active.taskKey === null;
  const planFailed = !planActive ? failedTurn(plan.turns, null) : null;

  const grid = compact
    ? 'grid min-w-0 gap-6'
    : `grid min-w-0 gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] ${
        selected
          ? '2xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,440px)]'
          : ''
      }`;
  const tasksOrder = compact
    ? ''
    : selected
      ? 'lg:order-2 2xl:order-1'
      : 'lg:order-1';
  const graphOrder = compact
    ? 'order-first'
    : `order-first ${
        selected
          ? 'lg:order-1 lg:col-span-2 2xl:order-2 2xl:col-span-1'
          : 'lg:order-2'
      }`;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PlanHeader
        plan={plan}
        projectId={projectId}
        isAuthor={isAuthor}
        canWrite={canWrite}
        busy={busy !== null}
        approveCount={drafts.length}
        readOnly={readOnly}
        onShare={() => setSharing(true)}
        onApproveAll={() =>
          void actions.approveAll(drafts.map((t) => t.key)).catch(() => {})
        }
        onRevise={() => void actions.revise().catch(() => {})}
        onSend={() => {
          setSendError(undefined);
          setSending(true);
        }}
        onArchive={isAuthor || isProjectAdmin ? () => setArchiving(true) : null}
        onCreateCards={onCardsCreated ? () => setCreatingCards(true) : null}
      />

      {planLevel ? (
        <Section
          surface="none"
          pad="none"
          className="max-w-3xl"
          title={
            plan.mode === 'dialogue'
              ? 'Questions about the brief'
              : 'Splitting the brief'
          }
        >
          {conversationFor(null)}
        </Section>
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
           * — and in the Board's panel — everything stacks, graph first.
           */}
          <div className={grid}>
            <Section
              surface="none"
              pad="none"
              title="Tasks"
              className={`min-w-0 ${tasksOrder}`}
              bodyClassName="flex flex-col gap-3"
            >
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
            </Section>
            <Section
              surface="none"
              pad="none"
              title="Dependencies"
              className={`min-w-0 ${graphOrder}`}
            >
              <PlanGraph
                plan={plan}
                selectedKey={selectedKey}
                onSelect={onSelect}
              />
            </Section>
            {selected ? (
              <div
                ref={panelRef}
                className={`min-w-0 scroll-mt-4 ${compact ? '' : 'lg:order-3'}`}
              >
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
        open={creatingCards}
        onOpenChange={(o) => busy === null && setCreatingCards(o)}
        title={`Create ${plan.tasks.length === 1 ? 'one card' : `${plan.tasks.length} cards`}?`}
        consequence="Each task becomes a card in Todo, with Depends on links like the graph. A plan makes its cards once; the plan is then done."
        verb="Create cards"
        busy={busy?.kind === 'cards'}
        onConfirm={() => void createCards()}
      />
      <ConfirmGate
        pending={sharing ? plan : undefined}
        copy={sharePlanCopy}
        busy={busy?.kind === 'visibility'}
        onConfirm={() =>
          void actions
            .setVisibility('project')
            .then(() => setSharing(false))
            .catch(() => {})
        }
        onCancel={() => setSharing(false)}
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
