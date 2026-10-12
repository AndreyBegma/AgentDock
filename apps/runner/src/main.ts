#!/usr/bin/env bun
import { arch, hostname, platform } from 'node:os';
import { runCli } from './cli';
import { systemClock } from './clock';
import { execRun } from './skills/run/exec-run';

/** A compiled binary runs from Bun's embedded filesystem. */
const compiled = Bun.main.startsWith('/$bunfs/');

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

const argv = process.argv.slice(2);

// `exec-run <runDir>` is what a skill run's tmux session executes (spec 24
// D7); it is internal, so it is not one of the CLI's documented commands.
const code =
  argv[0] === 'exec-run'
    ? await execRun(argv.slice(1), {
        env: process.env,
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        now: () => new Date(),
      })
    : await runCli(argv, {
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
process.exit(code);
