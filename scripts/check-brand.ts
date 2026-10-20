/**
 * Checks that no user-visible "AgentDock" is left after the rename to
 * Nautelle (C-295, ADR-0072):
 *
 *   bun scripts/check-brand.ts         the API's and the shared package's
 *                                      sources — every Telegram, email and
 *                                      GitHub text the API sends is there;
 *   bun scripts/check-brand.ts --web   the built web app (`next build` first):
 *                                      what reaches a browser — the client
 *                                      chunks and the prerendered pages.
 *
 * Allowed: the legacy `X-AgentDock-*` webhook headers and `AgentDock-Card`
 * pull request marker, still accepted until runner 0.16.0 (ADR-0073), and the
 * repository URLs and file paths the infrastructure card renames. Exits 1 and
 * lists the hits when there are any.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

/** An occurrence that is a name, not the brand: legacy, or a later card's. */
const ALLOWED = [
  /X-AgentDock-[A-Za-z]+/g,
  /AgentDock-Card/g,
  /[\w.-]*\/AgentDock\b/g,
  /\.wt-AgentDock\b/g,
];

/**
 * The brand left in `text`, one entry per line that still says it, with the
 * text around the first hit (a built chunk is one long line).
 */
export const findOldBrand = (text: string): { line: number; text: string }[] =>
  text.split('\n').flatMap((line, index) => {
    const stripped = ALLOWED.reduce((rest, re) => rest.replace(re, ''), line);
    const at = stripped.indexOf('AgentDock');
    return at === -1
      ? []
      : [
          {
            line: index + 1,
            text: stripped.slice(Math.max(0, at - 60), at + 80).trim(),
          },
        ];
  });

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'cache']);

const walk = (dir: string, keep: (name: string) => boolean): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          return SKIPPED_DIRS.has(entry.name) ? [] : walk(path, keep);
        }
        return keep(entry.name) ? [path] : [];
      })
    : [];

const isSource = (name: string) =>
  /\.(ts|md)$/.test(name) && !/\.spec\.ts$/.test(name);

/** The built output a browser receives: client chunks and prerendered pages. */
const isServed = (name: string) => /\.(js|html|rsc|body|json)$/.test(name);

const sourceFiles = () => [
  ...walk(join(root, 'apps/api/src'), isSource),
  ...walk(join(root, 'packages/shared/src'), isSource),
];

const webFiles = () => {
  const next = join(root, 'apps/web/.next');
  if (!existsSync(next)) {
    console.error('apps/web/.next is missing: run `next build` first.');
    process.exit(1);
  }
  return [
    ...walk(join(next, 'static'), isServed),
    ...walk(join(next, 'server/app'), (name) =>
      /\.(html|rsc|body)$/.test(name),
    ),
  ];
};

if (import.meta.main) {
  const files = process.argv.includes('--web') ? webFiles() : sourceFiles();
  const hits = files.flatMap((file) =>
    findOldBrand(readFileSync(file, 'utf8')).map(
      (hit) => `${relative(root, file)}:${hit.line}: ${hit.text}`,
    ),
  );
  if (hits.length > 0) {
    console.error(`"AgentDock" is still user-visible (C-295):\n`);
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
}
