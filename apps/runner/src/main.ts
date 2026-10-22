#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { arch, hostname, platform } from 'node:os';

/** A compiled binary runs from Bun's embedded filesystem. */
const compiled = Bun.main.startsWith('/$bunfs/');

const argv = process.argv.slice(2);

// ADR-0073: the `AGENTDOCK_*` variables count as their `NAUTELLE_*` names,
// the filter's hot path included. Lightweight: no daemon imports.
const { adoptLegacyEnv, migrateLegacyDirs } = await import('./legacy');
const legacyEnv = adoptLegacyEnv(process.env);

// `filter` and `filter-hook` run on every Bash call of every agent (#445 D3),
// `read-hook` on every Read (#616), `tool-hook` after every cut MCP, Grep or
// WebFetch call (#747): they load only their own modules. Everything else is
// imported lazily below, and the build splits chunks, so the daemon's graph
// is never parsed here.
if (
  argv[0] === 'filter' ||
  argv[0] === 'filter-hook' ||
  argv[0] === 'read-hook' ||
  argv[0] === 'tool-hook'
) {
  const { runFilterCommand } = await import('./filter/main');
  process.exit(await runFilterCommand(argv));
}

/** Commands that read no runner directory, so they migrate none (ADR-0073). */
const PATHLESS_COMMANDS = new Set([
  'version',
  '--version',
  '-v',
  'help',
  '--help',
  '-h',
  'register',
]);

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

// C-327: a person's command checks npm for a newer runner while it runs, and
// asks after it finished; every other start makes no request.
const update = await (async () => {
  const [
    { startUpdateCheck, askOnTerminal },
    { createExec },
    { resolvePaths },
    { RUNNER_VERSION },
  ] = await Promise.all([
    import('./update'),
    import('./detect/exec'),
    import('./env'),
    import('./version'),
  ]);
  return startUpdateCheck({
    command: argv[0],
    env: process.env,
    os: platform(),
    arch: arch(),
    current: RUNNER_VERSION,
    binary: compiled ? process.execPath : null,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    fetch,
    ask: askOnTerminal((text) => process.stderr.write(text)),
    install: async (args) =>
      Bun.spawn([...args], { stdio: ['inherit', 'inherit', 'inherit'] }).exited,
    exec: createExec(process.env),
    exists: existsSync,
    stderr: (text) => process.stderr.write(text),
    paths: resolvePaths(process.env),
    uid: process.getuid?.() ?? 0,
  });
})();

// `exec-run <runDir>` is what a skill run's tmux session executes (spec 24
// D7); it is internal, so it is not one of the CLI's documented commands.
const code =
  argv[0] === 'exec-run'
    ? await (await import('./skills/run/exec-run')).execRun(argv.slice(1), {
        env: process.env,
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        now: () => new Date(),
      })
    : await (async () => {
        const [{ runCli }, { systemClock }] = await Promise.all([
          import('./cli'),
          import('./clock'),
        ]);
        return runCli(argv, {
          env: process.env,
          host: { hostname: hostname(), os: platform(), arch: arch() },
          clock: systemClock,
          fetch,
          stdout: (text) => process.stdout.write(text),
          stderr: (text) => process.stderr.write(text),
          execStart: compiled
            ? [process.execPath, 'run']
            : [process.execPath, Bun.main, 'run'],
          signal: controller.signal,
          // ADR-0073: the `agentdock` directories move before any command
          // reads them; the commands that read none leave them alone.
          legacy: {
            env: legacyEnv,
            ...(PATHLESS_COMMANDS.has(argv[0] ?? '')
              ? { moved: [], both: [], failed: [] }
              : migrateLegacyDirs(process.env, platform())),
          },
        });
      })();
// Ctrl-C at the question ends the process again, as it would without one.
if (update && !controller.signal.aborted) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.removeAllListeners(signal);
  }
  await update.offer();
}
process.exit(code);
