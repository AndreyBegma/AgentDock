import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  SLOT_MESSAGE_SEEN_MAX_BYTES,
  type SlotMessageSeenData,
} from '@nautelle/shared/protocol';
import { MESSAGE_FILE } from '../../control/slot';
import type { FleetEmitter } from '../../fleet/project';
import type { SlotBook } from '../../fleet/slots';
import {
  AGENT_FILE_MAX_BYTES,
  readRegularFileInside,
} from '../../fs/safe-read';
import { redactText } from '../../pane/redact';
import { truncateBytes } from './replies';

/** `From: <sender>` — the header Nautelle's `slot.message` writes (spec 17 D7). */
const FROM_HEADER = /^From:\s*(.+?)\s*$/im;
/** `Date: <iso>` of the same header block. */
const DATE_HEADER = /^Date:\s*(\S+)\s*$/im;
/** `# From the orchestrator (agentdock-fd): …` — the skill's own title. */
const FROM_HEADING = /^#{1,6}\s+From\s+(.+?)\s*(?::|$)/im;

/** The sender and date a message names about itself, if any. */
export const messageHeader = (
  body: string,
): Pick<SlotMessageSeenData, 'sender' | 'sentAt'> => {
  const head = body.split(/\n\s*\n/, 1)[0] ?? '';
  const sender = (FROM_HEADER.exec(head)?.[1] ?? FROM_HEADING.exec(head)?.[1])
    // ADR-0073: a message written before the rename says `via AgentDock`.
    ?.replace(/\s+via (?:Nautelle|AgentDock)$/i, '')
    .slice(0, 320);
  const date = DATE_HEADER.exec(head)?.[1];
  const sentAt =
    date && !Number.isNaN(Date.parse(date)) && /T/.test(date)
      ? new Date(date).toISOString()
      : undefined;
  return {
    ...(sender ? { sender } : {}),
    ...(sentAt ? { sentAt } : {}),
  };
};

/**
 * The new message in a message file, given what it held before: the appended
 * suffix when the file grew by appending, else the whole file. Null when
 * nothing but whitespace was added.
 */
export const newMessage = (
  previous: string | undefined,
  text: string,
): { body: string; mode: SlotMessageSeenData['mode'] } | null => {
  const appended =
    previous !== undefined &&
    previous.length > 0 &&
    text.length > previous.length &&
    text.startsWith(previous);
  const body = (appended ? text.slice(previous.length) : text).trim();
  if (body.length === 0) return null;
  return { body, mode: appended ? 'appended' : 'replaced' };
};

export interface MessageWatcherOptions {
  book: SlotBook;
  emit: FleetEmitter;
}

/**
 * Reads `.orchestrator-msg.md` in each slot's worktree, so the conversation
 * keeps the orchestrator's side too (docs/specs/160-agent-workspace.md).
 * Every change of the file is one `slot.message_seen` (source `scraped`).
 * What was read last is kept in memory only: after a restart the file is sent
 * once more, whole, and the API drops it by its unchanged `fileHash`.
 */
export class MessageWatcher {
  private readonly stamps = new Map<string, string>();
  private readonly contents = new Map<string, string>();

  constructor(private readonly options: MessageWatcherOptions) {}

  /** The message files to watch, for `fs.watch`. */
  files(): string[] {
    return [...this.options.book.worktrees.values()].map((w) =>
      join(w.path, MESSAGE_FILE),
    );
  }

  scan(): void {
    const { book, emit } = this.options;
    for (const [slot, worktree] of book.worktrees) {
      const path = join(worktree.path, MESSAGE_FILE);
      let stamp: string;
      try {
        const stat = lstatSync(path);
        stamp = `${worktree.path}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        continue;
      }
      if (this.stamps.get(slot) === stamp) continue;
      this.stamps.set(slot, stamp);
      const text = readRegularFileInside(
        worktree.path,
        MESSAGE_FILE,
        AGENT_FILE_MAX_BYTES,
      );
      if (text === null) continue;
      const key = `${worktree.path}\0${slot}`;
      const previous = this.contents.get(key);
      if (previous === text) continue;
      this.contents.set(key, text);
      const message = newMessage(previous, text);
      if (!message) continue;
      const body = truncateBytes(
        redactText(message.body),
        SLOT_MESSAGE_SEEN_MAX_BYTES,
      );
      const data: SlotMessageSeenData = {
        body,
        ...messageHeader(body),
        mode: message.mode,
        fileHash: createHash('sha256').update(text).digest('hex'),
      };
      emit('slot.message_seen', data, {
        slot,
        issue: book.issue(slot),
        source: 'scraped',
      });
    }
  }
}
