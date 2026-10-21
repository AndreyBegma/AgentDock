'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { Textarea } from '@andrewbehma/glass-ui/field';
import { toast } from '@andrewbehma/glass-ui/toast';
import type {
  UiProfileScreen,
  UiProfileStyleRule,
  UiProfileVersionView,
} from '@nautelle/shared';
import { Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { api } from '../../../../../../lib/api';
import { describeDesignError } from '../../../../../../lib/design/format';
import { uiProfileApi } from '../../../../../../lib/design/href';
import {
  designRefHref,
  designRefLabel,
  memoryTextError,
  memoryUpdateBody,
} from '../../../../../../lib/design/profile-memory';
import { Time } from '../../../../../../lib/format/time';
import { useErrorToast } from '../../../../../../lib/section/use-error-toast';

type Change = {
  screens?: UiProfileScreen[];
  styleRules?: UiProfileStyleRule[];
};

/** An item waiting on the delete confirmation. */
type Deleting = { label: string; change: Change };

/**
 * Settings → Design → UI profile → **Approved screens** and **Style rules**
 * (#752 A5): what approvals taught the profile, each item with the design it
 * came from. On the current version a project admin edits or deletes an
 * item; the save is a manual version of the whole profile.
 */
export function ProfileMemory({
  projectId,
  profile,
  editable,
  onSaved,
}: {
  projectId: string;
  profile: UiProfileVersionView;
  /** A project admin, on the current version. */
  editable: boolean;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const showError = useErrorToast();

  const save = async (change: Change, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      await api(uiProfileApi(projectId), {
        method: 'PUT',
        body: memoryUpdateBody(profile, change),
      });
      toast.success(done);
      onSaved();
      return true;
    } catch (error) {
      showError(describeDesignError(error, projectId));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const source = (designId: string | null): ReactNode => {
    const ref = designId ? profile.designs[designId] : undefined;
    if (!designId) return 'Written by a person';
    if (!ref) return 'From a design no longer here';
    return (
      <Link
        href={designRefHref(projectId, ref)}
        className="text-accent underline-offset-2 hover:underline"
      >
        {designRefLabel(ref)}
      </Link>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <MemoryList
        headingId="ui-profile-screens"
        title={`Approved screens (${profile.screens.length})`}
        empty="None yet. Each approved design adds its screen here."
        items={profile.screens.map((s, i) => ({
          key: `${s.revisionId}`,
          title: s.name,
          text: s.summary,
          kind: 'screen' as const,
          meta: (
            <>
              {source(s.designId)} · approved <Time value={s.approvedAt} />
              {s.snippetsUsed.length > 0
                ? ` · uses ${s.snippetsUsed.join(', ')}`
                : ''}
            </>
          ),
          onEdit: (summary: string) =>
            save(
              {
                screens: profile.screens.map((x, j) =>
                  j === i ? { ...x, summary: summary.trim() } : x,
                ),
              },
              'Screen saved',
            ),
          onDelete: () =>
            setDeleting({
              label: `the screen “${s.name}”`,
              change: { screens: profile.screens.filter((_, j) => j !== i) },
            }),
        }))}
        editable={editable}
        busy={busy}
      />
      <MemoryList
        headingId="ui-profile-rules"
        title={`Style rules (${profile.styleRules.length})`}
        empty="None yet. Decisions taken in design comments become rules here."
        items={profile.styleRules.map((r, i) => ({
          key: `${i}-${r.text}`,
          title: null,
          text: r.text,
          kind: 'rule' as const,
          meta: source(r.designId),
          onEdit: (text: string) =>
            save(
              {
                styleRules: profile.styleRules.map((x, j) =>
                  j === i ? { ...x, text: text.trim() } : x,
                ),
              },
              'Rule saved',
            ),
          onDelete: () =>
            setDeleting({
              label: 'this style rule',
              change: {
                styleRules: profile.styleRules.filter((_, j) => j !== i),
              },
            }),
        }))}
        editable={editable}
        busy={busy}
      />
      {profile.learnNotes ? (
        <p className="whitespace-pre-line text-xs text-ink-3">
          {profile.learnNotes}
        </p>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete from the UI profile?"
        consequence={`New designs no longer read ${deleting?.label ?? 'it'}. The profile gets a new version; older ones keep it.`}
        verb="Delete"
        busy={busy}
        onConfirm={() => {
          if (!deleting) return;
          void save(deleting.change, 'Deleted').then((ok) => {
            if (ok) setDeleting(null);
          });
        }}
      />
    </div>
  );
}

interface MemoryItem {
  key: string;
  title: string | null;
  text: string;
  kind: 'screen' | 'rule';
  meta: ReactNode;
  onEdit: (text: string) => Promise<boolean>;
  onDelete: () => void;
}

function MemoryList({
  headingId,
  title,
  empty,
  items,
  editable,
  busy,
}: {
  headingId: string;
  title: string;
  empty: string;
  items: MemoryItem[];
  editable: boolean;
  busy: boolean;
}) {
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className="text-xs font-semibold text-ink-2">
        {title}
      </h4>
      {items.length === 0 ? (
        <p className="text-xs text-ink-3">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <MemoryRow
              key={item.key}
              item={item}
              editable={editable}
              busy={busy}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryRow({
  item,
  editable,
  busy,
}: {
  item: MemoryItem;
  editable: boolean;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const error = draft === null ? null : memoryTextError(item.kind, draft);
  const name = item.title ?? 'rule';
  return (
    <li className="flex flex-col gap-1 rounded-md border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          {item.title ? (
            <span className="text-sm font-medium text-ink-1">{item.title}</span>
          ) : null}
          {draft === null ? (
            <p className="whitespace-pre-line break-words text-sm text-ink-2">
              {item.text}
            </p>
          ) : null}
        </div>
        {editable && draft === null ? (
          <span className="flex shrink-0 gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon
              aria-label={`Edit ${name}`}
              disabled={busy}
              onClick={() => setDraft(item.text)}
            >
              <Pencil aria-hidden="true" className="size-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon
              aria-label={`Delete ${name}`}
              disabled={busy}
              onClick={item.onDelete}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          </span>
        ) : null}
      </div>
      {draft !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (error) return;
            void item.onEdit(draft).then((ok) => {
              if (ok) setDraft(null);
            });
          }}
        >
          <Textarea
            aria-label={`Edit ${name}`}
            value={draft}
            rows={item.kind === 'screen' ? 5 : 2}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setDraft(e.target.value)}
          />
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="solid"
              disabled={busy || error !== null}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <span className="text-xs text-ink-3">{item.meta}</span>
    </li>
  );
}
