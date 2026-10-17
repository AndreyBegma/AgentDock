import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilterStatRow } from '@agentdock/shared';
import type { UnsequencedEvent } from '@agentdock/shared/protocol';
import { tokenSaverLaunch } from '../launch/token-saver';
import { createLogger } from '../log';
import { tempDir } from '../testing/fixtures';
import { runFilter } from './engine';
import { type HookOutput, runFilterHook } from './hook';
import { FilterStatsReader } from './stats-reader';
import { demoFilter, tapOutput } from './testing';

/**
 * DR-02: what a launch puts in its session's env is what `filter-hook` and
 * `filter` read, and what they write is what the daemon's reader sends —
 * driven end to end through the real entries, with no env written by hand.
 */
describe('Token saver, launch to stats row (#445 DR-02)', () => {
  let home = '';
  let cleanup = () => {};

  beforeEach(() => {
    ({ dir: home, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it('rewrites, filters and reports a row for the launch’s project and run', async () => {
    const runDir = join(home, 'cards', 'card_1', 'rounds', 'run_1');
    mkdirSync(runDir, { recursive: true });
    const launch = tokenSaverLaunch({
      config: { enabled: true, mcpAllow: [] },
      profile: { id: 'p', runtime: 'claude', env: {}, args: [] },
      home,
      dir: runDir,
      selfCommand: ['/opt/agentdock-runner'],
      runKind: 'card',
      projectId: 'prj_a',
      runId: 'run_1',
      agentdock: false,
      scout: false,
    });
    if (!launch) throw new Error('expected a launch');
    const env = { PATH: process.env.PATH, ...launch.env };

    // The hook, as Claude Code calls it in that session.
    const out = runFilterHook(
      JSON.stringify({
        tool_name: 'Bash',
        permission_mode: 'bypassPermissions',
        cwd: home,
        tool_input: { command: 'demo-test --all' },
      }),
      {
        env,
        filters: [demoFilter],
        selfCommand: ['/opt/agentdock-runner'],
        home,
        os: 'linux',
        now: Date.now,
        rules: () => ({ allow: [], deny: [], ask: [] }),
      },
    );
    expect(
      (JSON.parse(out) as HookOutput).hookSpecificOutput.updatedInput.command,
    ).toBe('/opt/agentdock-runner filter -- demo-test --all');

    // The filter, as the rewritten command runs it.
    const fixture = join(home, 'demo.sh');
    writeFileSync(join(home, 'out.txt'), tapOutput(100, ['not ok 101 - x']));
    writeFileSync(fixture, `#!/bin/sh\ncat "${join(home, 'out.txt')}"\n`);
    chmodSync(fixture, 0o755);
    const printed: string[] = [];
    const code = await runFilter([fixture], {
      env,
      filters: [demoFilter],
      stdout: (b) => {
        printed.push(typeof b === 'string' ? b : new TextDecoder().decode(b));
      },
      stderr: () => {},
      now: Date.now,
      onSignal: () => () => {},
    });
    expect(code).toBe(0);
    expect(printed.join('')).toContain('[agentdock filter:');

    // The daemon's reader, over the card root.
    const events: UnsequencedEvent[] = [];
    const reader = new FilterStatsReader({
      roots: () => [join(home, 'cards')],
      resolve: async (ids) =>
        new Map(ids.map((id) => [id, { repo: `acme/${id}`, root: home }])),
      emit: (event) => events.push(event),
      log: createLogger({
        level: 'error',
        write: () => {},
        now: () => new Date(0),
      }),
      now: () => new Date(),
    });
    await reader.poll();
    expect(events).toHaveLength(1);
    expect(events[0]?.project?.repo).toBe('acme/prj_a');
    const rows = (events[0]?.data as { rows: FilterStatRow[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: 'run_1',
      runKind: 'card',
      filter: 'fixture/demo',
      passedThrough: false,
    });
  });

  // #612: planner and design runs launch with `--permission-mode plan`.
  it.each([
    'plan',
    'ui_profile',
  ] as const)('rewrites and records a real filter id for a %s run in plan mode', async (runKind) => {
    const runDir = join(home, 'cards', 'card_1', 'rounds', 'run_1');
    mkdirSync(runDir, { recursive: true });
    const launch = tokenSaverLaunch({
      config: { enabled: true, mcpAllow: [] },
      profile: { id: 'p', runtime: 'claude', env: {}, args: [] },
      home,
      dir: runDir,
      selfCommand: ['/opt/agentdock-runner'],
      runKind,
      projectId: 'prj_a',
      runId: 'run_1',
      agentdock: false,
      scout: false,
    });
    if (!launch) throw new Error('expected a launch');
    const env = { PATH: process.env.PATH, ...launch.env };

    const out = runFilterHook(
      JSON.stringify({
        tool_name: 'Bash',
        permission_mode: 'plan',
        cwd: home,
        tool_input: { command: 'demo-test --all' },
      }),
      {
        env,
        filters: [demoFilter],
        selfCommand: ['/opt/agentdock-runner'],
        home,
        os: 'linux',
        now: Date.now,
        rules: () => ({ allow: [], deny: [], ask: [] }),
      },
    );
    const output = (JSON.parse(out) as HookOutput).hookSpecificOutput;
    expect(output.permissionDecision).toBeUndefined();
    expect(output.updatedInput.command).toBe(
      '/opt/agentdock-runner filter -- demo-test --all',
    );

    const fixture = join(home, 'demo.sh');
    writeFileSync(join(home, 'out.txt'), tapOutput(100, ['not ok 101 - x']));
    writeFileSync(fixture, `#!/bin/sh\ncat "${join(home, 'out.txt')}"\n`);
    chmodSync(fixture, 0o755);
    const code = await runFilter([fixture], {
      env,
      filters: [demoFilter],
      stdout: () => {},
      stderr: () => {},
      now: Date.now,
      onSignal: () => () => {},
    });
    expect(code).toBe(0);

    const events: UnsequencedEvent[] = [];
    const reader = new FilterStatsReader({
      roots: () => [join(home, 'cards')],
      resolve: async (ids) =>
        new Map(ids.map((id) => [id, { repo: `acme/${id}`, root: home }])),
      emit: (event) => events.push(event),
      log: createLogger({
        level: 'error',
        write: () => {},
        now: () => new Date(0),
      }),
      now: () => new Date(),
    });
    await reader.poll();
    const rows = (events[0]?.data as { rows: FilterStatRow[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runKind,
      filter: 'fixture/demo',
      passedThrough: false,
    });
  });
});
