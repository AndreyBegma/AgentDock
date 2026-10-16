import type { Filter } from '../../types';
import { compressNextBuild, compressPrisma, compressTurbo } from './build';
import { compressBiome, compressPrettier, compressTsc } from './checks';
import { compressInstall, compressOutdated } from './pm';
import { isLongScript, runs, scriptRun, subcommand } from './resolve';
import { compressBunTest, compressJest, compressVitest } from './tests';
import type { Compress } from './util';

/**
 * JS/TS: bun/npm/pnpm/yarn, jest, vitest, bun test, tsc, biome, prettier,
 * next build, prisma, turbo. Filled by slot i445-filters-js.
 *
 * ESLint has no filter on purpose: every line of its report is an error or
 * a warning (or the file name above one), and D4b forbids removing those.
 * Each compressor returns `null` for output it does not recognise.
 */

const WATCH_FLAGS = ['--watch', '--watchAll', '--hot'];
const watching = (args: readonly string[]): boolean =>
  args.some((arg) => WATCH_FLAGS.includes(arg));

interface ToolFilter {
  id: string;
  tool: string;
  compress: Compress;
  /** Subcommands the filter covers; any when absent. */
  subcommands?: readonly string[];
  longRunning?: (args: readonly string[]) => boolean;
}

const toolFilter = ({
  id,
  tool,
  compress,
  subcommands,
  longRunning,
}: ToolFilter): Filter => {
  const covers = (argv: readonly string[]) => {
    const call = runs(argv, tool);
    if (call === null) return null;
    if (subcommands === undefined) return call;
    const sub = subcommand(call.args);
    return sub !== undefined && subcommands.includes(sub) ? call : null;
  };
  return {
    id,
    matches: (argv) => covers(argv) !== null,
    longRunning: (argv) => {
      const call = runs(argv, tool);
      return call !== null && (longRunning?.(call.args) ?? false);
    },
    apply: ({ output }) => compress(output),
  };
};

const vitestWatches = (args: readonly string[]): boolean =>
  !args.includes('run') &&
  !args.includes('--run') &&
  !args.includes('--no-watch') &&
  !args.includes('--watch=false');

const INSTALL_VERBS: Readonly<Record<string, readonly string[]>> = {
  bun: ['install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'up'],
  npm: [
    'install',
    'i',
    'ci',
    'add',
    'uninstall',
    'remove',
    'rm',
    'update',
    'up',
  ],
  pnpm: ['install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'dedupe'],
  yarn: ['install', 'add', 'remove', 'up', 'upgrade', 'dedupe'],
};

const packageManagerVerb = (argv: readonly string[]): string | undefined => {
  const [program, verb] = argv;
  if (program === undefined || INSTALL_VERBS[program] === undefined) {
    return undefined;
  }
  // Bare `yarn` installs.
  return verb === undefined && program === 'yarn' ? 'install' : verb;
};

const installFilter: Filter = {
  id: 'js/install',
  matches: (argv) => {
    const verb = packageManagerVerb(argv);
    const verbs = INSTALL_VERBS[argv[0] ?? ''];
    return verb !== undefined && verbs?.includes(verb) === true;
  },
  longRunning: (argv) => watching(argv),
  apply: ({ output }) => compressInstall(output),
};

const outdatedFilter: Filter = {
  id: 'js/outdated',
  matches: (argv) => packageManagerVerb(argv) === 'outdated',
  apply: ({ output }) => compressOutdated(output),
};

/** Content compressors, tried in turn on the output of a script. */
const SCRIPT_COMPRESSORS: readonly Compress[] = [
  compressBunTest,
  compressJest,
  compressVitest,
  compressTsc,
  compressBiome,
  compressPrettier,
  compressNextBuild,
  compressPrisma,
  compressTurbo,
];

/**
 * `bun run test`, `npm run lint`, `pnpm run build`: the script can run any
 * of the tools above, so the output decides. Every compressor recognises its
 * own tool's output and returns `null` for anything else.
 */
const scriptFilter: Filter = {
  id: 'js/run-script',
  matches: (argv) => scriptRun(argv) !== null,
  longRunning: (argv) => {
    const run = scriptRun(argv);
    return run !== null && (isLongScript(run.script) || watching(run.args));
  },
  apply: ({ output }) => {
    let current = output;
    for (const compress of SCRIPT_COMPRESSORS) {
      current = compress(current) ?? current;
    }
    return current === output ? null : current;
  },
};

export const jsFilters: readonly Filter[] = [
  toolFilter({
    id: 'js/bun-test',
    tool: 'bun-test',
    compress: compressBunTest,
    longRunning: watching,
  }),
  toolFilter({
    id: 'js/jest',
    tool: 'jest',
    compress: compressJest,
    longRunning: watching,
  }),
  toolFilter({
    id: 'js/vitest',
    tool: 'vitest',
    compress: compressVitest,
    longRunning: vitestWatches,
  }),
  toolFilter({
    id: 'js/tsc',
    tool: 'tsc',
    compress: compressTsc,
    longRunning: (args) => args.includes('--watch') || args.includes('-w'),
  }),
  toolFilter({
    id: 'js/biome',
    tool: 'biome',
    compress: compressBiome,
    subcommands: ['check', 'lint', 'format', 'ci'],
    longRunning: watching,
  }),
  toolFilter({
    id: 'js/prettier',
    tool: 'prettier',
    compress: compressPrettier,
    longRunning: watching,
  }),
  toolFilter({
    id: 'js/next-build',
    tool: 'next',
    compress: compressNextBuild,
    subcommands: ['build'],
  }),
  toolFilter({
    id: 'js/prisma',
    tool: 'prisma',
    compress: compressPrisma,
    subcommands: ['generate', 'migrate', 'db'],
  }),
  toolFilter({
    id: 'js/turbo',
    tool: 'turbo',
    compress: compressTurbo,
    longRunning: (args) =>
      watching(args) ||
      args.some((arg) => ['dev', 'start', 'serve', 'watch'].includes(arg)),
  }),
  installFilter,
  outdatedFilter,
  scriptFilter,
];
