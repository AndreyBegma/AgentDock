import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkpointFromHeading } from '@agentdock/shared';
import {
  CHECKPOINT_SUMMARY_MAX_BYTES,
  type SlotCheckpointData,
} from '@agentdock/shared/protocol';
import type { FleetEmitter } from '../../fleet/project';
import type { SlotBook } from '../../fleet/slots';
import { REPLY_FILE } from '../tmux/sessions';

export interface ReplySection {
  heading: string;
  body: string;
}

/** Heading text is capped by the event schema. */
const HEADING_MAX = 500;

/** Cuts a string to at most `max` UTF-8 bytes without splitting a character. */
export const truncateBytes = (text: string, max: number): string => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  let end = max;
  // Step back over continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
};

/**
 * The `## ` sections of a reply file, in order (spec 11 D5). Deeper headings
 * belong to the body; a `## ` inside a fenced code block is not a heading.
 */
export const parseReply = (text: string): ReplySection[] => {
  const sections: { heading: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && !line.startsWith('###')) {
      sections.push({ heading: heading[1], lines: [] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections.map((s) => ({
    heading: s.heading,
    body: s.lines.join('\n').trim(),
  }));
};

/** The `slot.checkpoint` data of one section at its position. */
export const checkpointData = (
  section: ReplySection,
  position: number,
): SlotCheckpointData => {
  const heading = truncateBytes(section.heading, HEADING_MAX);
  const { checkpoint, prUrl } = checkpointFromHeading(section.heading);
  return {
    checkpoint,
    heading,
    summary: truncateBytes(section.body, CHECKPOINT_SUMMARY_MAX_BYTES),
    position,
    ...(prUrl && URL.canParse(prUrl) ? { prUrl } : {}),
  };
};

export interface ReplyWatcherOptions {
  book: SlotBook;
  emit: FleetEmitter;
}

/**
 * Reads `.orchestrator-reply.md` in each slot's worktree and emits a
 * `slot.checkpoint` (source `scraped`) for every section not sent yet, or
 * whose heading or body changed since — the position keeps a rescan
 * idempotent on the API side.
 */
export class ReplyWatcher {
  private readonly stamps = new Map<string, string>();
  private readonly sent = new Map<string, string[]>();
  private readonly lengths = new Map<string, number>();

  constructor(private readonly options: ReplyWatcherOptions) {}

  /** The reply files to watch, for `fs.watch`. */
  files(): string[] {
    return [...this.options.book.worktrees.values()].map((w) =>
      join(w.path, REPLY_FILE),
    );
  }

  scan(): void {
    const { book, emit } = this.options;
    for (const [slot, worktree] of book.worktrees) {
      const path = join(worktree.path, REPLY_FILE);
      let stamp: string;
      try {
        const stat = statSync(path);
        stamp = `${worktree.path}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        continue;
      }
      if (this.stamps.get(slot) === stamp) continue;
      this.stamps.set(slot, stamp);
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      // A file that shrank was started over (a new run of the slot): resend all.
      const previous =
        text.length < (this.lengths.get(slot) ?? 0)
          ? []
          : (this.sent.get(slot) ?? []);
      this.lengths.set(slot, text.length);
      const sent = parseReply(text).map((section, position) => {
        const data = checkpointData(section, position);
        const key = JSON.stringify(data);
        if (previous[position] !== key) {
          emit('slot.checkpoint', data, {
            slot,
            issue: book.issue(slot),
            source: 'scraped',
          });
        }
        return key;
      });
      this.sent.set(slot, sent);
    }
  }
}
