import { join } from 'node:path';
import type { DocsClassified } from '@agentdock/shared/protocol';
import type { DirEntry, ProjectFs } from './fs';

type Kind = keyof DocsClassified;

const DIRS: Record<string, Kind> = {
  specs: 'specs',
  prs: 'specs',
  stages: 'specs',
  adr: 'adr',
  decisions: 'adr',
  'bug-reports': 'reports',
  fixes: 'reports',
  verifications: 'reports',
  'feature-plans': 'reports',
};

const FILES: Record<string, Kind> = {
  'decisions.md': 'adr',
  'roadmap.md': 'roadmap',
  'ROADMAP.md': 'roadmap',
  'spec-queue.md': 'roadmap',
};

/** `*adr*`: any entry whose name contains `adr`, in any case. */
const ADR_LIKE = /adr/i;

const kindOf = (entry: DirEntry): Kind | null => {
  if (entry.isDirectory && DIRS[entry.name]) return DIRS[entry.name];
  if (entry.isFile && FILES[entry.name]) return FILES[entry.name];
  if (ADR_LIKE.test(entry.name)) return 'adr';
  return null;
};

/** The nested names D7 knows inside a `docs/` folder of the docs root. */
const nestedKindOf = (entry: DirEntry): Kind | null => {
  if (entry.isDirectory && entry.name === 'specs') return 'specs';
  if (entry.name.startsWith('roadmap')) return 'roadmap';
  return null;
};

/**
 * D7: sorts the docs root's entries into specs, ADRs, roadmap and reports —
 * one level deep, plus `docs/specs` and `docs/roadmap*`. Paths are relative
 * to the docs root. Reads the docs root and its `docs/` folder only.
 */
export const classifyDocs = (
  fs: ProjectFs,
  docsRoot: string,
): DocsClassified => {
  const classified: DocsClassified = {
    specs: [],
    adr: [],
    roadmap: [],
    reports: [],
  };
  for (const entry of fs.readdir(docsRoot)) {
    if (entry.name.startsWith('.')) continue;
    const kind = kindOf(entry);
    if (kind) classified[kind].push(entry.name);
    if (entry.isDirectory && entry.name === 'docs') {
      for (const nested of fs.readdir(join(docsRoot, 'docs'))) {
        const nestedKind = nestedKindOf(nested);
        if (nestedKind) classified[nestedKind].push(`docs/${nested.name}`);
      }
    }
  }
  for (const list of Object.values(classified)) list.sort();
  return classified;
};

export const emptyClassified = (): DocsClassified => ({
  specs: [],
  adr: [],
  roadmap: [],
  reports: [],
});
