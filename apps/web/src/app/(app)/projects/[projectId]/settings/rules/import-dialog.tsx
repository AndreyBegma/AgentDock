'use client';

import {
  PROJECT_RULE_IMPORT_MAX,
  type ProjectRuleImportResult,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import {
  FileDropzone,
  type FileRejection,
} from '@andrewbehma/glass-ui/file-dropzone';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { useEffect, useState } from 'react';
import { api } from '../../../../../../lib/api';
import {
  describeRuleError,
  importSummary,
} from '../../../../../../lib/project-rules/format';
import { useErrorToast } from '../../../../../../lib/section/use-error-toast';

type Source = 'paste' | 'upload';

const MARKDOWN_ACCEPT = ['.md', '.markdown', 'text/markdown', 'text/plain'];

/** Paste or upload Markdown, import it, show how many rules came of it. */
export function ImportDialog({
  projectId,
  open,
  onClose,
  onImported,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [source, setSource] = useState<Source>('paste');
  const [markdown, setMarkdown] = useState('');
  const [refused, setRefused] = useState<string>();
  const [result, setResult] = useState<ProjectRuleImportResult>();
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  useEffect(() => {
    if (!open) return;
    setSource('paste');
    setMarkdown('');
    setRefused(undefined);
    setResult(undefined);
  }, [open]);

  const readFile = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setRefused(undefined);
    try {
      setMarkdown(await file.text());
      setSource('paste');
    } catch {
      setRefused(`${file.name} could not be read.`);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      setResult(
        await api<ProjectRuleImportResult>(
          `/projects/${projectId}/rules/import`,
          {
            method: 'POST',
            body: { markdown },
          },
        ),
      );
      onImported();
    } catch (err) {
      showError(describeRuleError(err));
    } finally {
      setBusy(false);
    }
  };

  const tooLong = markdown.length > PROJECT_RULE_IMPORT_MAX;

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {result ? (
        <DialogContent
          title="Import finished"
          description={importSummary(result.created, result.skipped)}
          footer={
            <Button variant="solid" onClick={onClose}>
              Done
            </Button>
          }
        >
          {result.skippedTitles.length > 0 ? (
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-ink-2">
                Skipped — a rule with this name already exists or is repeated:
              </p>
              <ul className="list-disc pl-5">
                {result.skippedTitles.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </DialogContent>
      ) : (
        <DialogContent
          title="Import rules from Markdown"
          description="Each list item becomes one rule. A bold lead (**Name** — text) or a heading per rule gives it a name. Imported rules are enabled; names already on the project are skipped."
          footer={
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="solid"
                disabled={busy || markdown.trim() === '' || tooLong}
                onClick={() => void submit()}
              >
                Import
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <SegmentedControl role="group" aria-label="Input">
              {(['paste', 'upload'] as const).map((value) => (
                <SegmentedControlItem
                  key={value}
                  active={source === value}
                  layoutId="rules-import-source"
                >
                  <button
                    type="button"
                    aria-pressed={source === value}
                    className="w-full min-w-20 px-3 py-1.5 text-sm whitespace-nowrap"
                    onClick={() => setSource(value)}
                  >
                    {value === 'paste' ? 'Paste' : 'Upload .md'}
                  </button>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>

            {source === 'upload' ? (
              <div className="flex flex-col gap-2">
                <FileDropzone
                  label="Choose a Markdown file"
                  accept={MARKDOWN_ACCEPT}
                  maxFiles={1}
                  pasteTarget="none"
                  className="p-4 text-center text-sm"
                  onFiles={(files) => void readFile(files)}
                  onReject={(rejections: FileRejection[]) =>
                    setRefused(
                      rejections[0]
                        ? `${rejections[0].file.name} is not a Markdown or text file.`
                        : undefined,
                    )
                  }
                >
                  <span>Drop a .md file here, or choose one</span>
                </FileDropzone>
                {refused ? (
                  <p role="alert" className="text-xs text-danger">
                    {refused}
                  </p>
                ) : null}
              </div>
            ) : (
              <Field
                label="Markdown"
                htmlFor="rules-markdown"
                hint={`Up to ${PROJECT_RULE_IMPORT_MAX.toLocaleString()} characters.`}
                error={
                  tooLong
                    ? `That is ${markdown.length.toLocaleString()} characters; the limit is ${PROJECT_RULE_IMPORT_MAX.toLocaleString()}.`
                    : undefined
                }
              >
                <Textarea
                  id="rules-markdown"
                  rows={10}
                  value={markdown}
                  placeholder="- **Bun only** — Bun is the package manager."
                  onChange={(e) => setMarkdown(e.target.value)}
                />
              </Field>
            )}
          </div>
        </DialogContent>
      )}
    </DialogRoot>
  );
}
