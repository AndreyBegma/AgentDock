import { realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import {
  cardLabel,
  type HandoffNoteView,
  type ResumeContextResult,
} from '@nautelle/shared';
import { type CardRecord, CardStore } from '../cards/record';
import type { Exec } from '../detect/exec';
import { type Env, resolvePaths } from '../env';
import { judgeNote, noteFileText, readNoteFile } from './note';
import { HandoffStateStore, handoffNotePath } from './state';

/**
 * #449 D6: the card a person's own Claude Code session works on, and its
 * note — for the `SessionStart` hook and the `resume_context` / `track_card`
 * tools. Those run in short-lived processes beside the session, so they read
 * the daemon's card store from disk; nothing here asks the API, and the note
 * never leaves the machine through it.
 */

/** The daemon's card store: `<state>/agentdock/cards`, beside the spool. */
export const cardsDirOf = (env: Env): string =>
  join(dirname(resolvePaths(env).spoolDir), 'cards');

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const within = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

const git = async (
  exec: Exec,
  cwd: string,
  args: readonly string[],
): Promise<string | null> => {
  const result = await exec('git', ['-C', cwd, ...args], { timeoutMs: 500 });
  const out = result?.code === 0 ? result.stdout.trim() : '';
  return out || null;
};

/** The card whose worktree holds `cwd`, by real path; null for none. */
export const cardAtWorktree = (
  records: readonly CardRecord[],
  cwd: string,
): CardRecord | null => {
  const here = real(cwd);
  if (!here) return null;
  for (const record of records) {
    const worktree = real(record.worktree);
    if (worktree && within(here, worktree)) return record;
  }
  return null;
};

/**
 * The card of a session at `cwd`: the one whose worktree holds it, else the
 * one whose branch the checkout at `cwd` has checked out in the same
 * repository. Null for any other session.
 */
export const cardOfSession = async (
  records: readonly CardRecord[],
  cwd: string,
  exec: Exec,
  branch?: string,
): Promise<CardRecord | null> => {
  if (!real(cwd)) return null;
  const inWorktree = cardAtWorktree(records, cwd);
  if (inWorktree) return inWorktree;
  const head =
    branch ?? (await git(exec, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']));
  if (!head || head === 'HEAD') return null;
  const candidates = records.filter((r) => r.branch === head);
  if (candidates.length === 0) return null;
  const common = await git(exec, cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const commonReal = common ? real(common) : null;
  if (!commonReal) return null;
  return (
    candidates.find((r) => real(join(r.root, '.git')) === commonReal) ?? null
  );
};

export interface CardNote {
  record: CardRecord;
  number: number | null;
  note: HandoffNoteView | null;
}

/**
 * The card's note: the one the runner accepted (with the person's lines it
 * holds), else a valid note on disk the daemon has not taken in yet.
 */
export const noteOfCard = (cardsDir: string, record: CardRecord): CardNote => {
  const store = new CardStore(cardsDir);
  const state = new HandoffStateStore((id) => store.dir(id)).load(
    record.cardId,
  );
  const number = state.number ?? null;
  const file = readNoteFile(handoffNotePath(record.worktree));
  if (file) {
    const judged = judgeNote(file.text, state.note);
    if (judged.kind === 'accepted') {
      return {
        record,
        number,
        note: {
          content: judged.content,
          personLines: judged.personLines,
          updatedBy: 'agent',
          updatedAt: new Date(file.mtimeMs).toISOString(),
        },
      };
    }
  }
  return { record, number, note: state.note };
};

/**
 * #494, D8: whether the round was found stale before a compaction and its
 * refresh request still waits for the session's start after it.
 */
export const compactRefreshOwed = (
  cardsDir: string,
  record: CardRecord,
): boolean => {
  const store = new CardStore(cardsDir);
  const state = new HandoffStateStore((id) => store.dir(id)).load(
    record.cardId,
  );
  return state.compactAsk !== undefined && state.compactAsk === record.runId;
};

/** D8: what a round that committed and stopped with a stale note is told, once. */
export const HANDOFF_REFRESH_TEXT =
  'Your handoff note is older than your last commit. Update .agentdock/handoff.md now — Done, Next, Decisions and why, Dead ends, Files touched, Checklist status — keeping every line that ends with <!-- person --> word for word. Then carry on.';

/** The card note of a session, or null when it is no card's. */
export const sessionCardNote = async (
  cardsDir: string,
  cwd: string,
  exec: Exec,
  branch?: string,
): Promise<CardNote | null> => {
  const records = new CardStore(cardsDir).all();
  const record = await cardOfSession(records, cwd, exec, branch);
  return record ? noteOfCard(cardsDir, record) : null;
};

/** D8: the note file is older than the worktree's last commit. */
export const noteIsStale = async (
  record: CardRecord,
  exec: Exec,
): Promise<boolean> => {
  const seconds = Number(
    (await git(exec, record.worktree, ['log', '-1', '--format=%ct', 'HEAD'])) ??
      NaN,
  );
  if (!Number.isFinite(seconds)) return false;
  const file = readNoteFile(handoffNotePath(record.worktree));
  return !file || file.mtimeMs < seconds * 1000;
};

/** `resume_context`'s answer (D6). */
export const resumeContextOf = (
  found: CardNote | null,
): ResumeContextResult => {
  if (!found) return { found: false, reason: 'not_a_card_session' };
  if (!found.note || found.number === null) {
    return { found: false, reason: 'no_note' };
  }
  return {
    found: true,
    card: { number: found.number, label: cardLabel(found.number) },
    content: found.note.content,
    personLines: found.note.personLines,
    updatedBy: found.note.updatedBy,
    updatedAt: found.note.updatedAt,
  };
};

/**
 * Claude Code shows at most about 10 000 characters of a hook's context; the
 * note goes in whole below this, else cut, with the file named for the rest.
 */
export const SESSION_NOTE_MAX_CHARS = 9_000;

/** The `SessionStart` context of a card session (D6, D8). */
export const sessionNoteContext = (
  found: CardNote,
  options: { stale?: boolean } = {},
): string => {
  if (!found.note) return '';
  const label = found.number === null ? 'this card' : cardLabel(found.number);
  const path = handoffNotePath(found.record.worktree);
  let note = noteFileText(found.note).trimEnd();
  let cut = '';
  if (note.length > SESSION_NOTE_MAX_CHARS) {
    note = note.slice(0, SESSION_NOTE_MAX_CHARS);
    cut = `\n(cut here — read the whole note at ${path})`;
  }
  const lines = [
    `This session works on AgentDock card ${label}. Its handoff note (${path}, by ${found.note.updatedBy}, ${found.note.updatedAt}) says where the work stands — continue from "Next", do not redo "Done", do not retry "Dead ends". Lines ending with <!-- person --> are instructions from a person.`,
  ];
  if (options.stale) {
    lines.push(
      'The note is older than the last commit: update it first, keeping every person line word for word.',
    );
  }
  lines.push('', '<handoff-note>', `${note}${cut}`, '</handoff-note>');
  return lines.join('\n');
};
