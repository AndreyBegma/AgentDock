import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  RoundDecisions,
  SlotDispatchedData,
} from '@agentdock/shared/protocol';
import type { FleetEmitter, FleetProject } from '../../fleet/project';
import type { SlotBook } from '../../fleet/slots';
import { parseBoard } from './parse-board';
import { parseBrief } from './parse-brief';

/** Boards older than this many days are history the first scan does not replay. */
export const BOARD_LOOKBACK_DAYS = 7;

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const BOARD_FILE = /^round-(\d{4})\.md$/;
const BRIEF_FILE = /^round-(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

interface FileStamp {
  path: string;
  date: string;
  round: string;
  stamp: string;
  mtimeMs: number;
}

const stampOf = (path: string): { stamp: string; mtimeMs: number } | null => {
  try {
    const stat = statSync(path);
    return stat.isFile()
      ? { stamp: `${stat.mtimeMs}:${stat.size}`, mtimeMs: stat.mtimeMs }
      : null;
  } catch {
    return null;
  }
};

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const listDir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

const leadOf = (cell: string | undefined): boolean | undefined => {
  if (cell === undefined) return undefined;
  if (/^yes\b/i.test(cell)) return true;
  if (/^(no\b|—|-|)$/i.test(cell.trim())) return false;
  return undefined;
};

export interface BoardWatcherOptions {
  project: FleetProject;
  book: SlotBook;
  emit: FleetEmitter;
  now: () => number;
}

/**
 * Reads the orchestrator's round boards and briefs (spec 11 D4) from
 * `<git-common-dir>/cs-orchestrator/<YYYY-MM-DD>/`. A board emits
 * `round.started` then `round.decided`; the newest brief of each slot emits
 * `slot.dispatched` and fills the slot book. Only files that changed since the
 * last scan are read. A file that does not parse emits `board.unparsed` — the
 * scan goes on with the next file.
 */
export class BoardWatcher {
  private readonly boards = new Map<string, string>();
  private readonly briefs = new Map<string, string>();
  private readonly decisions = new Map<string, RoundDecisions>();

  constructor(private readonly options: BoardWatcherOptions) {}

  scan(): void {
    const { boards, briefs } = this.list();
    for (const board of boards) this.readBoard(board);
    for (const [slot, brief] of briefs) this.readBrief(slot, brief);
  }

  private list() {
    const { boardDir } = this.options.project;
    const oldest = new Date(
      this.options.now() - (BOARD_LOOKBACK_DAYS - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const dates = listDir(boardDir)
      .filter((d) => DATE_DIR.test(d) && d >= oldest)
      .sort();
    const boards: FileStamp[] = [];
    const briefs = new Map<string, FileStamp>();
    for (const date of dates) {
      for (const name of listDir(join(boardDir, date)).sort()) {
        const board = BOARD_FILE.exec(name);
        const brief = board ? null : BRIEF_FILE.exec(name);
        if (!board && !brief) continue;
        const path = join(boardDir, date, name);
        const stamp = stampOf(path);
        if (!stamp) continue;
        const round = (board ?? brief)?.[1] as string;
        const file = { path, date, round, ...stamp };
        if (board) boards.push(file);
        // Dates and rounds sort as strings, so the last one seen is the newest.
        else if (brief) briefs.set(brief[2], file);
      }
    }
    return { boards, briefs };
  }

  private readBoard(file: FileStamp): void {
    if (this.boards.get(file.path) === file.stamp) return;
    this.boards.set(file.path, file.stamp);
    const text = readText(file.path);
    if (text === null) return;
    const { emit } = this.options;
    const parsed = parseBoard(text);
    if (!parsed.ok) {
      emit(
        'board.unparsed',
        { file: file.path, line: parsed.line, reason: parsed.reason },
        { source: 'scraped' },
      );
      return;
    }
    const { header, decisions } = parsed.value;
    // The file name is the round's identity; the header carries the rest.
    const key = { date: file.date, round: file.round };
    emit(
      'round.started',
      {
        ...key,
        base: header.base,
        occupied: header.occupied,
        max: header.max,
        free: header.free,
        boardPath: file.path,
      },
      { source: 'scraped' },
    );
    emit('round.decided', { ...key, decisions }, { source: 'scraped' });
    this.decisions.set(`${file.date}/${file.round}`, decisions);
  }

  private readBrief(slot: string, file: FileStamp): void {
    if (this.briefs.get(slot) === `${file.path}:${file.stamp}`) return;
    this.briefs.set(slot, `${file.path}:${file.stamp}`);
    const text = readText(file.path);
    if (text === null) return;
    const { emit, book, project } = this.options;
    const parsed = parseBrief(text);
    if (!parsed.ok) {
      emit(
        'board.unparsed',
        { file: file.path, line: parsed.line, reason: parsed.reason },
        { source: 'scraped' },
      );
      return;
    }
    const brief = parsed.value;
    const round = `${file.date}/${file.round}`;
    const row = this.decisions
      .get(round)
      ?.dispatching.find((r) => r.Slot === slot);
    const lead = leadOf(row?.Lead);
    const data: SlotDispatchedData = {
      date: file.date,
      round: file.round,
      briefPath: file.path,
      runtime: brief.runtime,
      owns: brief.owns,
      never: brief.never,
      ...(brief.branch ? { branch: brief.branch } : {}),
      ...(brief.worktree
        ? { worktree: resolve(project.root, brief.worktree) }
        : {}),
      ...(brief.model ? { model: brief.model } : {}),
      ...(brief.modelWhy ? { modelWhy: brief.modelWhy } : {}),
      ...(lead !== undefined ? { lead } : {}),
    };
    book.briefs.set(slot, {
      round,
      path: file.path,
      mtimeMs: file.mtimeMs,
      issue: brief.issue,
      branch: brief.branch,
      base: brief.base,
    });
    emit('slot.dispatched', data, {
      slot,
      issue: brief.issue,
      source: 'scraped',
    });
  }
}
