'use client';

import {
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_KINDS,
  BOARD_CARD_TITLE_MAX,
  type BoardCardKind,
  type BoardSettingsView,
  type CreateBoardCardRequest,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input, Select, Textarea } from '@andrewbehma/glass-ui/field';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useEffect, useState } from 'react';
import { createCard } from '../../lib/board/actions';
import { describeBoardError } from '../../lib/board/format';
import { CardOptionToggles } from './card-options';

const KIND_LABEL: Record<BoardCardKind, string> = {
  feature: 'Feature',
  bug: 'Bug',
};

export function NewCardDialog({
  projectId,
  open,
  settings,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  /** The toggles start from the project's board settings. */
  settings: BoardSettingsView | undefined;
  onOpenChange: (open: boolean) => void;
  onCreated: (number: number) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<BoardCardKind>('feature');
  const [issueOnRun, setIssueOnRun] = useState(false);
  const [specOnRun, setSpecOnRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setIssueOnRun(settings?.issueOnRun ?? false);
    setSpecOnRun(settings?.specOnRun ?? false);
  }, [open, settings?.issueOnRun, settings?.specOnRun]);

  const valid = title.trim() !== '';

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const request: CreateBoardCardRequest = {
      title: title.trim(),
      body,
      kind,
      issueOnRun,
      specOnRun,
    };
    try {
      const card = await createCard(projectId, request);
      toast.success(`${card.label} created.`);
      setTitle('');
      setBody('');
      setKind('feature');
      onOpenChange(false);
      onCreated(card.number);
    } catch (err) {
      setError(describeBoardError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        title="New card"
        description="A card is AgentDock’s own work item. Run starts a dedicated worker on it."
        footer={
          <>
            <Button
              variant="glass"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy || !valid} onClick={submit}>
              {busy ? 'Creating…' : 'Create card'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void submit();
          }}
        >
          <Field label="Title" htmlFor="board-new-title" required>
            <Input
              id="board-new-title"
              value={title}
              maxLength={BOARD_CARD_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field
            label="What to do"
            htmlFor="board-new-body"
            hint="Markdown. The worker reads this as its task."
          >
            <Textarea
              id="board-new-body"
              rows={8}
              value={body}
              maxLength={BOARD_CARD_BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <Field label="Kind" htmlFor="board-new-kind">
            <Select
              id="board-new-kind"
              value={kind}
              onChange={(e) =>
                setKind(
                  BOARD_CARD_KINDS.find((k) => k === e.target.value) ?? kind,
                )
              }
            >
              {BOARD_CARD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <CardOptionToggles
            projectId={projectId}
            idPrefix="board-new"
            issueOnRun={issueOnRun}
            specOnRun={specOnRun}
            onIssueOnRun={setIssueOnRun}
            onSpecOnRun={setSpecOnRun}
          />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
