/**
 * Checks every relative link in a Markdown file (default: README.md): the
 * target exists, and a `#fragment` names a heading of the target Markdown file.
 *
 *   bun scripts/check-readme-links.ts [file.md ...]
 *
 * Exits 1 and lists the broken links when any link does not resolve.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

/** Text outside fenced code blocks and inline code spans. */
const prose = (markdown: string): string =>
  markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes. */
const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const anchors = (file: string): Set<string> => {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(match[1].replace(/`/g, ''));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
};

const isExternal = (target: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(target);

const check = (file: string): string[] => {
  const broken: string[] = [];
  const text = prose(readFileSync(file, 'utf8'));
  const targets = [
    ...[...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
      (m) => m[1],
    ),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]),
  ];
  for (const target of targets) {
    if (isExternal(target)) continue;
    const [path, fragment] = target.split('#', 2);
    const resolved = path ? resolve(dirname(file), path) : file;
    if (!existsSync(resolved)) {
      broken.push(`${target} — no such file`);
      continue;
    }
    if (fragment === undefined) continue;
    const markdownFile = statSync(resolved).isDirectory()
      ? join(resolved, 'README.md')
      : resolved;
    if (!markdownFile.endsWith('.md') || !existsSync(markdownFile)) {
      broken.push(`${target} — fragment on a non-Markdown target`);
      continue;
    }
    if (!anchors(markdownFile).has(decodeURIComponent(fragment))) {
      broken.push(`${target} — no heading #${fragment}`);
    }
  }
  return broken;
};

const files = process.argv.slice(2);
let failed = false;
for (const file of files.length > 0 ? files : ['README.md']) {
  const path = resolve(root, file);
  const broken = check(path);
  const name = relative(root, path);
  if (broken.length === 0) {
    console.log(`${name}: every relative link resolves`);
    continue;
  }
  failed = true;
  for (const line of broken) console.error(`${name}: ${line}`);
}
process.exit(failed ? 1 : 0);
