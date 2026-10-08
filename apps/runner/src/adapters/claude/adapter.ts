import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ConfigProfile } from '../../config';
import { claudeConfigDir } from '../../detect/profiles';
import { correlateCwd } from '../correlate';
import { readLines } from '../lines';
import type {
  FileState,
  RuntimeAdapter,
  TailChunk,
  TailOptions,
  TranscriptSource,
} from '../types';
import { parseClaudeLines, readParserState } from './parse';

const JSONL = '.jsonl';
const AGENT_PREFIX = 'agent-';

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const fileStat = (path: string): { size: number; mtimeMs: number } | null => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * `agent-<id>.meta.json` next to a subagent transcript: the tool call that
 * spawned it and the agent type. Its other fields (the task description) are
 * not read.
 */
const readAgentMeta = (
  path: string,
): { toolUseId?: string; agentName?: string } => {
  try {
    const meta: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof meta !== 'object' || meta === null) return {};
    const { toolUseId, agentType } = meta as Record<string, unknown>;
    return {
      ...(typeof toolUseId === 'string' && toolUseId
        ? { toolUseId: toolUseId.slice(0, 200) }
        : {}),
      ...(typeof agentType === 'string' && agentType
        ? { agentName: agentType.slice(0, 200) }
        : {}),
    };
  } catch {
    return {};
  }
};

const projectsDir = (profile: ConfigProfile, home: string): string =>
  join(claudeConfigDir(profile, home), 'projects');

/**
 * Claude Code (D2, D3). Transcripts live at
 * `<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<sessionId>.jsonl`; a session's
 * subagents at `<…>/<sessionId>/subagents/agent-<agentId>.jsonl`. The
 * directory name is not decoded: `cwd` is read from the lines.
 */
export const claudeAdapter: RuntimeAdapter = {
  runtime: 'claude',
  version: '1',

  roots: (profile, home) => [projectsDir(profile, home)],

  discover: (profile, home) => {
    const sources: TranscriptSource[] = [];
    const root = projectsDir(profile, home);
    for (const project of list(root)) {
      const dir = join(root, project);
      for (const name of list(dir)) {
        const path = join(dir, name);
        if (name.endsWith(JSONL)) {
          const stat = fileStat(path);
          if (!stat) continue;
          sources.push({
            runtime: 'claude',
            profileKey: profile.id,
            path,
            sessionId: basename(name, JSONL),
            ...stat,
          });
          continue;
        }
        const subagents = join(path, 'subagents');
        if (!isDirectory(subagents)) continue;
        for (const file of list(subagents)) {
          if (!file.startsWith(AGENT_PREFIX) || !file.endsWith(JSONL)) continue;
          const stat = fileStat(join(subagents, file));
          if (!stat) continue;
          const stem = basename(file, JSONL);
          sources.push({
            runtime: 'claude',
            profileKey: profile.id,
            path: join(subagents, file),
            // Equals `toolUseResult.agentId` on the spawning tool call.
            sessionId: stem.slice(AGENT_PREFIX.length),
            parent: {
              sessionId: name,
              ...readAgentMeta(join(subagents, `${stem}.meta.json`)),
            },
            ...stat,
          });
        }
      }
    }
    return sources;
  },

  async *tail(
    source: TranscriptSource,
    state: FileState,
    options: TailOptions,
  ): AsyncIterable<TailChunk> {
    let observed = state.observed;
    let parser = readParserState(state.parser);
    for await (const batch of readLines(source.path, state.offset)) {
      const parsed = parseClaudeLines(
        batch.lines,
        { observed, parser },
        { source, projects: options.projects },
      );
      observed = parsed.observed;
      parser = parsed.parser;
      yield {
        events: parsed.events,
        state: { offset: batch.nextOffset, observed, parser },
      };
    }
  },

  correlate: (meta, projects) => correlateCwd(meta.cwd, projects),
};
