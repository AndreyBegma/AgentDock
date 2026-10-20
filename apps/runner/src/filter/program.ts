import { basename } from 'node:path';
import { filterProgramSchema } from '@nautelle/shared';
import type { HookCommand } from './shell';

/**
 * Tools whose second word is a subcommand rather than an argument: `git log`,
 * `bun run`. For any other program the row names the program alone — `ls src`
 * is `ls`, since `src` is an argument.
 */
const SUBCOMMAND_TOOLS = new Set([
  'apt',
  'aws',
  'brew',
  'bun',
  'bunx',
  'cargo',
  'deno',
  'dnf',
  'docker',
  'gcloud',
  'gh',
  'git',
  'go',
  'helm',
  'kubectl',
  'npm',
  'npx',
  'pip',
  'pip3',
  'pnpm',
  'poetry',
  'prisma',
  'systemctl',
  'terraform',
  'turbo',
  'uv',
  'yarn',
]);

const SUBCOMMAND = /^[a-z0-9][a-z0-9_:.-]*$/;

/**
 * #648: the program a command ran, for its stat row — `argv[0]`'s bare name,
 * plus the subcommand of a tool that has them. Never another argument; and
 * `undefined` rather than a value the row schema would refuse, since one bad
 * row would cost the API the whole batch.
 */
export const programOf = (argv: readonly string[]): string | undefined => {
  const [first, second] = argv;
  if (!first) return undefined;
  const name = basename(first);
  const sub =
    second !== undefined &&
    SUBCOMMAND_TOOLS.has(name) &&
    SUBCOMMAND.test(second)
      ? second
      : undefined;
  const withSub = sub ? `${name} ${sub}` : name;
  if (filterProgramSchema.safeParse(withSub).success) return withSub;
  return filterProgramSchema.safeParse(name).success ? name : undefined;
};

/**
 * The program of a hook line: the first pipeline head that is not a `cd`,
 * else the first head. A line that did not parse (`none:compound`) gets its
 * first plain word past any `NAME=value` — still never an argument.
 */
export const programOfLine = (
  command: string,
  parsed: HookCommand | null,
): string | undefined => {
  if (parsed) {
    const heads = parsed.pipelines.flatMap(([stage]) =>
      stage ? [stage.command.argv] : [],
    );
    const head = heads.find((argv) => argv[0] !== 'cd') ?? heads[0];
    return head ? programOf(head) : undefined;
  }
  const words = command.trim().split(/[\s;&|()<>]+/);
  const start = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (start < 0) return undefined;
  return programOf(words.slice(start, start + 2));
};
