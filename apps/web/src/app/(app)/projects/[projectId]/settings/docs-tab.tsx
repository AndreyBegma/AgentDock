'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { toast } from '@andrewbehma/glass-ui/toast';
import type { ProjectDetail } from '@nautelle/shared';
import type { DocsSourceKind } from '@nautelle/shared/protocol';
import { useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  DOCS_KIND_LABEL,
  describeProjectError,
  docsOverrideRequest,
  specFolderError,
  specFolderOf,
} from '../../../../../lib/projects/format';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
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
  const [specDir, setSpecDir] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const docs = project.docsSource;
    setKind(docs?.kind ?? 'in_repo');
    setLocalPath(docs?.localPath ?? '');
    setRepo(docs?.repo ?? '');
    setSpecDir(specFolderOf(docs));
    setError(undefined);
  }, [open, project.docsSource]);

  const submit = async () => {
    const request = docsOverrideRequest(
      { kind, localPath, repo, specDir },
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
  // #379: a remote docs repository takes the path of a local clone.
  const takesPath = needsPath || kind === 'remote_repo';

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
          {takesPath ? (
            <Field
              label={kind === 'remote_repo' ? 'Local clone' : 'Path'}
              htmlFor="docs-path"
              required={needsPath}
              hint={
                kind === 'in_repo'
                  ? `Absolute, inside ${project.rootPath}.`
                  : kind === 'remote_repo'
                    ? 'Absolute path of a clone on the runner. Specs are written there; without it a spec cannot be written.'
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
          {kind !== 'none' ? (
            <Field
              label="Spec folder"
              htmlFor="docs-spec-dir"
              hint="Relative to the docs root. Card and plan specs are written here."
            >
              <Input
                id="docs-spec-dir"
                value={specDir}
                placeholder="specs"
                onChange={(e) => setSpecDir(e.target.value)}
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

/**
 * #379: the Spec folder on its own — where card and plan specs are written,
 * relative to the docs root. Saving it keeps the source as it is: a detected
 * source stays detected.
 */
function SpecFolderForm({
  project,
  onSaved,
}: {
  project: ProjectDetail;
  onSaved: () => void;
}) {
  const docs = project.docsSource;
  const [specDir, setSpecDir] = useState(specFolderOf(docs));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSpecDir(specFolderOf(docs));
    setError(undefined);
  }, [docs]);

  if (!docs || docs.kind === 'none') return null;
  const suggested = docs.specDir === null && specDir !== '';

  const save = async () => {
    const request = docsOverrideRequest(
      {
        kind: docs.kind,
        localPath: docs.localPath ?? '',
        repo: docs.repo ?? '',
        specDir,
      },
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
      toast.success('Spec folder saved.');
      onSaved();
    } catch (err) {
      setError(describeProjectError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field
        label="Spec folder"
        htmlFor="docs-spec-folder"
        hint={
          docs.kind === 'in_repo'
            ? 'Relative to the docs root. Card and plan specs are committed here, in this repository.'
            : `Relative to the docs root. Card and plan specs go into ${docs.repo ?? 'the docs repository'} through a pull request there.${
                docs.localPath ? '' : ' Set a local clone with Override first.'
              }`
        }
      >
        <div className="flex flex-wrap gap-2">
          <Input
            id="docs-spec-folder"
            className="min-w-0 flex-1"
            value={specDir}
            placeholder="specs"
            onChange={(e) => {
              setSpecDir(e.target.value);
              setError(specFolderError(e.target.value) ?? undefined);
            }}
          />
          <Button
            type="submit"
            variant="glass"
            size="sm"
            disabled={busy || (!suggested && specDir === (docs.specDir ?? ''))}
          >
            Save
          </Button>
        </div>
      </Field>
      {suggested ? (
        <p className="text-sm text-ink-3">
          Detected from the docs source; save it to use it.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </form>
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
  const showError = useErrorToast();
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
      showError(describeProjectError(err));
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
        <>
          <DocsDetails docs={docs} />
          {isAdmin ? (
            <SpecFolderForm project={project} onSaved={onChanged} />
          ) : docs.specDir ? (
            <p className="text-sm">
              <span className="text-ink-3">Spec folder: </span>
              <code>{docs.specDir}</code>
            </p>
          ) : null}
        </>
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
