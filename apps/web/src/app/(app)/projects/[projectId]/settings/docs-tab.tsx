'use client';

import type { ProjectDetail } from '@agentdock/shared';
import type { DocsSourceKind } from '@agentdock/shared/protocol';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input, Select } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import { useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  DOCS_KIND_LABEL,
  describeProjectError,
  docsOverrideRequest,
} from '../../../../../lib/projects/format';
import { DocsDetails } from '../../docs-details';

const KINDS = Object.keys(DOCS_KIND_LABEL) as DocsSourceKind[];

function OverrideDialog({
  project,
  open,
  onClose,
  onSaved,
}: {
  project: ProjectDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<DocsSourceKind>('in_repo');
  const [localPath, setLocalPath] = useState('');
  const [repo, setRepo] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const docs = project.docsSource;
    setKind(docs?.kind ?? 'in_repo');
    setLocalPath(docs?.localPath ?? '');
    setRepo(docs?.repo ?? '');
    setError(undefined);
  }, [open, project.docsSource]);

  const submit = async () => {
    const request = docsOverrideRequest(
      { kind, localPath, repo },
      project.rootPath,
    );
    if (!request.ok) {
      setError(request.error);
      return;
    }
    setBusy(true);
    try {
      await api(`/projects/${project.id}/docs-source`, {
        method: 'PUT',
        body: request.body,
      });
      toast.success('Docs source overridden.');
      onSaved();
    } catch (err) {
      setError(describeProjectError(err));
    } finally {
      setBusy(false);
    }
  };

  const needsPath = kind === 'in_repo' || kind === 'sibling_repo';
  const needsRepo = kind === 'remote_repo' || kind === 'sibling_repo';

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title="Override docs source"
        description="The runner cannot check what you enter. A refresh keeps it until you reset it."
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="solid" onClick={submit} disabled={busy}>
              Save override
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Kind" htmlFor="docs-kind">
            <Select
              id="docs-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as DocsSourceKind);
                setError(undefined);
              }}
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {DOCS_KIND_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>
          {needsPath ? (
            <Field
              label="Path"
              htmlFor="docs-path"
              required
              hint={
                kind === 'in_repo'
                  ? `Absolute, inside ${project.rootPath}.`
                  : 'Absolute path on the runner.'
              }
            >
              <Input
                id="docs-path"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
              />
            </Field>
          ) : null}
          {needsRepo ? (
            <Field
              label="Repository"
              htmlFor="docs-repo"
              required={kind === 'remote_repo'}
              hint="owner/name"
            >
              <Input
                id="docs-repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </Field>
          ) : null}
          {error ? (
            <p role="alert" className="text-danger text-sm">
              {error}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

export function DocsTab({
  project,
  isAdmin,
  canRefresh,
  onChanged,
}: {
  project: ProjectDetail;
  isAdmin: boolean;
  canRefresh: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'refresh' | 'reset'>();
  const [overriding, setOverriding] = useState(false);
  const docs = project.docsSource;

  const run = async (
    kind: 'refresh' | 'reset',
    task: () => Promise<unknown>,
    done: string,
  ) => {
    setBusy(kind);
    try {
      await task();
      toast.success(done);
      onChanged();
    } catch (err) {
      toast.error(describeProjectError(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card pad="lg" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Docs source</h2>
        <div className="flex flex-wrap gap-2">
          {canRefresh ? (
            <Button
              variant="glass"
              size="sm"
              disabled={busy !== undefined}
              onClick={() =>
                run(
                  'refresh',
                  () =>
                    api(`/projects/${project.id}/refresh`, { method: 'POST' }),
                  'Project refreshed.',
                )
              }
            >
              Refresh
            </Button>
          ) : null}
          {isAdmin ? (
            <>
              <Button
                variant="glass"
                size="sm"
                disabled={busy !== undefined}
                onClick={() => setOverriding(true)}
              >
                Override
              </Button>
              {docs?.manual ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() =>
                    run(
                      'reset',
                      () =>
                        api(`/projects/${project.id}/docs-source`, {
                          method: 'DELETE',
                        }),
                      'Detection restored.',
                    )
                  }
                >
                  Reset to detected
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {docs ? (
        <DocsDetails docs={docs} />
      ) : (
        <EmptyState
          title="No docs source"
          description="Refresh the project to run detection."
        />
      )}

      {isAdmin ? (
        <OverrideDialog
          project={project}
          open={overriding}
          onClose={() => setOverriding(false)}
          onSaved={() => {
            setOverriding(false);
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}
