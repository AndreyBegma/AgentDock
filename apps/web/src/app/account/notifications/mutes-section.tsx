'use client';

import type { NotificationMuteView, ProjectSummary } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import { api, describeError, describeErrorHint } from '../../../lib/api';
import { fromDateInput, isFutureDay } from '../../../lib/notifications/format';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';

interface Loaded {
  projects: ProjectSummary[];
  mutes: NotificationMuteView[];
}

export function MutesSection() {
  const section = useSection<Loaded>(async () => {
    const [list, mine] = await Promise.all([
      api<ProjectSummary[]>('/projects'),
      api<NotificationMuteView[]>('/notifications/mutes'),
    ]);
    return { projects: Array.isArray(list) ? list : [], mutes: mine };
  }, []);
  const showError = useErrorToast();
  const [projectId, setProjectId] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const projects = section.data?.projects ?? [];
  const mutes = section.data?.mutes;
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
      section.retry();
    } catch (err) {
      showError(describeErrorHint(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (mute: NotificationMuteView) => {
    try {
      await api(`/notifications/mutes/${encodeURIComponent(mute.projectId)}`, {
        method: 'DELETE',
      });
      section.retry();
    } catch (err) {
      showError(describeErrorHint(err));
    }
  };

  // Why Mute is off, as the next step; "pick a project" is plain and needs no note.
  const muteReason =
    projectId || section.data === undefined ? null : projects.length === 0 ? (
      <DisabledReason href="/projects" cta="Open Projects">
        You are not a member of any project yet.
      </DisabledReason>
    ) : candidates.length === 0 ? (
      <DisabledReason>Every project is already muted.</DisabledReason>
    ) : (
      <DisabledReason>Choose a project to mute it.</DisabledReason>
    );

  return (
    <Card pad="lg">
      <h2 className="mb-1 text-lg font-bold">Muted projects</h2>
      <p className="text-ink-2 mb-4 text-sm">
        A muted project is still recorded here, but it does not count as unread
        and is never sent to Telegram.
      </p>
      <form onSubmit={add} className="mb-4 flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-3">
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
        </div>
        {muteReason}
      </form>
      {section.data === undefined ? (
        section.error !== null && !section.loading ? (
          <SectionUnavailable
            title="Your muted projects could not be loaded"
            stillWorks={`${describeError(section.error)} Nothing was unmuted.`}
            action={
              <Button variant="glass" size="sm" onClick={section.retry}>
                Try again
              </Button>
            }
          />
        ) : (
          <Skeleton className="h-16 w-full" />
        )
      ) : mutes === undefined || mutes.length === 0 ? (
        <p className="text-ink-2 text-sm">
          No project is muted. Mute a noisy one above;{' '}
          <Link href="/projects" className="underline underline-offset-2">
            all projects
          </Link>{' '}
          are listed on Projects.
        </p>
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
      {section.data !== undefined && section.error !== null ? (
        <div className="mt-3">
          <SectionUnavailable
            title="The list could not be refreshed"
            stillWorks={describeError(section.error)}
            action={
              <Button variant="glass" size="sm" onClick={section.retry}>
                Try again
              </Button>
            }
          />
        </div>
      ) : null}
    </Card>
  );
}
