import { expect } from 'bun:test';
import { join } from 'node:path';
import type { TokenSaverRunKind } from '@agentdock/shared';
import { FILTER_RUN_KIND_ENV, LAUNCH_SETTINGS_ENV } from '../filter/env';
import { AUTOCOMPACT_ENV, TOKEN_SAVER_FILES } from './token-saver';

/** One launch as a test saw it: its argv and env. */
export interface SeenLaunch {
  command: readonly string[];
  env: Record<string, string>;
}

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
  expect(launch.env[AUTOCOMPACT_ENV]).toBe('60');
  expect(launch.env[LAUNCH_SETTINGS_ENV]).toBe(settings);
  expect(launch.env[FILTER_RUN_KIND_ENV]).toBe(runKind);
};
