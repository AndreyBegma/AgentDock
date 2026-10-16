/**
 * Which JS tool a command runs, whatever launches it: `jest`, `npx jest`,
 * `bunx jest`, `pnpm exec jest`, `yarn jest`, `bun x jest`. `bun test` is the
 * tool `bun-test`.
 */

export const TOOLS: ReadonlySet<string> = new Set([
  'jest',
  'vitest',
  'tsc',
  'biome',
  'eslint',
  'prettier',
  'next',
  'prisma',
  'turbo',
]);

export interface Invocation {
  tool: string;
  args: readonly string[];
}

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  'bun',
  'npm',
  'pnpm',
  'yarn',
]);

/** The tool after a launcher's own flags: `npx -y jest …`. */
const launched = (rest: readonly string[]): Invocation | null => {
  let i = 0;
  while (i < rest.length && (rest[i] ?? '').startsWith('-')) i++;
  const tool = rest[i];
  if (tool === undefined || !TOOLS.has(tool)) return null;
  return { tool, args: rest.slice(i + 1) };
};

export const invocation = (argv: readonly string[]): Invocation | null => {
  const [program, first, ...others] = argv;
  if (program === undefined) return null;
  const rest = first === undefined ? [] : [first, ...others];
  if (program === 'npx' || program === 'bunx') return launched(rest);
  if (program === 'bun' && first === 'x') return launched(others);
  if (program === 'bun' && first === 'test') {
    return { tool: 'bun-test', args: others };
  }
  if (
    (program === 'npm' || program === 'pnpm' || program === 'yarn') &&
    (first === 'exec' || first === 'dlx')
  ) {
    return launched(others);
  }
  if (
    PACKAGE_MANAGERS.has(program) &&
    first !== undefined &&
    TOOLS.has(first)
  ) {
    return { tool: first, args: others };
  }
  if (TOOLS.has(program)) return { tool: program, args: rest };
  return null;
};

/** The invocation, when it is `tool` (or one of `tools`). */
export const runs = (
  argv: readonly string[],
  ...tools: string[]
): Invocation | null => {
  const found = invocation(argv);
  return found !== null && tools.includes(found.tool) ? found : null;
};

/** The first argument that is not a flag. */
export const subcommand = (args: readonly string[]): string | undefined =>
  args.find((arg) => !arg.startsWith('-'));

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--cwd',
  '--filter',
  '-F',
  '--workspace',
  '--prefix',
  '--dir',
  '-C',
]);

/**
 * The script a package manager is asked to run, or `null` when the command
 * is not a script run: `bun run test`, `npm run build`, `npm test`,
 * `bun run --cwd apps/api test`, `pnpm run lint`.
 */
export const scriptRun = (
  argv: readonly string[],
): { script: string; args: readonly string[] } | null => {
  const [program, ...rest] = argv;
  if (program === undefined || !PACKAGE_MANAGERS.has(program)) return null;
  let i = 0;
  while (i < rest.length && (rest[i] ?? '').startsWith('-')) {
    i += VALUE_FLAGS.has(rest[i] ?? '') ? 2 : 1;
  }
  const verb = rest[i];
  if (verb === undefined) return null;
  if (
    verb === 'test' ||
    (program === 'npm' && (verb === 't' || verb === 'tst'))
  ) {
    return { script: 'test', args: rest.slice(i + 1) };
  }
  if (verb !== 'run' && verb !== 'run-script') return null;
  i++;
  while (i < rest.length && (rest[i] ?? '').startsWith('-')) {
    i += VALUE_FLAGS.has(rest[i] ?? '') ? 2 : 1;
  }
  const script = rest[i];
  if (script === undefined) return null;
  return { script, args: rest.slice(i + 1) };
};

/** A script name that starts a server or a watcher. */
export const isLongScript = (script: string): boolean =>
  /(^|[:_-])(dev|watch|serve|start|preview|studio)([:_-]|$)/.test(script);
