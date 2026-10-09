import type { SlotRuntime } from '@agentdock/shared/protocol';
import { fail, type Parsed } from './parse-board';

/** What a brief `round-<HHMM>-<slot>.md` says about its slot (D4). */
export interface Brief {
  slot: string;
  issue?: number;
  branch?: string;
  base?: string;
  worktree?: string;
  runtime: SlotRuntime;
  model?: string;
  /** The reason after the model on the `Model:` line. */
  modelWhy?: string;
  owns: string[];
  never: string[];
}

/** `Model: opus — the one line of why` — em dash, en dash or a spaced hyphen. */
const MODEL_LINE = /^(\S+)(?:\s+[—–-]\s+(.+))?$/;

/** A field line before the first section: `Key: value`. */
const FIELD = /^([A-Z][A-Za-z ]*):\s*(.*)$/;

const GLOB_ITEM = /^\s*[-*]\s+`?([^`]+?)`?\s*$/;

/**
 * Parses a brief as orchestrator Phase 6 writes it: the `# Brief — <slot>`
 * title, the field lines (`Issue`, `Branch`, `Base`, `Worktree`, `Model`,
 * `Runtime` when a Codex slot names it), and the `owns:` / `never:` glob lists.
 */
export const parseBrief = (text: string): Parsed<Brief> => {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim().length > 0);
  const title =
    first === -1 ? null : /^#\s+Brief\s+[—–-]\s+(\S+)\s*$/.exec(lines[first]);
  if (!title) return fail('no "# Brief — <slot>" title', first + 1 || 1);

  const brief: Brief = {
    slot: title[1],
    runtime: 'claude',
    owns: [],
    never: [],
  };
  let i = first + 1;
  for (; i < lines.length && !lines[i].startsWith('## '); i++) {
    const field = FIELD.exec(lines[i].trim());
    if (!field) continue;
    const [, key, value] = field;
    switch (key.toLowerCase()) {
      case 'issue': {
        const n = /#(\d+)/.exec(value);
        if (n && Number(n[1]) > 0) brief.issue = Number(n[1]);
        break;
      }
      case 'branch':
        if (value) brief.branch = value.split(/\s/)[0];
        break;
      case 'base':
        if (value) brief.base = value.split(/\s/)[0];
        break;
      case 'worktree':
        if (value) brief.worktree = value.split(/\s/)[0];
        break;
      case 'runtime':
        if (/^codex\b/i.test(value)) brief.runtime = 'codex';
        break;
      case 'model': {
        const model = MODEL_LINE.exec(value.trim());
        if (!model) return fail('the Model line names no model', i + 1);
        brief.model = model[1];
        if (model[2]) brief.modelWhy = model[2].trim();
        break;
      }
    }
  }

  let list: 'owns' | 'never' | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const opener = /^\s*(owns|never)\s*:\s*$/i.exec(line);
    if (opener) {
      list = opener[1].toLowerCase() as 'owns' | 'never';
      continue;
    }
    if (!list) continue;
    const item = GLOB_ITEM.exec(line);
    if (item) brief[list].push(item[1].trim());
    else if (line.trim().length > 0) list = null;
  }
  return { ok: true, value: brief };
};
