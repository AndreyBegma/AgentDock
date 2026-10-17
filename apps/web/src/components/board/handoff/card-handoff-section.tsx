'use client';

import type { CardHandoffView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useState } from 'react';
import { Time } from '../../../lib/format/time';
import {
  fetchCardHandoff,
  saveCardHandoff,
} from '../../../lib/handoff/actions';
import {
  describeHandoffError,
  draftProblems,
  type HandoffFailure,
  noteGroups,
  UPDATED_BY_LABEL,
} from '../../../lib/handoff/format';
import { useSection } from '../../../lib/section/use-section';

function Problems({ failure }: { failure: HandoffFailure }) {
  return (
    <div role="alert" className="flex flex-col gap-1 text-sm text-danger-ink">
      <p>{failure.message}</p>
      {failure.reasons.length > 0 ? (
        <ul className="list-disc pl-5">
          {failure.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function NoteBody({ note }: { note: NonNullable<CardHandoffView['note']> }) {
  return (
    <div className="flex flex-col gap-3">
      {noteGroups(note.content, note.personLines).map((group) => (
        <div
          key={`${group.heading ?? 'intro'}-${group.lines[0]?.line ?? 0}`}
          className="flex flex-col gap-1"
        >
          {group.heading ? (
            <h4 className="text-xs font-medium uppercase tracking-wide text-ink-3">
              {group.heading}
            </h4>
          ) : null}
          <div className="flex flex-col text-sm text-ink-1">
            {group.lines.map((line) =>
              line.text.trim() === '' ? (
                <span key={line.line} className="h-2" />
              ) : (
                <span
                  key={line.line}
                  data-person-line={line.person ? '' : undefined}
                  className={
                    line.person
                      ? 'whitespace-pre-wrap break-words rounded-sm border-l-2 border-accent-ink bg-accent-ink/10 pl-2'
                      : 'whitespace-pre-wrap break-words'
                  }
                >
                  {line.text}
                </span>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * #449 D7: the card's handoff note in the sheet — its sections, who updated
 * it and when, and for operators an editor. The person's lines are the ones
 * the agent never rewrites, so they are marked. With session content off the
 * API holds nothing and the note stays on the machine.
 */
export function CardHandoffSection({
  projectId,
  number,
  canOperate,
  version,
}: {
  projectId: string;
  number: number;
  canOperate: boolean;
  /** The card's live version: a new push loads the note again. */
  version?: string | number;
}) {
  const section = useSection(
    () => fetchCardHandoff(projectId, number),
    [projectId, number, version],
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<HandoffFailure | null>(null);

  const view = section.data;
  const note = view?.note ?? null;
  const editing = draft !== null;

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setFailure(null);
    try {
      const next = await saveCardHandoff(projectId, number, draft);
      section.setData(next);
      setDraft(null);
      toast.success('The note is saved. The next round starts from it.');
    } catch (err) {
      setFailure(describeHandoffError(err));
    } finally {
      setSaving(false);
    }
  };

  const hints = draft === null ? [] : draftProblems(draft);

  return (
    <section aria-label="Handoff" className="flex flex-col gap-3">
      <SectionHeader
        title="Handoff"
        headingLevel={3}
        description="What the next round or session starts from instead of re-reading the whole history."
      />
      {view === undefined && section.error === null ? (
        <Skeleton className="h-16 w-full" />
      ) : view === undefined ? (
        <p className="text-sm text-ink-3">
          {describeHandoffError(section.error).message}{' '}
          <button
            type="button"
            className="text-accent-ink underline-offset-2 hover:underline"
            onClick={section.retry}
          >
            Try again
          </button>
        </p>
      ) : !view.shipContent ? (
        <p className="text-sm text-ink-3">
          The note is kept on the machine. This project does not send session
          content to the server, so it is not shown here.
        </p>
      ) : editing ? (
        <div className="flex flex-col gap-2">
          <Field
            label="Handoff note"
            htmlFor="card-handoff-note"
            hint="Lines you add or change are kept verbatim: the agent never rewrites them."
          >
            <Textarea
              id="card-handoff-note"
              rows={16}
              className="font-mono text-xs"
              value={draft}
              disabled={saving}
              onChange={(e) => {
                setDraft(e.target.value);
                setFailure(null);
              }}
            />
          </Field>
          {hints.length > 0 && failure === null ? (
            <ul className="list-disc pl-5 text-xs text-ink-3">
              {hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          ) : null}
          {failure ? <Problems failure={failure} /> : null}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="glass"
              disabled={saving || draft === (note?.content ?? '')}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save note'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setFailure(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : note === null ? (
        <p className="text-sm text-ink-3">
          No note yet. The agent writes it during the card’s first round.
        </p>
      ) : (
        <>
          <p className="text-xs text-ink-3">
            Updated by {UPDATED_BY_LABEL[note.updatedBy]}{' '}
            <Time value={note.updatedAt} />
          </p>
          <NoteBody note={note} />
        </>
      )}
      {view?.shipContent && !editing && canOperate && note !== null ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDraft(note.content)}
          >
            Edit
          </Button>
        </div>
      ) : null}
    </section>
  );
}
