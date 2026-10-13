'use client';

import type {
  CreatePriceVersionRequest,
  ModelPriceInput,
} from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { describeUsageError } from '../../../lib/usage/format';

export type Draft = {
  upsert: Map<string, ModelPriceInput>;
  remove: Set<string>;
};

export const emptyDraft = (): Draft => ({
  upsert: new Map(),
  remove: new Set(),
});

/** Saves the draft as a new price version, which becomes current. */
export function SaveDialog({
  open,
  draft,
  onClose,
  onSaved,
}: {
  open: boolean;
  draft: Draft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setNote('');
      setError(undefined);
    }
  }, [open]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: CreatePriceVersionRequest = {
        note: note.trim(),
        upsert: [...draft.upsert.values()],
        remove: [...draft.remove],
      };
      await api('/admin/prices/versions', { method: 'POST', body });
      toast.success('New price version created. It is now current.');
      onSaved();
    } catch (err) {
      setError(describeUsageError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Save as a new version"
        description="The current version is cloned, your changes applied, and the result becomes current. Requests already priced keep their cost until you re-price them."
      >
        <form onSubmit={save} className="flex flex-col gap-3">
          <p className="text-sm text-ink-2">
            {draft.upsert.size} added or changed · {draft.remove.size} removed
          </p>
          <Field label="Note" htmlFor="version-note">
            <Input
              id="version-note"
              value={note}
              maxLength={500}
              placeholder="What changed, and why"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="solid" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Create version'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
