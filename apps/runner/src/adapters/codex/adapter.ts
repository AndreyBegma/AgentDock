import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  EVENT_SCHEMA_VERSION,
  SESSION_OBSERVED_EVENT,
  type SessionObservedData,
} from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../../config';
import { codexHome } from '../../detect/profiles';
import { correlateCwd } from '../correlate';
import type {
  FileState,
  RuntimeAdapter,
  TailChunk,
  TranscriptSource,
} from '../types';

const JSONL = '.jsonl';

const sessionsDir = (profile: ConfigProfile, home: string): string =>
  join(codexHome(profile, home), 'sessions');

/** Every `*.jsonl` below `dir`, depth-first; unreadable directories are skipped. */
const walk = (dir: string, found: string[] = []): string[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    const path = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(path, found);
    else if (stat.isFile() && name.endsWith(JSONL)) found.push(path);
  }
  return found;
};

/**
 * Codex (D7). The transcript format is not known yet — Codex is not installed
 * on the reference machine — so nothing is parsed: each file under
 * `<CODEX_HOME>/sessions/` is reported once as a session with
 * `parsed: false`. Its `cwd` is the file's own directory, which is honest
 * (no line was read) and keeps it out of every project, so it is admin-only
 * (D10). The fixture tests in `codex/` are skipped until a real one exists.
 */
export const codexAdapter: RuntimeAdapter = {
  runtime: 'codex',
  version: '0',

  roots: (profile, home) => [sessionsDir(profile, home)],

  discover: (profile, home) =>
    walk(sessionsDir(profile, home)).flatMap((path): TranscriptSource[] => {
      try {
        const { size, mtimeMs } = statSync(path);
        return [
          {
            runtime: 'codex',
            profileKey: profile.id,
            path,
            sessionId: basename(path, JSONL).slice(0, 200),
            size,
            mtimeMs,
          },
        ];
      } catch {
        return [];
      }
    }),

  async *tail(source: TranscriptSource, state: FileState, options) {
    if (state.observed) {
      if (state.offset !== source.size) {
        yield { events: [], state: { ...state, offset: source.size } };
      }
      return;
    }
    const cwd = dirname(source.path);
    const { projectId, slot } = correlateCwd(cwd, options.projects);
    const startedAt = new Date(source.mtimeMs).toISOString();
    const observed: SessionObservedData = {
      profileKey: source.profileKey,
      cwd,
      startedAt,
      parsed: false,
      ...(projectId ? { projectId } : {}),
      ...(slot ? { slot } : {}),
    };
    const chunk: TailChunk = {
      events: [
        {
          v: EVENT_SCHEMA_VERSION,
          ts: startedAt,
          type: SESSION_OBSERVED_EVENT,
          source: 'transcript',
          session: { runtime: 'codex', id: source.sessionId },
          data: observed,
        },
      ],
      state: { offset: source.size, observed, parser: null },
    };
    yield chunk;
  },

  correlate: (meta, projects) => correlateCwd(meta.cwd, projects),
};
