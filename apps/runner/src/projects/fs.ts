import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/**
 * Every disk read project inspection makes goes through this port, so a test
 * can wrap it and assert which paths were touched (D8). Each method answers
 * `null` / `[]` for a path that cannot be read, never throws.
 */
export interface ProjectFs {
  /** Follows symlinks. */
  stat(path: string): { isDirectory: boolean; isFile: boolean } | null;
  /** Does not follow symlinks. */
  isSymbolicLink(path: string): boolean;
  realpath(path: string): string | null;
  readdir(path: string): DirEntry[];
  readFile(path: string): string | null;
}

const orNull = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

export const nodeFs: ProjectFs = {
  stat: (path) =>
    orNull(() => {
      const s = statSync(path);
      return { isDirectory: s.isDirectory(), isFile: s.isFile() };
    }),
  isSymbolicLink: (path) =>
    orNull(() => lstatSync(path).isSymbolicLink()) ?? false,
  realpath: (path) => orNull(() => realpathSync(path)),
  readdir: (path) =>
    orNull(() =>
      readdirSync(path, { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymbolicLink: d.isSymbolicLink(),
      })),
    ) ?? [],
  readFile: (path) => orNull(() => readFileSync(path, 'utf8')),
};

export const isDirectory = (fs: ProjectFs, path: string): boolean =>
  fs.stat(path)?.isDirectory === true;

export const isFile = (fs: ProjectFs, path: string): boolean =>
  fs.stat(path)?.isFile === true;
