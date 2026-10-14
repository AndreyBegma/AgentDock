import type { CheckpointKind, WorktreeStatusResult } from '../protocol';

/**
 * A slot's conversation (docs/specs/160-agent-workspace.md): the
 * orchestrator's messages from `.orchestrator-msg.md` and the worker's
 * sections of `.orchestrator-reply.md`, in time order, for the slot's latest
 * run.
 */

/** A message to the worker — one `slot.message_seen`. */
export interface ConversationMessageEntry {
  from: 'orchestrator';
  /** `orchestrator:<event id>`; stable across refetches. */
  id: string;
  /** When the runner saw it. */
  at: string;
  /** `From:` of its header (a user's email for AgentDock's own messages), else null. */
  sender: string | null;
  /** `Date:` of its header, else null. */
  sentAt: string | null;
  /** Markdown, at most 16 KB. */
  body: string;
  /** `appended`: a section added to the file; `replaced`: the whole new file. */
  mode: 'appended' | 'replaced';
}

/** A `##` section the worker wrote — one checkpoint. */
export interface ConversationReplyEntry {
  from: 'worker';
  /** `worker:<checkpoint id>`. */
  id: string;
  /** When the runner first saw it. */
  at: string;
  checkpoint: CheckpointKind;
  /** The heading as written, without `## `. */
  heading: string;
  /** Markdown, at most 4 KB (`CHECKPOINT_SUMMARY_MAX_BYTES`). */
  body: string;
  /** Index of the heading in the reply file. */
  position: number;
}

export type ConversationEntry =
  | ConversationMessageEntry
  | ConversationReplyEntry;

/** Entries a conversation returns at most; the newest are kept. */
export const SLOT_CONVERSATION_MAX_ENTRIES = 500;

/** `GET /projects/:id/slots/:slot/conversation`. */
export interface SlotConversation {
  slot: string;
  /** The run the entries belong to. */
  slotId: string;
  /** Oldest first; ties keep reply-file order. */
  entries: ConversationEntry[];
  /** Entries left out, oldest first, beyond `SLOT_CONVERSATION_MAX_ENTRIES`. */
  truncated: number;
}

/** `GET /projects/:id/slots/:slot/worktree` — the runner's answer, cached for 10 s. */
export interface SlotWorktreeView extends WorktreeStatusResult {
  /** When the runner answered; a cached answer keeps its time. */
  fetchedAt: string;
}

/** How long the API reuses a `worktree.status` answer per slot. */
export const SLOT_WORKTREE_CACHE_MS = 10_000;
