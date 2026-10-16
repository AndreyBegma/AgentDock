import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { type FilterStatRow, filterStatRowSchema } from '@agentdock/shared';
import { FILTER_STATS_FILE } from './env';

/**
 * Sessions the runner did not launch (#475): the code-sentinel plugin's
 * `/cs-eco` runs `filter-hook` in manual terminals, the orchestrator's own
 * session and fleet workers, and keeps one directory per Claude session:
 * `${XDG_STATE_HOME:-~/.local/state}/cs-eco/sessions/<session id>/`, its
 * `filter-stats.jsonl` in the runner's line shape. The daemon sends the rows
 * of a session whose cwd is inside a watched project as `runKind: manual`.
 */

/** A session directory's name: Claude's session id, as `/cs-eco` keeps it. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** How much of a transcript is searched for the session's cwd. */
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;
/** How long a session without a transcript waits before it is looked up again. */
export const TRANSCRIPT_RETRY_MS = 60_000;

/** `/cs-eco`'s sessions directory for this environment. */
export const ecoSessionsDir = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string =>
  join(
    env.XDG_STATE_HOME?.startsWith('/')
      ? env.XDG_STATE_HOME
      : join(home, '.local', 'state'),
    'cs-eco',
    'sessions',
  );

export interface EcoSessionFile {
  sessionId: string;
  file: string;
}

/** Every session's stats file under `dir`; a missing `dir` has none. */
export const findEcoStatsFiles = (dir: string): EcoSessionFile[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => SESSION_ID.test(name))
    .map((sessionId) => ({
      sessionId,
      file: join(dir, sessionId, FILTER_STATS_FILE),
    }))
    .filter((s) => existsSync(s.file));
};

/** The watched project a session's rows are counted for. */
export interface EcoSession {
  sessionId: string;
  /** The watched project's id, from the root the session's cwd is in. */
  projectId: string;
  /** Its repository as `owner/name`, when known. */
  repo: string | null;
  root: string;
}

/**
 * The names a `/cs-eco` row may give its project: the plugin writes the
 * origin's `owner/name`, or the directory's name when there is no remote.
 */
const namesOf = (session: EcoSession): Set<string> =>
  new Set(
    [session.projectId, session.repo, basename(session.root)]
      .filter((n): n is string => !!n)
      .map((n) => n.toLowerCase()),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The valid rows of one session, as `manual` rows without a run. The project
 * is the watched root's, never the row's (DA-04/DR-05): a row naming another
 * project, or another session's run, is counted as rejected and never sent.
 * The row's own `runKind` is not trusted either — the plugin writes `skill`
 * until it knows `manual`.
 */
export const parseEcoLines = (
  lines: readonly string[],
  session: EcoSession,
): { rows: FilterStatRow[]; rejected: number } => {
  const names = namesOf(session);
  const rows: FilterStatRow[] = [];
  let rejected = 0;
  for (const line of lines) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      rejected++;
      continue;
    }
    if (
      !isRecord(json) ||
      typeof json.projectId !== 'string' ||
      !names.has(json.projectId.toLowerCase()) ||
      !isRecord(json.row) ||
      (json.row.runId !== null && json.row.runId !== session.sessionId)
    ) {
      rejected++;
      continue;
    }
    const parsed = filterStatRowSchema.safeParse({
      ...json.row,
      runId: null,
      runKind: 'manual',
    });
    if (!parsed.success) {
      rejected++;
      continue;
    }
    rows.push(parsed.data);
  }
  return { rows, rejected };
};

/** The first absolute `cwd` among a transcript's first lines. */
export const readTranscriptCwd = (path: string): string | undefined => {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, TRANSCRIPT_HEAD_BYTES, 0);
    for (const line of buffer.subarray(0, read).toString('utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd: unknown = JSON.parse(line).cwd;
        if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd;
      } catch {
        // A partial last line, or not JSON: try the next.
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
};

/**
 * A Claude session's cwd from its transcript,
 * `<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<session id>.jsonl`, in any of
 * the given `projects` directories. A session's start cwd does not change, so
 * a found one is kept; a missing one is looked up again after a while.
 */
export class TranscriptCwds {
  private readonly found = new Map<string, string>();
  private readonly missed = new Map<string, number>();

  constructor(
    private readonly options: {
      dirs: () => readonly string[];
      now: () => number;
      retryMs?: number;
    },
  ) {}

  cwdOf(sessionId: string): string | undefined {
    if (!SESSION_ID.test(sessionId)) return undefined;
    const known = this.found.get(sessionId);
    if (known) return known;
    const missedAt = this.missed.get(sessionId);
    const now = this.options.now();
    if (
      missedAt !== undefined &&
      now - missedAt < (this.options.retryMs ?? TRANSCRIPT_RETRY_MS)
    ) {
      return undefined;
    }
    const cwd = this.lookUp(sessionId);
    if (cwd) {
      this.found.set(sessionId, cwd);
      this.missed.delete(sessionId);
    } else {
      this.missed.set(sessionId, now);
    }
    return cwd;
  }

  private lookUp(sessionId: string): string | undefined {
    for (const root of new Set(this.options.dirs())) {
      let projects: string[];
      try {
        projects = readdirSync(root);
      } catch {
        continue;
      }
      for (const project of projects) {
        const path = join(root, project, `${sessionId}.jsonl`);
        if (!existsSync(path)) continue;
        const cwd = readTranscriptCwd(path);
        if (cwd) return cwd;
      }
    }
    return undefined;
  }
}
