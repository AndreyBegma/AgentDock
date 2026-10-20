import {
  commandArgv,
  FILTER_NONE_COMPOUND,
  FILTER_NONE_MODE,
  FILTER_NONE_UNCOVERED,
  findFilter,
} from './engine';
import { switchedOffFamilies } from './env';
import {
  type PermissionRules,
  permissionFor,
  readRules,
  type SettingsSources,
  settingsFiles,
} from './permissions';
import { programOfLine } from './program';
import {
  isRefusedRead,
  READ_REFUSAL_ID,
  READ_REFUSAL_MESSAGE,
} from './read-refusal';
import {
  type HookCommand,
  parseHookCommand,
  quoteAssignment,
  type Stage,
  shellQuote,
} from './shell';
import { statsTarget, writeStat } from './stats';
import type { Filter } from './types';

/**
 * `nautelle-runner filter-hook` (#445 D3): Claude Code's PreToolUse hook for
 * Bash. It turns `bun run test` into `<runner> filter -- bun run test` when —
 * and only when — the session is in `bypassPermissions` (amendment 9),
 * `auto` (amendment 10) or `plan` (amendment 14), the call is a list of pipelines of simple commands
 * (#610) and a filter covers the first command of at least one pipeline, the
 * call is not in the background, that command is not a dev/watch mode, and
 * the rewrite changes nothing about what the session asks or denies (see
 * `permissions.ts`). Only those first commands are wrapped: the rest of a
 * pipe (`| tail -50`) reads the filtered output, and every other command runs
 * as written. Every other Bash call is left alone and counted
 * `passedThrough`.
 *
 * In bypass mode the rewrite carries `permissionDecision: "allow"`. In auto
 * and plan mode it carries no decision at all: Claude Code's own permission
 * rules (and, in auto, its classifier) judge the wrapped command, so the hook
 * never skips them.
 *
 * It fails open: any error prints nothing and exits 0, which Claude Code
 * reads as "no decision" — the command runs as written.
 */

/** The PreToolUse input fields the hook reads (Claude Code's shape). */
interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
  permission_mode?: unknown;
  cwd?: unknown;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    /** Bypass mode only; in auto and plan mode Claude Code decides (amendments 10, 14). */
    permissionDecision?: 'allow';
    permissionDecisionReason?: string;
    updatedInput: Record<string, unknown>;
  };
}

export interface HookDeps {
  env: Readonly<Record<string, string | undefined>>;
  filters: readonly Filter[];
  /** The argv that starts this runner; `filter -- …` is appended. */
  selfCommand: readonly string[];
  home: string;
  os: string;
  now: () => number;
  random?: () => number;
  /** The permission rules; read from the settings files by default. */
  rules?: (sources: SettingsSources) => PermissionRules | null;
}

const WATCH_FLAGS = /^--(watch|watchAll|watch-all|hot|serve)(=.*)?$/;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx']);
const DEV_SCRIPTS = new Set(['dev', 'start', 'serve', 'watch', 'preview']);

/** A dev server or watch mode, which never ends on its own (amendment 3). */
export const isLongRunning = (
  argv: readonly string[],
  filter: Filter | null,
) => {
  if (argv.some((word) => WATCH_FLAGS.test(word))) return true;
  const [program, first, second] = argv;
  if (program && PACKAGE_MANAGERS.has(program)) {
    const script = first === 'run' || first === 'run-script' ? second : first;
    if (script && DEV_SCRIPTS.has(script)) return true;
  }
  try {
    return filter?.longRunning?.(argv) === true;
  } catch {
    return true;
  }
};

/** #663 D8: the PreToolUse answer that refuses a Bash call. */
export interface HookRefusal {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

export type HookDecision =
  | { rewrite: HookOutput }
  | { refuse: HookRefusal; program?: string }
  | { passThrough: string; filter: string; program?: string };

/** What the hook does with one PreToolUse input. Never throws. */
export const decideHook = (
  raw: unknown,
  deps: HookDeps,
): HookDecision | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const input = raw as HookInput;
  if (input.tool_name !== 'Bash') return null;
  if (typeof input.tool_input !== 'object' || input.tool_input === null) {
    return null;
  }
  const toolInput = input.tool_input as Record<string, unknown>;
  const command = toolInput.command;
  if (typeof command !== 'string') return null;

  // #610: only the first command of each pipeline is ever wrapped, so the
  // filter and the long-running check look at those, past any `cd <path> &&`.
  const parsed = parseHookCommand(command);
  // #663 D8: a whole-file read through Bash goes through `Read`, in any mode.
  // An unparsed line is never refused (fail open); family `tool` switches it off.
  if (isRefusedRead(parsed) && !switchedOffFamilies(deps.env).has('tool')) {
    const program = programOfLine(command, parsed);
    return {
      refuse: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: READ_REFUSAL_MESSAGE,
        },
      },
      ...(program === undefined ? {} : { program }),
    };
  }
  const covered = parsed ? coveredStages(parsed, deps.filters) : [];
  const first = covered[0]?.filter;
  const wrapped = new Set(
    covered
      .filter(
        (c) => !isLongRunning(commandArgv(c.stage.command.argv), c.filter),
      )
      .map((c) => c.stage),
  );
  const mode =
    typeof input.permission_mode === 'string'
      ? input.permission_mode
      : undefined;
  // Amendments 9, 10 and 14: only bypass, auto and plan rewrite; elsewhere,
  // never.
  const rewrites =
    mode === 'bypassPermissions' || mode === 'auto' || mode === 'plan';
  // Amendment 12: a matched filter keeps its id; otherwise the row says why
  // none ran — the mode first, since in it nothing would ever be rewritten.
  const id =
    first?.id ??
    (!rewrites
      ? FILTER_NONE_MODE
      : parsed
        ? FILTER_NONE_UNCOVERED
        : FILTER_NONE_COMPOUND);
  const program = programOfLine(command, parsed);
  const leave = (reason: string): HookDecision => ({
    passThrough: reason,
    filter: id,
    ...(program === undefined ? {} : { program }),
  });

  if (!parsed) return leave('not a simple command');
  if (toolInput.run_in_background === true) return leave('background');
  if (!first) return leave('no filter');
  if (wrapped.size === 0) return leave('long-running');
  if (!rewrites) return leave('not bypassPermissions, auto or plan');

  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const sources: SettingsSources = {
    env: deps.env,
    home: deps.home,
    projectDir: deps.env.CLAUDE_PROJECT_DIR || cwd,
    os: deps.os,
  };
  const rules = (deps.rules ?? ((s) => readRules(settingsFiles(s))))(sources);
  if (!rules) return leave('unreadable settings');
  const verdict = permissionFor(rules, mode, command, parsed);
  if (!verdict.rewrite) return leave(verdict.reason);

  const updatedInput = {
    ...toolInput,
    command: wrappedCommand(parsed, deps.selfCommand, (stage) =>
      wrapped.has(stage),
    ),
  };
  // Amendments 10 and 14: in auto and plan mode no decision, so the rules (and
  // the classifier) judge the wrapped command exactly as any other.
  if (mode === 'auto' || mode === 'plan') {
    return {
      rewrite: {
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
      },
    };
  }
  return {
    rewrite: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          'Nautelle token saver: the output is filtered; NAUTELLE_RAW=1 runs it unfiltered',
        updatedInput,
      },
    },
  };
};

/** The first command of each pipeline that a filter covers, with its filter. */
const coveredStages = (
  parsed: HookCommand,
  filters: readonly Filter[],
): { stage: Stage; filter: Filter }[] =>
  parsed.pipelines.flatMap(([stage]) => {
    const filter = stage ? findFilter(filters, stage.command.argv) : null;
    return stage && filter ? [{ stage, filter }] : [];
  });

/** One stage as bash words, behind `filter --` when it is wrapped. */
const stageWords = (
  stage: Stage,
  selfCommand: readonly string[],
  wrap: boolean,
): string[] => [
  ...stage.command.assignments.map(quoteAssignment),
  ...(wrap ? [...selfCommand.map(shellQuote), 'filter', '--'] : []),
  ...stage.command.argv.map(shellQuote),
  ...(stage.mergeStderr ? ['2>&1'] : []),
];

/**
 * The rewrite, built from the parsed words and re-quoted — never from the
 * original text, so bash runs exactly the argv the parser saw (DR-01).
 *
 * #610: the line keeps its shape — the same pipelines joined by the same
 * operators, each a constant the hook writes. A wrapped stage is still one
 * simple command, so bash groups the line exactly as it grouped the
 * original, and the filter returns its command's exit code, so `&&`, `||`
 * and a pipeline's status come out the same. Only the first stage of a
 * pipeline is ever wrapped (`wrap` picks which; all of them by default), so
 * `| tail -50` reads the filtered output; every other stage is re-quoted and
 * runs as written.
 *
 * Amendment 11: a `2>&1` is kept, as a constant: the filter forwards the
 * child's stdout and stderr separately whenever it does not compress (the
 * bypass, streaming past the buffer, no filter), so dropping it would move
 * stderr on exactly those paths. Kept, the wrapped command has the fd table
 * the original had.
 */
export const wrappedCommand = (
  parsed: HookCommand,
  selfCommand: readonly string[],
  wrap: (stage: Stage) => boolean = () => true,
): string =>
  parsed.pipelines
    .map((pipeline, i) => {
      const text = pipeline
        .map((stage, j) =>
          stageWords(stage, selfCommand, j === 0 && wrap(stage)).join(' '),
        )
        .join(' | ');
      const op = parsed.operators[i];
      return op === undefined ? text : `${text} ${op}`;
    })
    .join(' ');

/**
 * Runs the hook on one stdin payload and returns what to print (empty for
 * "no decision"). A call left alone is counted `passedThrough`, with no bytes
 * — the hook never sees the output.
 */
export const runFilterHook = (stdin: string, deps: HookDeps): string => {
  try {
    const target = statsTarget(deps.env);
    // Without the launch's env, Token saver is not on for this session.
    if (!target) return '';
    const decision = decideHook(JSON.parse(stdin), deps);
    if (!decision) return '';
    if ('rewrite' in decision) return JSON.stringify(decision.rewrite);
    if ('refuse' in decision) {
      writeStat(
        target,
        {
          filter: READ_REFUSAL_ID,
          program: decision.program,
          rawBytes: 0,
          keptBytes: 0,
          bypassed: false,
          passedThrough: false,
        },
        deps.now(),
        deps.random,
      );
      return JSON.stringify(decision.refuse);
    }
    writeStat(
      target,
      {
        filter: decision.filter,
        program: decision.program,
        rawBytes: 0,
        keptBytes: 0,
        bypassed: false,
        passedThrough: true,
      },
      deps.now(),
      deps.random,
    );
    return '';
  } catch {
    return '';
  }
};
