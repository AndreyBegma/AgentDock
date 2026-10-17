#!/usr/bin/env bun
import { arch, hostname, platform } from 'node:os';

/** A compiled binary runs from Bun's embedded filesystem. */
const compiled = Bun.main.startsWith('/$bunfs/');

const argv = process.argv.slice(2);

// `filter` and `filter-hook` run on every Bash call of every agent (#445 D3),
// `read-hook` on every Read (#616): they load only their own modules. Everything else is imported lazily below,
// and the build splits chunks, so the daemon's graph is never parsed here.
if (
  argv[0] === 'filter' ||
  argv[0] === 'filter-hook' ||
  argv[0] === 'read-hook'
) {
  const { runFilterCommand } = await import('./filter/main');
  process.exit(await runFilterCommand(argv));
}

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

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
        });
      })();
process.exit(code);
