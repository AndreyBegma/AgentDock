'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Timeline, type TimelineItem } from '@andrewbehma/glass-ui/timeline';
import { toast } from '@andrewbehma/glass-ui/toast';
import {
  type BoardCardDetail,
  STEWARD_KIND_LABEL,
  type StewardIncidentView,
  suggestIssueLink,
} from '@nautelle/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Time } from '../../lib/format/time';
import { useSection } from '../../lib/section/use-section';
import { fetchCardIncidents, linkCardIssue } from '../../lib/steward/actions';
import {
  actionLine,
  describeIssueLinkError,
  describeStewardError,
  INCIDENT_STATUS_LABEL,
  INCIDENT_STATUS_TONE,
  parseIssueInput,
} from '../../lib/steward/format';
import { githubUrl } from '../../lib/url';

const capitalize = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

function incidentItems(incidents: StewardIncidentView[]): TimelineItem[] {
  return incidents.map((incident) => ({
    id: incident.id,
    at: incident.openedAt,
    tone: INCIDENT_STATUS_TONE[incident.status],
    title: `${capitalize(STEWARD_KIND_LABEL[incident.kind])} — ${incident.reason}`,
    meta: (
      <span className="flex flex-col gap-0.5">
        <span>
          {INCIDENT_STATUS_LABEL[incident.status]}
          {incident.resolvedAt ? (
            <>
              {' '}
              <Time value={incident.resolvedAt} />
            </>
          ) : null}
        </span>
        {incident.actions.length > 0 ? (
          incident.actions.map((record) => (
            <span key={`${record.action}-${record.at}`}>
              {actionLine(record, incident.actions)}
            </span>
          ))
        ) : (
          <span>No action taken.</span>
        )}
      </span>
    ),
  }));
}

/**
 * The card's Issue (D8): the number it closes. Typing a number links an open
 * issue of the project; empty unlinks. The API refuses a closed or missing
 * one with a plain 422 and the text is shown as it came. A number named in the
 * card text (`Closes #n`) is offered as a suggestion.
 */
function IssueLink({
  projectId,
  card,
  canOperate,
  onChanged,
}: {
  projectId: string;
  card: BoardCardDetail;
  canOperate: boolean;
  onChanged: () => void;
}) {
  const current = card.issueNumber === null ? '' : String(card.issueNumber);
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(current), [current]);

  const suggestion = suggestIssueLink(`${card.title}\n${card.body}`);
  const suggest =
    canOperate && suggestion !== null && suggestion !== card.issueNumber
      ? suggestion
      : null;
  const issueHref = card.issueUrl ? githubUrl(card.issueUrl) : null;

  const submit = async (text: string) => {
    const parsed = parseIssueInput(text);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await linkCardIssue(projectId, card.number, parsed.number);
      toast.success(
        parsed.number === null
          ? `${card.label} is no longer linked to an issue.`
          : `${card.label} is linked to issue #${parsed.number}. Run will not create another.`,
      );
      onChanged();
    } catch (err) {
      setError(describeIssueLinkError(err));
    } finally {
      setBusy(false);
    }
  };

  const dirty = value.trim().replace(/^#/, '') !== current;

  return (
    <form
      aria-label="Issue"
      className="flex flex-col gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit(value);
      }}
    >
      <Field
        label="Issue"
        htmlFor="board-card-issue"
        hint="An open issue of this project. Run then creates no new issue and the pull request says Closes #n. Empty unlinks."
        {...(error ? { error } : {})}
      >
        <div className="flex items-center gap-2">
          <Input
            id="board-card-issue"
            inputMode="numeric"
            placeholder="e.g. 447"
            value={value}
            disabled={!canOperate || busy}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          {canOperate ? (
            <Button
              type="submit"
              variant="glass"
              disabled={busy || !dirty}
              className="shrink-0"
            >
              {busy
                ? 'Saving…'
                : value.trim() === '' && current !== ''
                  ? 'Unlink'
                  : 'Link'}
            </Button>
          ) : null}
        </div>
      </Field>
      {issueHref && card.issueNumber !== null ? (
        <a
          href={issueHref}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-accent-ink underline-offset-2 hover:underline"
        >
          Open issue #{card.issueNumber}
        </a>
      ) : null}
      {suggest !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          The text says it closes #{suggest}.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setValue(String(suggest));
              void submit(String(suggest));
            }}
          >
            Link #{suggest}
          </Button>
        </p>
      ) : null}
    </form>
  );
}

/**
 * #447 D15: the card sheet's Steward section — the card's incidents, newest
 * first, with what Steward did about each, and the Issue link (D8). `version`
 * is the card's live version: a new push loads the incidents again.
 */
export function CardStewardSection({
  projectId,
  card,
  canOperate,
  onChanged,
}: {
  projectId: string;
  card: BoardCardDetail;
  canOperate: boolean;
  onChanged: () => void;
}) {
  const incidents = useSection(
    () => fetchCardIncidents(projectId, card.number),
    [
      projectId,
      card.number,
      card.round?.round,
      card.round?.phase,
      card.steward?.incidentId,
    ],
  );
  const failed = incidents.error !== null && incidents.data === undefined;

  return (
    <section aria-label="Steward" className="flex flex-col gap-3">
      <SectionHeader title="Steward" headingLevel={3} />
      <IssueLink
        projectId={projectId}
        card={card}
        canOperate={canOperate}
        onChanged={onChanged}
      />
      {incidents.data === undefined && !failed ? (
        <Skeleton className="h-12 w-full" />
      ) : failed ? (
        <p className="text-sm text-ink-3">
          {describeStewardError(incidents.error)}{' '}
          <button
            type="button"
            className="text-accent-ink underline-offset-2 hover:underline"
            onClick={incidents.retry}
          >
            Try again
          </button>
        </p>
      ) : (
        <Timeline
          items={incidentItems(incidents.data ?? [])}
          empty={
            <p className="text-sm text-ink-3">
              Steward has not had to step in on this card.
            </p>
          }
        />
      )}
    </section>
  );
}
