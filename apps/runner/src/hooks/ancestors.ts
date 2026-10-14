import { readFileSync } from 'node:fs';
import type { Exec } from '../detect/exec';
import type { Ancestor } from '../local/types';

/** Far enough to cross a shell or two between `claude` and the hook (D10). */
export const ANCESTOR_DEPTH = 8;

/** `/proc/<pid>/stat`: `pid (comm) state ppid …`; comm may hold spaces and parens. */
export const parseProcStat = (
  text: string,
): { comm: string; ppid: number } | null => {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  if (!Number.isInteger(ppid)) return null;
  return { comm: text.slice(open + 1, close), ppid };
};

export interface AncestorDeps {
  os: string;
  exec: Exec;
  readFile?: (path: string) => string;
}

const linuxStep = (
  pid: number,
  readFile: (path: string) => string,
): { comm: string; ppid: number } | null => {
  try {
    return parseProcStat(readFile(`/proc/${pid}/stat`));
  } catch {
    return null;
  }
};

/** `ps -o ppid=,comm= -p <pid>` on macOS: `  123 /path/to/claude`. */
const psStep = async (
  pid: number,
  exec: Exec,
): Promise<{ comm: string; ppid: number } | null> => {
  const result = await exec('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
    timeoutMs: 500,
  });
  if (!result || result.code !== 0) return null;
  const match = /^\s*(\d+)\s+(.+?)\s*$/m.exec(result.stdout);
  return match ? { ppid: Number(match[1]), comm: match[2] } : null;
};

/**
 * The hook's ancestors, nearest first, starting at its parent (D10). Claude
 * Code may run the hook command through a shell [Unknown], so the walk goes
 * on past it; the daemon picks the nearest `claude`. Best-effort: a step that
 * cannot be read ends the walk.
 */
export const readAncestors = async (
  ppid: number,
  deps: AncestorDeps,
): Promise<Ancestor[]> => {
  const readFile = deps.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const out: Ancestor[] = [];
  let pid = ppid;
  for (let depth = 0; depth < ANCESTOR_DEPTH && pid > 1; depth++) {
    const step =
      deps.os === 'darwin'
        ? await psStep(pid, deps.exec)
        : linuxStep(pid, readFile);
    if (!step) break;
    out.push({ pid, comm: step.comm.slice(0, 4096) });
    pid = step.ppid;
  }
  return out;
};
