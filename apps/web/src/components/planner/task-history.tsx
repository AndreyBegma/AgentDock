'use client';

import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import type {
  PlanTaskVersionsView,
  PlanTaskView,
  PlanTurnView,
} from '@nautelle/shared';
import { type ReactNode, useState } from 'react';
import { api } from '../../lib/api';
import { Time } from '../../lib/format/time';
import {
  TURN_ACTION_LABEL,
  TURN_PHASE_PILL,
  taskStatusView,
} from '../../lib/planner/format';
import { taskApi } from '../../lib/planner/href';
import { shownVersion, versionTurnText } from '../../lib/planner/versions';
import { useSection } from '../../lib/section/use-section';
import { useTextNotes } from '../../lib/text/use-text-notes';
import { Markdown } from '../markdown/markdown';
import { AsyncSection } from '../prerequisites/async-section';
import { NormalizedNote } from '../text/normalized-note';

/**
 * The History tab (spec 172 UI, #185): the plan versions the task appeared
 * in — version, date, the turn that produced it, the task's state then —
 * and the picked version's document, read-only. Then the task's turns.
 * Loads when the tab opens, and again when the task's current row changes.
 */
export function TaskHistory({
  projectId,
  planId,
  task,
  turns,
}: {
  projectId: string;
  planId: string;
  task: PlanTaskView;
  /** The task's turns, oldest first. */
  turns: readonly PlanTurnView[];
}) {
  const section = useSection(
    () =>
      api<PlanTaskVersionsView>(
        `${taskApi(projectId, planId, task.key)}/versions`,
      ),
    [projectId, planId, task.key, task.id, task.status, task.document],
  );
  const [picked, setPicked] = useState<number | null>(null);
  const notes = useTextNotes(projectId, { planId }, task.id);

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="task-versions" className="flex flex-col gap-2">
        <h3 id="task-versions" className="text-sm font-semibold text-ink">
          Plan versions
        </h3>
        <AsyncSection
          section={section}
          unavailable={{
            title: 'Plan versions could not be loaded',
            stillWorks: 'The current version is on the Document tab.',
          }}
          isEmpty={(view) => view.versions.length === 0}
          empty={
            <p className="text-sm text-ink-3">
              This task is in no plan version yet.
            </p>
          }
        >
          {(view) => (
            <VersionPicker
              view={view}
              picked={picked}
              onPick={setPicked}
              commentNote={
                <NormalizedNote
                  view={notes.view('plan_task', task.id, 'rewriteComment')}
                  canOperate={false}
                  onRetry={notes.retry}
                />
              }
            />
          )}
        </AsyncSection>
      </section>

      <section aria-labelledby="task-turns" className="flex flex-col gap-2">
        <h3 id="task-turns" className="text-sm font-semibold text-ink">
          Turns
        </h3>
        {turns.length === 0 ? (
          <p className="text-sm text-ink-3">No turns about this task yet.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {turns.map((t) => (
              <li
                key={t.id}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm"
              >
                <StatusPill
                  size="sm"
                  status={TURN_PHASE_PILL[t.phase]}
                  label={t.phase}
                />
                <span className="text-ink">{TURN_ACTION_LABEL[t.action]}</span>
                <span className="text-xs text-ink-3">
                  {t.author.name} · <Time value={t.createdAt} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function VersionPicker({
  view,
  picked,
  onPick,
  commentNote,
}: {
  view: PlanTaskVersionsView;
  picked: number | null;
  onPick: (version: number) => void;
  /** The current task's review-comment note; shown for the current version only. */
  commentNote: ReactNode;
}) {
  const shown = shownVersion(view, picked);
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1">
        {view.versions.map((v) => {
          const state = taskStatusView({ status: v.status, issue: null });
          const current = v.version === view.currentVersion;
          return (
            <li key={v.version}>
              <button
                type="button"
                onClick={() => onPick(v.version)}
                aria-pressed={v.version === shown?.version}
                className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-hover aria-pressed:bg-hover"
              >
                <span className="font-medium text-ink">
                  v{v.version}
                  {current ? ' · current' : ''}
                </span>
                <StatusPill
                  size="sm"
                  status={state.status}
                  label={state.label}
                />
                <span className="min-w-0 text-xs text-ink-3">
                  {versionTurnText(v.turn)} · <Time value={v.createdAt} />
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {shown ? (
        <article
          aria-label={`The task in plan version ${shown.version}`}
          className="flex flex-col gap-2 border-t border-line pt-3"
        >
          <p className="text-xs text-ink-3">
            As it was in v{shown.version}
            {shown.frozen ? ', approved and frozen' : ''}: {shown.title}
          </p>
          {shown.rewriteComment ? (
            <p className="text-sm text-ink-2">
              Rewrite asked: {shown.rewriteComment}
            </p>
          ) : null}
          {shown.rewriteComment && shown.version === view.currentVersion
            ? commentNote
            : null}
          {shown.document ? (
            <Markdown>{shown.document}</Markdown>
          ) : (
            <p className="text-sm text-ink-3">
              No document was written in this version.
            </p>
          )}
        </article>
      ) : null}
    </div>
  );
}
