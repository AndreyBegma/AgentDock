'use client';

import type { AssistantConversationView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { InlineEdit } from '@andrewbehma/glass-ui/inline-edit';
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { groupConversations } from '../../lib/assistant/group-conversations';

export const UNTITLED = 'New conversation';

/** Conversations grouped by calendar day, with new, rename and delete. */
export function ConversationRail({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  /** Null while the list loads. */
  conversations: AssistantConversationView[] | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AssistantConversationView | null>(
    null,
  );
  const groups = useMemo(
    () => groupConversations(conversations ?? []),
    [conversations],
  );

  return (
    <nav
      aria-label="Conversations"
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <Button variant="glass" size="sm" full onClick={onNew}>
        <Plus size={14} aria-hidden="true" />
        New conversation
      </Button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversations === null ? (
          <div className="flex flex-col gap-2 p-1">
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
          </div>
        ) : groups.length === 0 ? (
          <p className="px-2 py-3 text-xs text-ink-3">
            No conversations yet. Ask something to start one.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.key} aria-label={group.label} className="mb-3">
              <h3 className="px-2 pb-1 text-xs font-semibold text-ink-3">
                {group.label}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {group.conversations.map((conversation) => {
                  const title = conversation.title ?? UNTITLED;
                  const selected = conversation.id === activeId;
                  return (
                    <li
                      key={conversation.id}
                      className={`group flex items-center rounded-control ${selected ? 'bg-accent-soft text-accent-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'}`}
                    >
                      {renaming === conversation.id ? (
                        <InlineEdit
                          value={conversation.title ?? ''}
                          placeholder={UNTITLED}
                          aria-label="Conversation title"
                          autoFocus
                          className="min-w-0 flex-1 px-2 py-1.5 text-sm"
                          onCommit={(value) => {
                            setRenaming(null);
                            const next = value.trim();
                            if (next && next !== conversation.title) {
                              onRename(conversation.id, next);
                            }
                          }}
                          onBlur={() => setRenaming(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => onSelect(conversation.id)}
                          className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
                          title={title}
                        >
                          {title}
                        </button>
                      )}
                      <MenuRoot>
                        <MenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon
                            aria-label={`Actions for ${title}`}
                            className="shrink-0"
                          >
                            <MoreHorizontal size={14} aria-hidden="true" />
                          </Button>
                        </MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem
                            onSelect={() => setRenaming(conversation.id)}
                          >
                            <Pencil size={16} aria-hidden="true" />
                            Rename
                          </MenuItem>
                          <MenuItem
                            tone="danger"
                            onSelect={() => setDeleting(conversation)}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            Delete
                          </MenuItem>
                        </MenuContent>
                      </MenuRoot>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this conversation?"
        consequence="The messages and the attachments stay out of reach for good. Cards the assistant queued are not touched."
        verb="Delete"
        tone="danger"
        onConfirm={() => {
          if (deleting) onDelete(deleting.id);
          setDeleting(null);
        }}
      />
    </nav>
  );
}
