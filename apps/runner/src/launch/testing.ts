import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenSaverRunKind } from '@nautelle/shared';
import { FILTER_RUN_KIND_ENV, LAUNCH_SETTINGS_ENV } from '../filter/env';
import {
  AUTOCOMPACT_PCT_ENV,
  AUTOCOMPACT_WINDOW_ENV,
  CS_ECO_ENV,
  TOKEN_SAVER_FILES,
} from './token-saver';

/**
 * Amendment 12: a launch with Token saver on compacts at 150k tokens; #616:
 * it turns the plugin's eco hooks off, since the runner guards reads itself.
 * One with it off sets neither.
 */
export const expectEcoEnv = (
  env: Readonly<Record<string, string | undefined>>,
  on = true,
): void => {
  if (on) {
    expect(env[AUTOCOMPACT_WINDOW_ENV]).toBe('183000');
    expect(env[AUTOCOMPACT_PCT_ENV]).toBe('100');
    expect(env[CS_ECO_ENV]).toBe('off');
  } else {
    expect(env[AUTOCOMPACT_WINDOW_ENV]).toBeUndefined();
    expect(env[AUTOCOMPACT_PCT_ENV]).toBeUndefined();
    expect(env[CS_ECO_ENV]).toBeUndefined();
  }
};

/** One launch as a test saw it: its argv and env. */
export interface SeenLaunch {
  command: readonly string[];
  env: Record<string, string>;
}

/**
 * C-179: the MCP servers a headless text call loads, read at spawn — the run
 * dir that holds Token saver's file is gone once the call ends. `null` when
 * the launch has no strict MCP config: it would load the profile's own.
 */
export const strictMcpServersOf = (
  command: readonly string[],
): Record<string, unknown> | null => {
  const at = command.indexOf('--mcp-config');
  if (at < 1 || command[at - 1] !== '--strict-mcp-config') return null;
  if (command.lastIndexOf('--mcp-config') !== at) return null;
  const value = command[at + 1] ?? '';
  const json = value.startsWith('{') ? value : readFileSync(value, 'utf8');
  return JSON.parse(json).mcpServers;
};

/**
 * #445: a headless text call with Token saver on carries the settings and a
 * strict MCP list before its first flag — and neither the scout nor
 * `agentdock`, which it could not call.
 */
export const expectTextCallWired = (
  launch: SeenLaunch,
  runDir: string,
  runKind: TokenSaverRunKind,
): void => {
  const settings = join(runDir, TOKEN_SAVER_FILES.settings);
  const at = launch.command.indexOf('--settings');
  expect(at).toBeGreaterThan(0);
  expect(launch.command.slice(at, at + 5)).toEqual([
    '--settings',
    settings,
    '--strict-mcp-config',
    '--mcp-config',
    join(runDir, TOKEN_SAVER_FILES.mcp),
  ]);
  expect(at).toBeLessThan(launch.command.indexOf('-p'));
  expect(launch.command).not.toContain('--agents');
  expectEcoEnv(launch.env);
  expect(launch.env[LAUNCH_SETTINGS_ENV]).toBe(settings);
  expect(launch.env[FILTER_RUN_KIND_ENV]).toBe(runKind);
};
