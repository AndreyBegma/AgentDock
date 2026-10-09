'use client';

import type {
  AdminRunnerDetail,
  ProjectSummary,
  SkillCatalogView,
  SkillInspectView,
  SkillPreviewView,
} from '@agentdock/shared';
import type { SkillCatalogItem } from '@agentdock/shared/protocol';
import { Banner } from 'glass-ui/banner';
import { Card } from 'glass-ui/card';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, SearchField, Select } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { Spinner } from 'glass-ui/spinner';
import { toast } from 'glass-ui/toast';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  COMMAND_UNAVAILABLE_TEXT,
  describeSkillsError,
  isCommandUnavailable,
} from '../../../lib/skills/format';
import { InspectSheet } from './inspect-sheet';

const SEARCH_DEBOUNCE_MS = 400;

export default function SkillsCatalogPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SkillCatalogItem[]>();
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [inspecting, setInspecting] = useState<string>();
  const [preview, setPreview] = useState<SkillPreviewView | null>(null);
  const [adminProfiles, setAdminProfiles] = useState<string[]>([]);

  // The catalog goes through a runner: the runner of a project the person can operate.
  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((all) => {
        const operable = all.filter((p) => p.role !== 'viewer');
        setProjects(operable);
        setProjectId((current) => current || operable[0]?.id || '');
      })
      .catch((err) => {
        toast.error(describeSkillsError(err));
        setProjects([]);
      });
  }, []);

  const project = projects?.find((p) => p.id === projectId);
  const runnerId = project?.runnerId;
  const isAdmin = project?.role === 'admin';

  useEffect(() => {
    setItems(undefined);
    setPreview(null);
    setAdminProfiles([]);
    if (!isAdmin || !runnerId) return;
    api<AdminRunnerDetail>(`/admin/runners/${runnerId}`)
      .then((runner) =>
        setAdminProfiles(
          runner.profiles
            .filter((p) => !p.missing && p.runtime === 'claude')
            .map((p) => p.key),
        ),
      )
      .catch(() => setAdminProfiles([]));
  }, [isAdmin, runnerId]);

  // Debounced search; a newer query or a project change drops the answer of the old one.
  useEffect(() => {
    const q = query.trim();
    if (!runnerId || q === '') {
      setItems(undefined);
      setSearchError(undefined);
      setUnavailable(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(undefined);
      setUnavailable(false);
      api<SkillCatalogView>(
        `/skills/catalog?q=${encodeURIComponent(q)}&runnerId=${encodeURIComponent(runnerId)}`,
      )
        .then((view) => {
          if (!cancelled) setItems(view.items);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setItems(undefined);
          if (isCommandUnavailable(err)) setUnavailable(true);
          else setSearchError(describeSkillsError(err));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, runnerId]);

  const open = async (item: SkillCatalogItem) => {
    if (!runnerId || !project) return;
    setInspecting(item.id);
    try {
      const view = await api<SkillInspectView>('/skills/inspect', {
        method: 'POST',
        body: {
          runnerId,
          source: item.source,
          skillId: item.skillId,
          projectId: project.id,
        },
      });
      const match =
        view.previews.find((p) => p.skillId === item.skillId) ??
        view.previews[0];
      if (match) setPreview(match);
      else toast.error('The repository holds no skill with that name.');
    } catch (err) {
      if (isCommandUnavailable(err)) setUnavailable(true);
      else toast.error(describeSkillsError(err));
    } finally {
      setInspecting(undefined);
    }
  };

  if (!projects) return <Skeleton className="h-64 w-full" />;
  if (projects.length === 0 || !project) {
    return (
      <EmptyState
        title="No project to install into"
        description="Installing and running skills needs the operator role on a project. Ask an administrator for access."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Skills</h1>
        <p className="text-sm text-ink-2">
          Search the public skills.sh catalog. The runner looks it up and clones
          the repository; nothing is installed until you confirm.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Project" htmlFor="skills-project">
          <Select
            id="skills-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} · {p.runnerName}
              </option>
            ))}
          </Select>
        </Field>
        <div className="min-w-64 flex-1">
          <Field label="Search" htmlFor="skills-search">
            <SearchField
              id="skills-search"
              value={query}
              placeholder="estimate, review, testing…"
              maxLength={100}
              onChange={(e) => setQuery(e.target.value)}
              trailing={searching ? <Spinner size="sm" /> : undefined}
            />
          </Field>
        </div>
      </div>

      {unavailable ? (
        <Banner tone="warn" title="The runner cannot reach the catalog yet">
          {COMMAND_UNAVAILABLE_TEXT}
        </Banner>
      ) : null}
      {searchError ? (
        <p role="alert" className="text-sm text-danger">
          {searchError}
        </p>
      ) : null}

      {items === undefined ? (
        query.trim() === '' ? (
          <EmptyState
            title="Search for a skill"
            description="Type a word above. Results come from skills.sh through the runner of the selected project."
          />
        ) : null
      ) : items.length === 0 ? (
        <EmptyState
          title="No skills found"
          description={`Nothing in the catalog matches “${query.trim()}”.`}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="block w-full text-left disabled:opacity-60"
                disabled={inspecting !== undefined}
                onClick={() => open(item)}
              >
                <Card className="flex flex-col gap-1">
                  <span className="font-semibold">{item.name}</span>
                  <span className="font-mono text-xs text-ink-2">
                    {item.source}
                  </span>
                  <span className="text-xs text-ink-3">
                    {inspecting === item.id
                      ? 'Opening…'
                      : `${item.installs.toLocaleString('en')} installs`}
                  </span>
                </Card>
              </button>
            </li>
          ))}
        </ul>
      )}

      <InspectSheet
        preview={preview}
        project={project}
        profileKeys={adminProfiles}
        isAdmin={isAdmin}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
