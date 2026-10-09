#!/usr/bin/env bun
import { arch, hostname, platform } from 'node:os';
import { runCli } from './cli';
import { systemClock } from './clock';

/** A compiled binary runs from Bun's embedded filesystem. */
const compiled = Bun.main.startsWith('/$bunfs/');

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

const code = await runCli(process.argv.slice(2), {
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
