'use client';

import type { NotificationMuteView, ProjectSummary } from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { DateInput } from 'glass-ui/date-input';
import { Field, Select } from 'glass-ui/field';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../../../lib/api';
import { fromDateInput, isFutureDay } from '../../../lib/notifications/format';

export function MutesSection() {
  const [mutes, setMutes] = useState<NotificationMuteView[]>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, mine] = await Promise.all([
        api<ProjectSummary[]>('/projects'),
        api<NotificationMuteView[]>('/notifications/mutes'),
      ]);
      setProjects(Array.isArray(list) ? list : []);
      setMutes(mine);
    } catch (err) {
      toast.error(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const muted = new Set((mutes ?? []).map((mute) => mute.projectId));
  const candidates = projects.filter((project) => !muted.has(project.id));

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    if (until && !isFutureDay(until)) {
      setError('Pick today or a later day.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await api(`/notifications/mutes/${encodeURIComponent(projectId)}`, {
        method: 'PUT',
        body: { until: fromDateInput(until) },
      });
      setProjectId('');
      setUntil('');
      await load();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (mute: NotificationMuteView) => {
    try {
      await api(`/notifications/mutes/${encodeURIComponent(mute.projectId)}`, {
        method: 'DELETE',
      });
      await load();
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Card pad="lg">
      <h2 className="mb-1 text-lg font-bold">Muted projects</h2>
      <p className="text-ink-2 mb-4 text-sm">
        A muted project is still recorded here, but it does not count as unread
        and is never sent to Telegram.
      </p>
      <form onSubmit={add} className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Project" htmlFor="mute-project">
          <Select
            id="mute-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Choose a project…</option>
            {candidates.map((project) => (
              <option key={project.id} value={project.id}>
                {project.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Until (optional)"
          htmlFor="mute-until"
          hint="Empty: until you unmute."
          error={error}
        >
          <DateInput
            id="mute-until"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="solid" disabled={busy || !projectId}>
          Mute
        </Button>
      </form>
      {mutes === undefined ? (
        <p className="text-ink-2 text-sm">Loading…</p>
      ) : mutes.length === 0 ? (
        <p className="text-ink-2 text-sm">No project is muted.</p>
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>Project</TableCell>
              <TableCell head>Until</TableCell>
              <TableCell head>
                <span className="sr-only">Actions</span>
              </TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {mutes.map((mute) => (
              <TableRow key={mute.projectId}>
                <TableCell>{mute.projectName}</TableCell>
                <TableCell>
                  {mute.until
                    ? new Date(mute.until).toLocaleDateString()
                    : 'Until removed'}
                </TableCell>
                <TableCell>
                  <Button size="sm" onClick={() => void remove(mute)}>
                    Unmute
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
