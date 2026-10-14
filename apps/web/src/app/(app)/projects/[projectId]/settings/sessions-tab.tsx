'use client';

import {
  type ProjectDetail,
  SESSION_CONTENT_RETENTION_DAYS,
  type UpdateProjectRequest,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  CONTENT_WARNING,
  describeSessionContentError,
  parseRetention,
  retentionError,
} from '../../../../../lib/projects/session-content';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';

/**
 * Project settings → Sessions (ADR-0021, spec 201 "UI"): whether the runner
 * ships what a Claude Code session says and does, how long it is kept, and a
 * purge. Every member reads; only an admin changes it.
 */
export function SessionsTab({
  project,
  isAdmin,
  onChanged,
}: {
  project: ProjectDetail;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const saved = project.shipSessionContent ?? false;
  const savedDays =
    project.sessionContentRetentionDays ??
    SESSION_CONTENT_RETENTION_DAYS.default;
  const [ship, setShip] = useState(saved);
  const [days, setDays] = useState(String(savedDays));
  const [busy, setBusy] = useState(false);
  const [purging, setPurging] = useState(false);
  const showError = useErrorToast();

  // Reset the form when the project reloads (a save, a live frame).
  useEffect(() => {
    setShip(saved);
    setDays(String(savedDays));
  }, [saved, savedDays]);

  const parsed = parseRetention(days);
  const dirty = ship !== saved || parsed !== savedDays;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (parsed === null) return;
    setBusy(true);
    const body: UpdateProjectRequest = {
      shipSessionContent: ship,
      sessionContentRetentionDays: parsed,
    };
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body });
      toast.success('Session content settings saved');
      onChanged();
    } catch (err) {
      showError(describeSessionContentError(err));
    } finally {
      setBusy(false);
    }
  };

  const purge = async () => {
    setBusy(true);
    try {
      await api(`/projects/${project.id}/session-content`, {
        method: 'DELETE',
      });
      toast.success('Session content purged');
      setPurging(false);
    } catch (err) {
      showError(describeSessionContentError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card pad="lg" className="flex flex-col gap-6">
        <SectionHeader
          title="Session content"
          description="Claude Code sessions started by hand report to AgentDock through the agentdock plugin. By default only their metadata is kept."
        />
        <form className="flex flex-col gap-4" onSubmit={save}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <span id="project-content-label" className="text-sm font-medium">
                Keep session content
              </span>
              <p className="text-ink-3 text-xs">
                Prompts, tool inputs and outputs, and responses.
              </p>
            </div>
            {isAdmin ? (
              <Toggle
                checked={ship}
                onChange={setShip}
                labelledBy="project-content-label"
              />
            ) : (
              <span className="text-sm">{ship ? 'on' : 'off'}</span>
            )}
          </div>
          <Banner tone="warn" title="Redaction is pattern-based">
            {CONTENT_WARNING}
          </Banner>
          <Field
            label="Retention (days)"
            htmlFor="project-content-retention"
            hint="Content older than this is deleted every night. Turning content off keeps what is stored until then."
            error={isAdmin ? retentionError(days) : undefined}
          >
            <Input
              id="project-content-retention"
              inputMode="numeric"
              value={days}
              disabled={!isAdmin}
              onChange={(e) => setDays(e.target.value)}
            />
          </Field>
          {isAdmin ? (
            <div className="flex justify-end gap-2">
              <Button
                variant="solid"
                type="submit"
                disabled={busy || parsed === null || !dirty}
              >
                Save
              </Button>
            </div>
          ) : (
            <p className="text-ink-3 text-sm">
              Only administrators can change these settings.
            </p>
          )}
        </form>
      </Card>

      {isAdmin ? (
        <Card pad="lg" className="flex flex-col gap-3">
          <SectionHeader
            title="Purge content"
            description="Deletes every stored prompt, tool input and output, and response of this project now, whatever the retention. Session metadata, tokens and cost stay."
            actions={
              <Button
                variant="glass"
                disabled={busy}
                onClick={() => setPurging(true)}
              >
                Purge content
              </Button>
            }
          />
        </Card>
      ) : null}

      <ConfirmDialog
        open={purging}
        onOpenChange={setPurging}
        title="Purge all session content of this project?"
        consequence="Every stored prompt, tool call and response is deleted and cannot be restored. The purge is written to the audit log."
        verb="Purge content"
        tone="danger"
        busy={busy}
        onConfirm={() => void purge()}
      />
    </div>
  );
}
