'use client';

import type {
  CreatePlanRequest,
  DiscussProposal,
  InstalledSkillsView,
  PlanSummary,
  ProjectDetail,
} from '@agentdock/shared';
import { DISCUSS_SKILLS_MAX } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { Combobox } from '@andrewbehma/glass-ui/combobox';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { SendHorizontal, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import {
  DISCUSS_MESSAGE_MAX,
  DISCUSS_OPENING_MAX,
  type DiscussEntry,
  discussionEntries,
  discussionFailed,
  discussionSkills,
  proposalBrief,
} from '../../lib/board/discuss';
import { installedSkillsApi } from '../../lib/design/href';
import { formatDate } from '../../lib/format';
import { activeTurn, describePlannerError } from '../../lib/planner/format';
import { runnerGate, runnerGateCopy } from '../../lib/planner/runner-support';
import { usePlan } from '../../lib/planner/use-plan';
import { useSection } from '../../lib/section/use-section';
import { Markdown } from '../markdown/markdown';
import { FailedTurn } from '../planner/failed-turn';
import { RunningTurn } from '../planner/running-turn';
import { DisabledReason } from '../prerequisites/disabled-reason';

/**
 * #590 (ADR-0054, design 1): below `sm` the dialog opens full screen with no
 * radius; below `lg` it keeps a 16px gutter and every control is 44px, the
 * text inputs 16px so iOS does not zoom on focus.
 */
const DIALOG_CLASS =
  'flex flex-col sm:max-w-3xl max-lg:p-4 max-lg:[--size-control:44px] max-lg:[--size-field:44px] max-lg:[&_textarea]:text-base max-lg:[&_input]:text-base max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none';

/**
 * **Discuss** (#590): a free conversation with the planning model about the
 * project — questions about the code and the architecture, or an analysis
 * with the skills picked at the start. It reads the repository on the
 * runner, read-only, and has no round limit and no required result. A reply
 * may propose cards; **Make a card** opens New work with What to do filled
 * in. Closing keeps the discussion in Drafts.
 */
export function DiscussDialog({
  projectId,
  project,
  open,
  planId: controlledId,
  onOpenChange,
  onStarted,
  onMakeCard,
  onDiscarded,
}: {
  projectId: string;
  /** The runner gate reads it; absent, Start is not gated before the API answers. */
  project?: ProjectDetail;
  open: boolean;
  /** The discussion shown — the Board's `?discussion=`, a Drafts Resume. */
  planId?: string;
  onOpenChange: (open: boolean) => void;
  onStarted: (planId: string) => void;
  /** **Make a card**: New work with What to do prefilled. */
  onMakeCard: (brief: string) => void;
  onDiscarded: (planId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      {controlledId ? (
        <DiscussionView
          projectId={projectId}
          planId={controlledId}
          onMakeCard={onMakeCard}
          onDiscarded={() => onDiscarded(controlledId)}
        />
      ) : (
        <DialogContent
          title="Discuss"
          description="Ask about the code or the architecture, or ask for an analysis. Nothing in the repository changes, and a discussion doesn't have to end in a card."
          className={`${DIALOG_CLASS} sm:max-w-xl`}
        >
          <StartForm
            projectId={projectId}
            project={project}
            open={open}
            busy={busy}
            setBusy={setBusy}
            onCancel={() => onOpenChange(false)}
            onStarted={onStarted}
          />
        </DialogContent>
      )}
    </DialogRoot>
  );
}

function StartForm({
  projectId,
  project,
  open,
  busy,
  setBusy,
  onCancel,
  onStarted,
}: {
  projectId: string;
  project?: ProjectDetail;
  open: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onStarted: (planId: string) => void;
}) {
  const [question, setQuestion] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const installed = useSection(
    () =>
      open
        ? api<InstalledSkillsView>(installedSkillsApi(projectId))
        : Promise.resolve(undefined),
    [projectId, open],
  );
  const options = useMemo(
    () =>
      [...new Set((installed.data?.items ?? []).map((s) => s.invocation))]
        .sort()
        .map((name) => ({ value: name, label: name })),
    [installed.data],
  );

  const gate = runnerGate(project, 'planner');
  const gateCopy = gate ? runnerGateCopy('planner', gate) : null;
  const valid = question.trim() !== '' && gate === null && !busy;

  const start = async () => {
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    const request: CreatePlanRequest = {
      brief: question.trim(),
      mode: 'discuss',
      ...(skills.length > 0 ? { skills } : {}),
    };
    try {
      const plan = await api<PlanSummary>(`/projects/${projectId}/plans`, {
        method: 'POST',
        body: request,
      });
      setQuestion('');
      setSkills([]);
      onStarted(plan.id);
    } catch (err) {
      setError(describePlannerError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <Field
        label="Skills"
        hint={
          installed.error
            ? 'The installed skills could not be listed.'
            : "Optional. The project's installed skills; the chosen ones apply to every turn of this discussion."
        }
      >
        <Combobox
          multiple
          aria-label="Skills"
          options={options}
          value={skills}
          disabled={busy}
          placeholder="Add a skill"
          onValueChange={(next) => setSkills(next.slice(0, DISCUSS_SKILLS_MAX))}
        />
      </Field>
      <Field label="Question" htmlFor="board-discuss-question">
        <Textarea
          id="board-discuss-question"
          rows={6}
          value={question}
          maxLength={DISCUSS_OPENING_MAX}
          disabled={busy}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => submitOnModEnter(e, () => void start())}
        />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {gateCopy ? (
        <DisabledReason href={gateCopy.href} cta={gateCopy.cta}>
          {gateCopy.reason}
        </DisabledReason>
      ) : null}
      <div className="flex justify-end gap-2 max-sm:mt-auto max-sm:[&>*]:flex-1">
        <Button variant="glass" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid}>
          {busy ? 'Starting…' : 'Start discussion'}
        </Button>
      </div>
    </form>
  );
}

/** ⌘↵ / Ctrl+↵ sends; plain Enter is a newline. */
const submitOnModEnter = (
  event: KeyboardEvent<HTMLTextAreaElement>,
  submit: () => void,
) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    submit();
  }
};

/**
 * One discussion: its header (title, skills, read-only, Discard), the
 * thread, the running or failed turn, and the composer.
 */
function DiscussionView({
  projectId,
  planId,
  onMakeCard,
  onDiscarded,
}: {
  projectId: string;
  planId: string;
  onMakeCard: (brief: string) => void;
  onDiscarded: () => void;
}) {
  const section = usePlan(projectId, planId);
  const { actions, busy } = section;
  const plan = section.data;
  const [discarding, setDiscarding] = useState(false);

  if (!plan) {
    return (
      <DialogContent title="Discussion" className={DIALOG_CLASS}>
        {section.error ? (
          <Banner
            tone="danger"
            title="The discussion could not be loaded"
            action={
              <Button size="sm" variant="glass" onClick={section.retry}>
                Try again
              </Button>
            }
          >
            {describePlannerError(section.error)}
          </Banner>
        ) : (
          <Skeleton className="h-48 w-full" />
        )}
      </DialogContent>
    );
  }

  const closed = plan.status !== 'clarifying';
  const active = activeTurn(plan);
  const failed = active ? null : discussionFailed(plan);
  const skills = discussionSkills(plan);

  const discard = async () => {
    try {
      await actions.archive();
      toast.success('Discussion discarded.');
      setDiscarding(false);
      onDiscarded();
    } catch {
      // Toasted by `usePlan`.
    }
  };

  return (
    <DialogContent
      title={plan.title}
      description={`Started ${formatDate(plan.createdAt, 'datetime')}`}
      className={DIALOG_CLASS}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {skills.length > 0 ? (
            <ul
              aria-label="Skills"
              className="flex min-w-0 gap-1.5 max-sm:flex-1 max-sm:overflow-x-auto"
            >
              {skills.map((s) => (
                <li key={s} className="shrink-0">
                  <Chip size="md">{s}</Chip>
                </li>
              ))}
            </ul>
          ) : null}
          <span className="text-xs text-ink-3">
            <span className="font-medium text-ink-2">Read-only</span> · no file
            in the project changes
          </span>
          {!closed ? (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              aria-label="Discard"
              disabled={busy !== null || active !== null}
              onClick={() => setDiscarding(true)}
            >
              <Trash2 className="size-4 sm:hidden" aria-hidden="true" />
              <span className="max-sm:sr-only">Discard</span>
            </Button>
          ) : null}
        </div>

        <ol
          aria-label="Messages"
          className="flex min-w-0 flex-col gap-4"
          aria-live="polite"
        >
          {discussionEntries(plan).map((entry) => (
            <li key={entry.id} className="min-w-0">
              <Entry
                entry={entry}
                skills={skills}
                canMake={!closed}
                onMakeCard={onMakeCard}
              />
            </li>
          ))}
        </ol>

        {active ? (
          <RunningTurn
            projectId={projectId}
            turn={active}
            canCancel={!closed}
            cancelling={busy?.kind === 'cancel'}
            onCancel={() => void actions.cancelTurn(active.id).catch(() => {})}
          />
        ) : null}
        {failed ? (
          <FailedTurn
            turn={failed}
            canRetry={!closed}
            retrying={busy?.kind === 'retry'}
            onRetry={() => void actions.retryTurn(failed.id).catch(() => {})}
          />
        ) : null}

        {closed ? (
          <Banner tone="info" title="This discussion was discarded">
            Cards already made from its proposals stay on the Board.
          </Banner>
        ) : (
          <Composer
            waiting={active !== null}
            disabled={busy !== null && busy.kind !== 'cancel'}
            onSend={(message) =>
              actions.planTurn({ message }).then(() => undefined)
            }
          />
        )}
      </div>
      <ConfirmDialog
        open={discarding}
        onOpenChange={(next) => {
          if (!next && busy?.kind !== 'archive') setDiscarding(false);
        }}
        title={`Discard “${plan.title}”?`}
        consequence="The discussion is archived and leaves Drafts. Cards already made from its proposals stay on the Board."
        verb="Discard"
        tone="danger"
        busy={busy?.kind === 'archive'}
        onConfirm={() => void discard()}
      />
    </DialogContent>
  );
}

function Entry({
  entry,
  skills,
  canMake,
  onMakeCard,
}: {
  entry: DiscussEntry;
  skills: readonly string[];
  canMake: boolean;
  onMakeCard: (brief: string) => void;
}) {
  if (entry.kind === 'person') {
    return (
      <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1 max-sm:max-w-full">
        <p className="rounded-control bg-hover px-3 py-2 text-sm whitespace-pre-line break-words text-ink">
          {entry.text}
        </p>
        <time dateTime={entry.at} className="text-xs text-ink-3">
          {formatDate(entry.at, 'time')}
        </time>
      </div>
    );
  }
  if (entry.kind === 'unanswered') {
    return (
      <p className="text-xs text-ink-3">
        No reply — the turn{' '}
        {entry.turn.phase === 'cancelled' ? 'was cancelled' : 'failed'}.
      </p>
    );
  }
  return (
    <article className="flex min-w-0 flex-col gap-3">
      <header className="text-xs text-ink-3">
        <span className="font-medium text-ink-2">Planner</span>
        {skills.length > 0 ? ` · ${skills.join(', ')}` : ''} ·{' '}
        <time dateTime={entry.at}>{formatDate(entry.at, 'time')}</time>
      </header>
      <div className="min-w-0 break-words">
        <Markdown>{entry.reply}</Markdown>
      </div>
      {entry.proposals.length > 0 ? (
        <Proposals
          proposals={entry.proposals}
          canMake={canMake}
          onMakeCard={onMakeCard}
        />
      ) : null}
    </article>
  );
}

function Proposals({
  proposals,
  canMake,
  onMakeCard,
}: {
  proposals: readonly DiscussProposal[];
  canMake: boolean;
  onMakeCard: (brief: string) => void;
}) {
  return (
    <section
      aria-label="Proposed cards"
      className="flex flex-col gap-2 rounded-control border border-line p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-ink">
          Proposed cards · {proposals.length}
        </h3>
        <span className="text-xs text-ink-3">
          Make a card opens New work with What to do filled in
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {proposals.map((p) => (
          <li
            key={p.title}
            className="flex min-w-0 flex-col gap-2 rounded-control bg-hover p-3 sm:flex-row sm:items-start"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium break-words text-ink">
                {p.title}
              </span>
              <p className="text-sm whitespace-pre-line break-words text-ink-2">
                {p.brief}
              </p>
            </div>
            {canMake ? (
              <Button
                size="sm"
                variant="glass"
                className="shrink-0 max-sm:w-full"
                onClick={() => onMakeCard(proposalBrief(p))}
              >
                Make a card
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The next message. The person can keep writing while a turn runs; Send
 * waits for the planner's reply. ⌘↵ sends.
 */
function Composer({
  waiting,
  disabled,
  onSend,
}: {
  waiting: boolean;
  disabled: boolean;
  onSend: (message: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const message = draft.trim();
  const canSend = message !== '' && !waiting && !disabled;

  const send = async () => {
    if (!canSend) return;
    try {
      await onSend(message);
      setDraft('');
    } catch {
      // Toasted by `usePlan`; the draft stays.
    }
  };

  return (
    <form
      className="sticky bottom-0 flex flex-col gap-1.5 bg-inherit pb-[env(safe-area-inset-bottom)]"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label="Message" htmlFor="board-discuss-message">
            <Textarea
              id="board-discuss-message"
              rows={2}
              value={draft}
              maxLength={DISCUSS_MESSAGE_MAX}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => submitOnModEnter(e, () => void send())}
            />
          </Field>
        </div>
        <Button type="submit" disabled={!canSend} aria-label="Send">
          <SendHorizontal className="size-4 sm:hidden" aria-hidden="true" />
          <span className="max-sm:sr-only">Send</span>
        </Button>
      </div>
      <p className="flex justify-between gap-3 text-xs text-ink-3">
        <span>
          {waiting
            ? "You can keep writing; Send waits for the planner's reply."
            : 'Ask anything about the code.'}
        </span>
        <span className="hidden pointer-fine:inline">⌘↵ to send</span>
      </p>
    </form>
  );
}
