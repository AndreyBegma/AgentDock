'use client';

import {
  CAPTURE_MODELS,
  type CaptureModel,
  type CardCaptureView,
  isCaptureModel,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { fetchCaptures } from '../../../../../lib/board/actions';
import {
  CAPTURE_MODEL_LABEL,
  CAPTURE_STATUS_PILL,
  CAPTURE_WARNING,
  captureOutcome,
  describeBoardError,
  sessionHref,
} from '../../../../../lib/board/format';
import { formatCost } from '../../../../../lib/format';
import { Time } from '../../../../../lib/format/time';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';

/**
 * #244 "Settings → Board → Capture": the switch, the model, and what the
 * recent extractions did. The switch is on only while the project keeps
 * session content (D10), so with content off it is replaced by a link.
 */
export function CaptureFields({
  projectId,
  isAdmin,
  contentOn,
  enabled,
  model,
  onEnabled,
  onModel,
}: {
  projectId: string;
  isAdmin: boolean;
  /** `shipSessionContent` of the project. */
  contentOn: boolean;
  enabled: boolean;
  model: CaptureModel;
  onEnabled: (value: boolean) => void;
  onModel: (value: CaptureModel) => void;
}) {
  const canToggle = isAdmin && contentOn;
  return (
    <section aria-label="Capture" className="flex flex-col gap-4">
      <SectionHeader
        title="Capture"
        description="Propose cards from your own Claude Code sessions. They land in the Board’s Inbox."
      />
      <div className="flex items-center justify-between gap-4">
        <div>
          <span id="board-capture-label" className="text-sm font-medium">
            Suggest cards from sessions
          </span>
          {contentOn ? null : (
            <p className="text-ink-3 text-xs">
              Needs “Keep session content”.{' '}
              <Link
                href={`/projects/${projectId}/settings?tab=sessions`}
                className="text-accent-ink underline-offset-2 hover:underline"
              >
                Open Sessions settings
              </Link>
            </p>
          )}
        </div>
        {canToggle ? (
          <Toggle
            checked={enabled}
            onChange={onEnabled}
            labelledBy="board-capture-label"
          />
        ) : (
          <span className="text-sm">{enabled && contentOn ? 'on' : 'off'}</span>
        )}
      </div>
      <Field
        label="Model"
        htmlFor="board-capture-model"
        hint="The model on the runner that reads the sessions."
      >
        <Select
          id="board-capture-model"
          value={model}
          disabled={!isAdmin}
          onChange={(e) =>
            onModel(isCaptureModel(e.target.value) ? e.target.value : model)
          }
        >
          {CAPTURE_MODELS.map((m) => (
            <option key={m} value={m}>
              {CAPTURE_MODEL_LABEL[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Banner tone="warn" title="Session content goes to a model">
        {CAPTURE_WARNING}
      </Banner>
    </section>
  );
}

/** The recent extractions, newest first (`GET /board/captures`, operators). */
export function CapturesTable({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<CardCaptureView[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const showError = useErrorToast();

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      try {
        const page = await fetchCaptures(projectId, after);
        setRows((current) =>
          after ? [...(current ?? []), ...page.items] : page.items,
        );
        setCursor(page.nextCursor);
      } catch (err) {
        showError(describeBoardError(err));
      } finally {
        setLoading(false);
      }
    },
    [projectId, showError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card pad="lg" className="flex flex-col gap-3">
      <SectionHeader
        title="Recent extractions"
        description="Every run of the capture model, including the ones that were skipped."
      />
      <DataTable<CardCaptureView>
        rows={rows ?? []}
        getRowId={(row) => row.id}
        loading={rows === undefined}
        emptyState={
          <p className="p-4 text-sm text-ink-3">
            Nothing has been extracted yet.
          </p>
        }
        columns={[
          {
            id: 'when',
            header: 'When',
            cell: (row) => <Time value={row.createdAt} />,
          },
          {
            id: 'status',
            header: 'Status',
            cell: (row) => (
              <StatusPill
                size="sm"
                status={CAPTURE_STATUS_PILL[row.status].status}
                label={CAPTURE_STATUS_PILL[row.status].label}
              />
            ),
          },
          {
            id: 'outcome',
            header: 'Outcome',
            cell: (row) => (
              <span className="break-words">{captureOutcome(row)}</span>
            ),
          },
          {
            id: 'session',
            header: 'Session',
            cell: (row) => (
              <Link
                href={sessionHref(row.sessionId) ?? '#'}
                className="text-accent-ink underline-offset-2 hover:underline"
              >
                Open
              </Link>
            ),
          },
          {
            id: 'cost',
            header: 'Cost',
            align: 'end',
            cell: (row) => (
              <span className="tabular-nums">
                {formatCost(row.costUsd) ?? '—'}
              </span>
            ),
          },
        ]}
      />
      {cursor ? (
        <div>
          <Button
            variant="glass"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            {loading ? 'Loading…' : 'Show older'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
