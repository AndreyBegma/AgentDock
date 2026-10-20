'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import type { PlannerInstructionsVersion } from '@nautelle/shared';
import { useEffect, useRef, useState } from 'react';
import { Time } from '../../../lib/format/time';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { describePlannerError } from '../../../lib/tasks/format';
import { DiffView } from './diff-view';

/** What the diff panel is comparing. */
interface Comparison {
  label: string;
  before: string;
  after: string;
}

/** The version before `version` in a newest-first list, if the list holds it. */
const previousOf = (
  versions: readonly PlannerInstructionsVersion[],
  version: PlannerInstructionsVersion,
): PlannerInstructionsVersion | undefined =>
  versions.find((candidate) => candidate.version === version.version - 1);

/**
 * The planner's instructions (ADR-0019, D11), shared by `/admin/planner` and
 * the project's Planner settings. The fixed output contract is shown read-only
 * below the editor, so an author knows what must not be asked of the model.
 *
 * Restore loads an older body into the editor; Save then writes a new version,
 * so history is only ever appended to.
 */
export function InstructionsEditor({
  current,
  versions,
  contract,
  contractVersion,
  canEdit,
  allowClear = false,
  noCurrentNote,
  onSave,
}: {
  /** Null: nothing is set at this level (a project without an override). */
  current: PlannerInstructionsVersion | null;
  /** Every version, newest first. */
  versions: PlannerInstructionsVersion[];
  contract: string;
  contractVersion: number;
  canEdit: boolean;
  /** An empty body is a valid save: it clears the override. */
  allowClear?: boolean;
  noCurrentNote?: string;
  onSave: (body: string) => Promise<void>;
}) {
  const saved = current?.body ?? '';
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [comparison, setComparison] = useState<Comparison>();
  const [contractOpen, setContractOpen] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const showError = useErrorToast();

  // A save, or a live reload, brings a new current version: the editor follows.
  const currentId = current?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the saved version changes
  useEffect(() => {
    setDraft(saved);
    setComparison(undefined);
  }, [currentId]);

  const dirty = draft !== saved;
  const clearing = draft.trim() === '' && saved !== '';
  const canSave =
    canEdit &&
    dirty &&
    !busy &&
    (draft.trim() !== '' || (allowClear && clearing));

  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft.trim() === '' ? '' : draft);
      toast.success(clearing ? 'Override cleared' : 'Saved as a new version');
    } catch (err) {
      showError(describePlannerError(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = (version: PlannerInstructionsVersion) => {
    setDraft(version.body);
    toast.success(
      `Version ${version.version} loaded. Save to make it current.`,
    );
    editor.current?.focus();
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="Instructions">
        {current === null && noCurrentNote ? (
          <p className="text-sm text-ink-2">{noCurrentNote}</p>
        ) : null}
        <Field
          label={
            current
              ? `Instructions — version ${current.version}`
              : 'Instructions'
          }
          htmlFor="planner-instructions"
          hint="How to split work, how to ask, and the specification rules. The output contract below is appended after this text."
        >
          <Textarea
            id="planner-instructions"
            ref={editor}
            value={draft}
            readOnly={!canEdit}
            rows={18}
            // The prompt is hard-wrapped as written: keep its lines whole and
            // scroll sideways, rather than re-wrapping them raggedly.
            wrap="off"
            className="overflow-x-auto whitespace-pre font-mono text-xs"
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="solid" disabled={!canSave} onClick={save}>
              {busy
                ? 'Saving…'
                : clearing
                  ? 'Clear override'
                  : 'Save new version'}
            </Button>
            <Button
              variant="glass"
              disabled={!dirty || busy}
              onClick={() => setDraft(saved)}
            >
              Discard changes
            </Button>
            {dirty ? (
              <Button
                variant="ghost"
                onClick={() =>
                  setComparison({
                    label: 'Your edit against the current version',
                    before: saved,
                    after: draft,
                  })
                }
              >
                Show my changes
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-ink-2">
            Only an admin can change the instructions.
          </p>
        )}
      </section>

      {comparison ? (
        <div className="flex flex-col gap-2">
          <DiffView {...comparison} />
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setComparison(undefined)}
          >
            Close the diff
          </Button>
        </div>
      ) : null}

      <section className="flex flex-col gap-2" aria-label="Versions">
        <SectionHeader title="Versions" />
        {versions.length === 0 ? (
          <p className="text-sm text-ink-2">No version has been saved yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-lg border border-line p-0">
            {versions.map((version) => {
              const previous = previousOf(versions, version);
              const isCurrent = version.id === current?.id;
              return (
                <li
                  key={version.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium num">v{version.version}</span>
                    {isCurrent ? <Badge tone="ok" label="Current" /> : null}
                    <span className="text-ink-2">
                      {version.author?.name ?? 'Seeded default'} ·{' '}
                      <Time value={version.createdAt} />
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {previous ? (
                      <Button
                        variant="glass"
                        size="sm"
                        aria-label={`Diff version ${version.version} against version ${previous.version}`}
                        onClick={() =>
                          setComparison({
                            label: `Version ${version.version} against version ${previous.version}`,
                            before: previous.body,
                            after: version.body,
                          })
                        }
                      >
                        Diff
                      </Button>
                    ) : null}
                    {canEdit && !isCurrent ? (
                      <Button
                        variant="glass"
                        size="sm"
                        aria-label={`Restore version ${version.version}`}
                        onClick={() => restore(version)}
                      >
                        Restore
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Disclosure
        open={contractOpen}
        onOpenChange={setContractOpen}
        trigger={`Output contract (v${contractVersion}) — fixed, read-only`}
        triggerClassName="text-sm text-ink-2"
      >
        <div className="pt-2">
          <CodeBlock code={contract} language="markdown" wrap maxHeight={420} />
        </div>
      </Disclosure>
    </div>
  );
}
