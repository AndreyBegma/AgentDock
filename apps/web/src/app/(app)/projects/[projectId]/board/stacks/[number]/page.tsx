'use client';

import {
  BOARD_CHANGED_EVENT,
  type BoardStackDetail,
  DESIGN_LIVE_EVENT,
  projectRoleAtLeast,
  STACK_BODY_MAX,
  type StackCardView,
  type TaskDesignView,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select, Textarea } from '@andrewbehma/glass-ui/field';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { ArrowDown, ArrowLeft, Layers, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { MockupFrame } from '../../../../../../../components/design/mockup-frame';
import { ScaledPreview } from '../../../../../../../components/design/scaled-preview';
import { Markdown } from '../../../../../../../components/markdown/markdown';
import { useNarrow } from '../../../../../../../components/shell/narrow';
import { api } from '../../../../../../../lib/api';
import {
  addStackCard,
  fetchBoard,
  fetchStack,
  removeStackCard,
  updateStack,
} from '../../../../../../../lib/board/actions';
import {
  COLUMN_TITLE,
  describeBoardError,
  isNotFound,
  roundPill,
} from '../../../../../../../lib/board/format';
import {
  boardCardPageHref,
  boardHref,
} from '../../../../../../../lib/board/href';
import {
  addableCards,
  approvableRevision,
  currentStageText,
  designSwitch,
  gateNote,
  isGated,
  openComments,
  previewRevision,
  stageLinkText,
} from '../../../../../../../lib/board/stack-page';
import {
  DESIGN_STATUS_LABEL,
  DESIGN_STATUS_PILL,
  describeDesignError,
} from '../../../../../../../lib/design/format';
import {
  stackDesignApi,
  stackDesignHref,
} from '../../../../../../../lib/design/href';
import { mobilePreset } from '../../../../../../../lib/design/mobile-preview';
import { formatCost } from '../../../../../../../lib/format';
import { useLive } from '../../../../../../../lib/live/use-live';
import { useErrorToast } from '../../../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../../../lib/section/use-section';
import { useProjectDetail } from '../../../use-project-detail';

/** Pushes come in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

/**
 * #480 (ADR-0044): one stack on its own page, built like the #431 card
 * page — its description, its stages with their cards and the links between
 * them, and its shared design. While the design holds the stack, a banner
 * says Run is disabled on every card of it.
 */
export default function StackPage() {
  const params = useParams<{ projectId: string; number: string }>();
  const { projectId } = params;
  const number = Number(params.number);
  const validNumber = Number.isInteger(number) && number >= 1;

  const project = useProjectDetail(projectId).data;
  const canOperate = projectRoleAtLeast(project?.role ?? 'viewer', 'operator');

  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(`project:${projectId}`, (message) => {
    if (
      message.event !== BOARD_CHANGED_EVENT &&
      message.event !== DESIGN_LIVE_EVENT
    ) {
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  const reload = () => setVersion((v) => v + 1);

  const stack = useSection(
    () => fetchStack(projectId, number),
    [projectId, number, version],
  );
  const design = useSection(
    () =>
      stack.data?.design
        ? api<TaskDesignView>(stackDesignApi(projectId, number))
        : Promise.resolve(undefined),
    [projectId, number, version, stack.data?.design?.status],
  );

  const back = (
    <Link
      href={boardHref(projectId)}
      className={buttonClassName({ variant: 'ghost', size: 'sm' })}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back to the board
    </Link>
  );

  if (!validNumber || isNotFound(stack.error)) {
    return (
      <div className="flex flex-col gap-3">
        <div>{back}</div>
        <EmptyState
          title="Stack not found"
          description="It was removed, or you are not a member of its project."
        />
      </div>
    );
  }

  if (!stack.data) {
    return (
      <div className="flex flex-col gap-3">
        <div>{back}</div>
        {stack.error ? (
          <p role="alert" className="text-sm text-danger">
            {describeBoardError(stack.error)}
          </p>
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </div>
    );
  }

  return (
    <StackDetail
      projectId={projectId}
      stack={stack.data}
      design={design.data}
      canOperate={canOperate}
      back={back}
      onChanged={reload}
    />
  );
}

function StackDetail({
  projectId,
  stack,
  design,
  canOperate,
  back,
  onChanged,
}: {
  projectId: string;
  stack: BoardStackDetail;
  design: TaskDesignView | undefined;
  canOperate: boolean;
  back: React.ReactNode;
  onChanged: () => void;
}) {
  const showError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<unknown>, design = false) => {
    setBusy(true);
    try {
      await job();
      onChanged();
    } catch (error) {
      showError(
        design
          ? describeDesignError(error, projectId)
          : describeBoardError(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const gated = isGated(stack);
  const approvable = design ? approvableRevision(design) : null;
  const viewer = stackDesignHref(projectId, stack.number);
  const cost = formatCost(stack.costUsd);

  const reviewing = stack.design?.status === 'reviewing';
  const approve = approvable ? (
    <Button
      variant="solid"
      disabled={busy}
      onClick={() =>
        run(
          () =>
            api(`${stackDesignApi(projectId, stack.number)}/approve`, {
              method: 'POST',
              body: { revisionId: approvable.id },
            }),
          true,
        )
      }
    >
      Approve design
    </Button>
  ) : (
    <Link href={viewer} className={buttonClassName({ variant: 'solid' })}>
      Pick and approve
    </Link>
  );
  const generate = (
    <Button
      variant="solid"
      disabled={busy}
      onClick={() =>
        run(
          () =>
            api(`${stackDesignApi(projectId, stack.number)}/generate`, {
              method: 'POST',
            }),
          true,
        )
      }
    >
      Generate design
    </Button>
  );

  const actions = canOperate ? (
    stack.design === null ? null : stack.design.status === 'idle' ? (
      generate
    ) : reviewing ? (
      <>
        <Link href={viewer} className={buttonClassName({ variant: 'glass' })}>
          Revise design
        </Link>
        {approve}
      </>
    ) : null
  ) : null;
  // #526: below `lg` the same actions sit in a dock; Revise design opens the
  // viewer just as Open viewer does, so the dock keeps the one.
  const dock = canOperate ? (
    stack.design?.status === 'idle' ? (
      generate
    ) : reviewing ? (
      <>
        {approve}
        <Link href={viewer} className={buttonClassName({ variant: 'glass' })}>
          Open viewer
        </Link>
      </>
    ) : null
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>{back}</div>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <Chip size="sm" className="gap-1 font-mono">
              <Layers aria-hidden="true" className="size-3" />
              {stack.label}
            </Chip>
            Stack
          </span>
        }
        title={stack.title}
        status={
          stack.design ? (
            <StatusPill
              status={DESIGN_STATUS_PILL[stack.design.status]}
              label={`Design ${DESIGN_STATUS_LABEL[stack.design.status].toLowerCase()}`}
            />
          ) : undefined
        }
        meta={
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
            <span>
              <b className="text-ink tabular-nums">{stack.accepted}</b> of{' '}
              <b className="text-ink tabular-nums">{stack.total}</b> accepted
            </span>
            <span>
              Current stage{' '}
              <b className="text-ink">{currentStageText(stack)}</b>
            </span>
            {cost ? (
              <span>
                <b className="text-ink tabular-nums">{cost}</b> spent
              </span>
            ) : null}
            <span>
              Created{' '}
              <time dateTime={stack.createdAt}>
                {stack.createdAt.slice(0, 10)}
              </time>
            </span>
          </div>
        }
        actions={
          actions ? (
            // Below `lg` the same actions sit in the dock (#526).
            <div className="hidden items-center gap-2 lg:flex">{actions}</div>
          ) : undefined
        }
      />

      {gated ? (
        <Banner tone="warn" title="Run is disabled on every card of this stack">
          {gateNote(stack)}
        </Banner>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Description
            projectId={projectId}
            stack={stack}
            canOperate={canOperate}
            onSaved={onChanged}
          />
          <Stages
            projectId={projectId}
            stack={stack}
            canOperate={canOperate}
            busy={busy}
            run={run}
          />
        </div>
        <StackDesignAside
          projectId={projectId}
          stack={stack}
          design={design}
          canOperate={canOperate}
          busy={busy}
          onChanged={onChanged}
        />
      </div>

      {dock ? (
        // #526: Approve design and Open viewer stay in reach on a phone, above
        // the tab bar (3.5rem and the safe area, as its spacer).
        <>
          <div aria-hidden="true" className="h-14 lg:hidden" />
          <section
            aria-label="Design actions"
            className="glass-strong fixed inset-x-4 bottom-[calc(var(--dock-bottom)+0.5rem)] z-chrome flex items-center gap-2 rounded-sheet p-2 lg:hidden [&>*]:h-11 [&>*]:flex-1"
          >
            {dock}
          </section>
        </>
      ) : null}
    </div>
  );
}

function Description({
  projectId,
  stack,
  canOperate,
  onSaved,
}: {
  projectId: string;
  stack: BoardStackDetail;
  canOperate: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(stack.body);
  const [saving, setSaving] = useState(false);
  const showError = useErrorToast();
  const save = async () => {
    setSaving(true);
    try {
      await updateStack(projectId, stack.number, { body });
      setEditing(false);
      onSaved();
    } catch (error) {
      showError(describeBoardError(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-label="Description" className="flex flex-col gap-2">
      <SectionHeader
        title="Description"
        actions={
          canOperate ? (
            editing ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setBody(stack.body);
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" disabled={saving} onClick={save}>
                  Save
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            )
          ) : undefined
        }
      />
      {editing ? (
        <Textarea
          aria-label="Stack description"
          rows={8}
          value={body}
          maxLength={STACK_BODY_MAX}
          onChange={(e) => setBody(e.target.value)}
        />
      ) : (
        <div className="rounded-control bg-surface p-3">
          <Markdown>{stack.body || '*Nothing written yet.*'}</Markdown>
        </div>
      )}
    </section>
  );
}

function Stages({
  projectId,
  stack,
  canOperate,
  busy,
  run,
}: {
  projectId: string;
  stack: BoardStackDetail;
  canOperate: boolean;
  busy: boolean;
  run: (job: () => Promise<unknown>) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section aria-label="Stages" className="flex flex-col gap-2">
      <SectionHeader
        title="Stages"
        description="Cards in a stage may run in parallel."
        actions={
          canOperate ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={adding}
              onClick={() => setAdding((v) => !v)}
            >
              Add card
            </Button>
          ) : undefined
        }
      />
      {adding ? (
        <AddCard
          projectId={projectId}
          stack={stack}
          busy={busy}
          onAdd={(card, stage) =>
            run(() =>
              addStackCard(projectId, stack.number, { card, stage }),
            ).then(() => setAdding(false))
          }
        />
      ) : null}
      <div className="overflow-hidden rounded-surface bg-surface">
        {stack.stages.map((stage, i) => (
          <div key={stage.position}>
            {i > 0 ? (
              <p className="flex items-center gap-1.5 border-line border-y bg-hover px-3 py-1.5 text-xs text-ink-2">
                <ArrowDown aria-hidden="true" className="size-3.5" />
                {stageLinkText(stack, i)}
              </p>
            ) : null}
            <div className="flex flex-col gap-1 p-3">
              <div className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-ink tabular-nums">
                  {stage.position + 1}
                </span>
                <span className="text-sm font-semibold">
                  {stage.title || `Stage ${stage.position + 1}`}
                </span>
                {stage.position === stack.currentStage ? (
                  <Chip size="sm">Current</Chip>
                ) : null}
                <span className="ms-auto text-xs text-ink-3 tabular-nums">
                  {stage.cards.filter((c) => c.column === 'completed').length} /{' '}
                  {stage.cards.length} accepted
                </span>
              </div>
              {stage.cards.map((card) => (
                <StageRow
                  key={card.number}
                  projectId={projectId}
                  card={card}
                  gated={isGated(stack)}
                  canOperate={canOperate}
                  busy={busy}
                  onRemove={() =>
                    run(() =>
                      removeStackCard(projectId, stack.number, card.number),
                    )
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-3">
        Stages cannot be reordered once any card of the stack has run. Cards can
        still be added to or removed from a stage.
      </p>
    </section>
  );
}

function StageRow({
  projectId,
  card,
  gated,
  canOperate,
  busy,
  onRemove,
}: {
  projectId: string;
  card: StackCardView;
  gated: boolean;
  canOperate: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const pill = card.column === 'completed' ? null : roundPill(card.round);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-line border-t py-1.5 first-of-type:border-t-0">
      <span className="font-mono text-xs text-ink-3">{card.label}</span>
      <Link
        href={boardCardPageHref(projectId, card.number)}
        className="min-w-0 flex-1 truncate font-medium underline-offset-2 hover:underline"
      >
        {card.title}
      </Link>
      {card.design?.needed ? <Chip size="sm">Own design</Chip> : null}
      <Chip size="sm">{COLUMN_TITLE[card.column]}</Chip>
      {card.column === 'completed' ? (
        <StatusPill size="sm" status="done" label="Accepted" />
      ) : pill ? (
        <StatusPill size="sm" status={pill.status} label={pill.label} />
      ) : null}
      {card.after.length > 0 ? (
        <Chip size="sm" tone="warn">
          after {card.after.map((n) => `C-${n}`).join(', ')}
        </Chip>
      ) : null}
      {gated && card.column === 'todo' && card.round === null ? (
        <Tooltip content="Waits for the stack design to be approved">
          <span>
            <Button size="sm" variant="glass" disabled>
              Run
            </Button>
          </span>
        </Tooltip>
      ) : null}
      {canOperate ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove ${card.label} from the stack`}
          disabled={busy}
          onClick={onRemove}
        >
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function AddCard({
  projectId,
  stack,
  busy,
  onAdd,
}: {
  projectId: string;
  stack: BoardStackDetail;
  busy: boolean;
  onAdd: (card: number, stage: number) => void;
}) {
  const board = useSection(() => fetchBoard(projectId), [projectId]);
  const cards = addableCards(board.data);
  const [card, setCard] = useState<number | null>(null);
  const [stage, setStage] = useState(0);
  const chosen = card ?? cards[0]?.number ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-control bg-hover p-2">
      {cards.length === 0 ? (
        <p className="text-sm text-ink-3">
          {board.data ? 'No card outside a stack to add.' : 'Loading cards…'}
        </p>
      ) : (
        <>
          <Select
            aria-label="Card to add"
            value={chosen ?? ''}
            onChange={(e) => setCard(Number(e.target.value))}
          >
            {cards.map((c) => (
              <option key={c.number} value={c.number}>
                {c.label} {c.title}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Stage"
            value={stage}
            onChange={(e) => setStage(Number(e.target.value))}
          >
            {stack.stages.map((s) => (
              <option key={s.position} value={s.position}>
                Stage {s.position + 1}
                {s.title ? ` · ${s.title}` : ''}
              </option>
            ))}
            {stack.started ? null : (
              <option value={stack.stages.length}>A new last stage</option>
            )}
          </Select>
          <Button
            size="sm"
            disabled={busy || chosen === null}
            onClick={() => chosen !== null && onAdd(chosen, stage)}
          >
            Add
          </Button>
        </>
      )}
    </div>
  );
}

function StackDesignAside({
  projectId,
  stack,
  design,
  canOperate,
  busy,
  onChanged,
}: {
  projectId: string;
  stack: BoardStackDetail;
  design: TaskDesignView | undefined;
  canOperate: boolean;
  busy: boolean;
  onChanged: () => void;
}) {
  const viewer = stackDesignHref(projectId, stack.number);
  const preview = design ? previewRevision(design) : null;
  const frame = preview?.frames[0];
  const narrow = useNarrow();
  return (
    <aside
      aria-label="Stack design"
      className="flex flex-col gap-2 max-lg:order-first lg:sticky lg:top-16 lg:self-start"
    >
      <SectionHeader
        title="Stack design"
        description="The whole result. Each card’s own design is kept separately."
      />
      <div className="flex flex-col gap-3 rounded-surface bg-surface p-3">
        <DesignSwitch
          projectId={projectId}
          stack={stack}
          canOperate={canOperate}
          busy={busy}
          onChanged={onChanged}
        />
        {stack.design === null ? (
          <p className="text-sm text-ink-2">
            This stack has no shared design: its cards run without waiting for
            one.
          </p>
        ) : (
          <>
            {frame && narrow ? (
              <ScaledPreview
                src={frame.htmlUrl}
                title={`${stack.label} design · variant ${preview?.variant}`}
                preset={mobilePreset(design?.viewports ?? [])}
                href={viewer}
              />
            ) : (
              <div className="aspect-[4/3] overflow-hidden rounded-control border border-line">
                {frame ? (
                  <MockupFrame
                    src={frame.htmlUrl}
                    title={`${stack.label} design · variant ${preview?.variant}`}
                    theme="light"
                    pinMode={false}
                    pins={[]}
                    onPin={() => {}}
                    onWheel={() => {}}
                  />
                ) : (
                  <div className="flex size-full items-center justify-center text-sm text-ink-3">
                    Not drawn yet
                  </div>
                )}
              </div>
            )}
            <KeyValueList
              dense
              items={[
                {
                  key: 'state',
                  label: 'State',
                  value: (
                    <StatusPill
                      size="sm"
                      status={DESIGN_STATUS_PILL[stack.design.status]}
                      label={DESIGN_STATUS_LABEL[stack.design.status]}
                    />
                  ),
                },
                {
                  key: 'revisions',
                  label: 'Revisions',
                  value: design?.revisions.length ?? 0,
                },
                {
                  key: 'comments',
                  label: 'Comments',
                  value: design ? `${openComments(design)} open` : '—',
                },
                {
                  key: 'used',
                  label: 'Used by',
                  value:
                    'Each card’s design turn and worker prompt, as reference',
                },
              ]}
            />
            <div className="flex flex-wrap gap-2">
              <Link
                href={viewer}
                className={buttonClassName({
                  variant: 'glass',
                  size: 'sm',
                  className: 'max-lg:h-11',
                })}
              >
                Open full size
              </Link>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * #502: "Stack design required" — off lifts the design-first gate, on holds
 * it until the design is approved. Revisions and the approval are kept
 * either way. It flips at once and returns if the request fails; it is
 * locked while a design turn runs, and read-only to a viewer.
 */
function DesignSwitch({
  projectId,
  stack,
  canOperate,
  busy,
  onChanged,
}: {
  projectId: string;
  stack: BoardStackDetail;
  canOperate: boolean;
  busy: boolean;
  onChanged: () => void;
}) {
  const showError = useErrorToast();
  const { required, locked } = designSwitch(stack);
  const [pending, setPending] = useState<boolean | null>(null);
  // A fresh stack carries the outcome; the optimistic value has done its job.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every refetch
  useEffect(() => setPending(null), [stack]);
  const disabled = !canOperate || locked || busy || pending !== null;
  const toggle = async (needed: boolean) => {
    setPending(needed);
    try {
      await api(stackDesignApi(projectId, stack.number), {
        method: 'PATCH',
        body: { needed },
      });
      onChanged();
    } catch (error) {
      setPending(null);
      showError(describeDesignError(error, projectId));
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-control bg-hover px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          id="stack-design-required"
          className="text-sm font-medium text-ink"
        >
          Stack design required
        </span>
        <span className="text-xs text-ink-3">
          {locked
            ? 'A design turn is running. Stop it first.'
            : 'No card of the stack runs until the design is approved.'}
        </span>
      </span>
      <span
        inert={disabled || undefined}
        className={disabled ? 'opacity-60' : undefined}
      >
        <Toggle
          labelledBy="stack-design-required"
          checked={pending ?? required}
          onChange={toggle}
        />
      </span>
    </div>
  );
}
