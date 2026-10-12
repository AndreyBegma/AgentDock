'use client';

import {
  COMMAND_RUN_LIVE_EVENT,
  type CommandRunView,
  type ProjectSummary,
  type SkillPreviewView,
  type SkillProfileInstallView,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Chip } from 'glass-ui/chip';
import { Field, Select } from 'glass-ui/field';
import { KeyValueList } from 'glass-ui/key-value-list';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { parseRunEvent } from '../../../lib/control/pending';
import { useLive } from '../../../lib/live/use-live';
import {
  allowedToolsOf,
  describeSkillsError,
  formatBytes,
  type InstallOutcome,
  installOutcome,
  shortHash,
  totalBytes,
} from '../../../lib/skills/format';

type Runtime = 'claude' | 'codex';

/** `project` installs open a PR; `profile:<key>` writes straight to that profile (admin). */
type Target = 'project' | `profile:${string}`;

/**
 * What a catalog skill holds, before anything is written (spec 24 D2): the
 * description, the tools it asks for, every file with its size and the
 * content hash. Installing consumes the preview; the runner checks the hash
 * again and refuses with `changed_since_preview` if the content moved.
 */
export function InspectSheet({
  preview,
  project,
  profileKeys,
  isAdmin,
  onClose,
}: {
  preview: SkillPreviewView | null;
  project: ProjectSummary;
  /** Claude profile keys of the runner; only an admin may install into one. */
  profileKeys: string[];
  isAdmin: boolean;
  onClose: () => void;
}) {
  return (
    <SheetRoot
      open={preview !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      {preview ? (
        <SheetContent
          side="right"
          title={preview.skillId}
          description={`${preview.source} @ ${preview.commit.slice(0, 7)}`}
        >
          {/* A new preview is a new form: the outcome of the last one must not carry over. */}
          <Detail
            key={preview.previewId}
            preview={preview}
            project={project}
            profileKeys={profileKeys}
            isAdmin={isAdmin}
          />
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}

function Detail({
  preview,
  project,
  profileKeys,
  isAdmin,
}: {
  preview: SkillPreviewView;
  project: ProjectSummary;
  profileKeys: string[];
  isAdmin: boolean;
}) {
  const [target, setTarget] = useState<Target>('project');
  const [runtime, setRuntime] = useState<Runtime>('claude');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<InstallOutcome>();
  const [commandRunId, setCommandRunId] = useState<string>();

  const tools = allowedToolsOf(preview.frontmatter);
  const expired = Date.parse(preview.expiresAt) <= Date.now();

  // A project install is finished in the background; the answer arrives on the project topic.
  useLive(`project:${project.id}`, (message) => {
    if (message.event !== COMMAND_RUN_LIVE_EVENT || !commandRunId) return;
    const run = parseRunEvent(message.data);
    if (run?.id === commandRunId) setOutcome(installOutcome(run));
  });

  const install = async () => {
    setBusy(true);
    setError(undefined);
    setOutcome(undefined);
    try {
      if (target === 'project') {
        const run = await api<CommandRunView>(
          `/projects/${project.id}/skills/install`,
          { method: 'POST', body: { previewId: preview.previewId, runtime } },
        );
        setCommandRunId(run.id);
        setOutcome(installOutcome(run));
      } else {
        const key = target.slice('profile:'.length);
        const result = await api<SkillProfileInstallView>(
          `/runners/${project.runnerId}/profiles/${encodeURIComponent(key)}/skills/install`,
          { method: 'POST', body: { previewId: preview.previewId, runtime } },
        );
        setOutcome({
          state: 'done',
          text: `Installed to ${result.path}.`,
          prUrl: null,
        });
      }
    } catch (err) {
      setError(describeSkillsError(err));
    } finally {
      setBusy(false);
    }
  };

  const finished = outcome?.state === 'done' || outcome?.state === 'pending';

  return (
    <div className="flex flex-col gap-6">
      <Banner tone="warn" title="Review before you install">
        A skill is instructions an agent follows with its tools. Read what it
        asks for below
        {target === 'project'
          ? '; a project install is a pull request, so a person reviews it again before it is merged.'
          : '; a profile install is not reviewed by anyone and applies to every project on this machine.'}
      </Banner>

      <KeyValueList
        items={[
          {
            key: 'desc',
            label: 'Description',
            value: preview.frontmatter.description ?? '—',
          },
          {
            key: 'hint',
            label: 'Arguments',
            value: preview.frontmatter['argument-hint'] ?? '—',
          },
          {
            key: 'tools',
            label: 'Allowed tools',
            value:
              tools.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {tools.map((tool) => (
                    <Chip key={tool} size="sm">
                      {tool}
                    </Chip>
                  ))}
                </span>
              ) : (
                'not restricted'
              ),
          },
          {
            key: 'flags',
            label: 'Invocation',
            value: [
              preview.frontmatter['user-invocable'] === false
                ? 'model only'
                : 'user-invocable',
              preview.frontmatter['disable-model-invocation']
                ? 'model invocation disabled'
                : null,
            ]
              .filter(Boolean)
              .join(', '),
          },
          {
            key: 'hash',
            label: 'Content hash',
            value: (
              <span className="font-mono text-xs" title={preview.contentHash}>
                {shortHash(preview.contentHash)}…
              </span>
            ),
          },
        ]}
      />

      <section>
        <h3 className="mb-2 text-sm font-semibold">
          Files{' '}
          <span className="font-normal text-ink-3">
            ({preview.files.length} · {formatBytes(totalBytes(preview.files))})
          </span>
        </h3>
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>Path</TableCell>
              <TableCell head>Size</TableCell>
              <TableCell head>SHA-256</TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {preview.files.map((file) => (
              <TableRow key={file.path}>
                <TableCell>
                  <span className="font-mono text-xs">{file.path}</span>
                </TableCell>
                <TableCell>{formatBytes(file.size)}</TableCell>
                <TableCell>
                  <span className="font-mono text-xs" title={file.sha256}>
                    {shortHash(file.sha256)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Install to…</h3>
        <Field label="Target" htmlFor="skill-install-target">
          <Select
            id="skill-install-target"
            value={target}
            disabled={busy || finished}
            onChange={(e) =>
              setTarget(
                e.target.value.startsWith('profile:')
                  ? (e.target.value as Target)
                  : 'project',
              )
            }
          >
            <option value="project">
              Project {project.displayName} (pull request)
            </option>
            {isAdmin
              ? profileKeys.map((key) => (
                  <option key={key} value={`profile:${key}`}>
                    Profile {key} (admin)
                  </option>
                ))
              : null}
          </Select>
        </Field>
        <Field label="Runtime" htmlFor="skill-install-runtime">
          <Select
            id="skill-install-runtime"
            value={runtime}
            disabled={busy || finished}
            onChange={(e) =>
              setRuntime(e.target.value === 'codex' ? 'codex' : 'claude')
            }
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </Select>
        </Field>
        {expired ? (
          <p role="alert" className="text-sm text-warn">
            This preview expired. Close and open the skill again.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {outcome ? (
          <div role="status" className="flex items-center gap-2 text-sm">
            <Badge
              tone={
                outcome.state === 'done'
                  ? 'ok'
                  : outcome.state === 'pending'
                    ? 'warn'
                    : 'danger'
              }
              label={outcome.state}
            />
            <span>{outcome.text}</span>
            {outcome.prUrl ? (
              <a
                href={outcome.prUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline-offset-2 hover:underline"
              >
                Open pull request
              </a>
            ) : null}
          </div>
        ) : null}
        <div>
          <Button disabled={busy || finished || expired} onClick={install}>
            {busy ? 'Installing…' : 'Install'}
          </Button>
        </div>
      </section>
    </div>
  );
}
