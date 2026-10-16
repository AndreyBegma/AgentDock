import { commandArgv, FILTER_NONE, findFilter } from './engine';
import {
  type PermissionRules,
  permissionFor,
  readRules,
  type SettingsSources,
  settingsFiles,
} from './permissions';
import {
  parseSimpleCommand,
  quoteAssignment,
  type SimpleCommand,
  shellQuote,
} from './shell';
import { statsTarget, writeStat } from './stats';
import type { Filter } from './types';

/**
 * `agentdock-runner filter-hook` (#445 D3): Claude Code's PreToolUse hook for
 * Bash. It turns `bun run test` into `<runner> filter -- bun run test` when —
 * and only when — the session is in `bypassPermissions` (amendment 9), the
 * call is a single simple command a filter covers, not a background call or a
 * dev/watch mode, and the rewrite changes nothing about what the session
 * asks or denies (see `permissions.ts`). Every other Bash call is left alone
 * and counted `passedThrough`.
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
    permissionDecision: 'allow';
    permissionDecisionReason: string;
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

export type HookDecision =
  | { rewrite: HookOutput }
  | { passThrough: string; filter: string };

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

  const parsed = parseSimpleCommand(command);
  const argv = parsed ? commandArgv(parsed.argv) : [];
  const filter = parsed ? findFilter(deps.filters, parsed.argv) : null;
  const id = filter?.id ?? FILTER_NONE;
  const leave = (reason: string): HookDecision => ({
    passThrough: reason,
    filter: id,
  });

  if (!parsed) return leave('not a simple command');
  if (toolInput.run_in_background === true) return leave('background');
  if (!filter) return leave('no filter');
  if (isLongRunning(argv, filter)) return leave('long-running');
  const mode =
    typeof input.permission_mode === 'string'
      ? input.permission_mode
      : undefined;
  // Amendment 9: outside bypass mode Claude Code decides, never the hook.
  if (mode !== 'bypassPermissions') return leave('not bypassPermissions');

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

  return {
    rewrite: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          'AgentDock token saver: the output is filtered; AGENTDOCK_RAW=1 runs it unfiltered',
        updatedInput: {
          ...toolInput,
          command: wrappedCommand(parsed, deps.selfCommand),
        },
      },
    },
  };
};

/**
 * The rewrite, built from the parsed words and re-quoted — never from the
 * original text, so bash runs exactly the argv the parser saw (DR-01).
 */
export const wrappedCommand = (
  parsed: SimpleCommand,
  selfCommand: readonly string[],
): string =>
  [
    ...parsed.assignments.map(quoteAssignment),
    ...selfCommand.map(shellQuote),
    'filter',
    '--',
    ...parsed.argv.map(shellQuote),
  ].join(' ');

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
    writeStat(
      target,
      {
        filter: decision.filter,
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
