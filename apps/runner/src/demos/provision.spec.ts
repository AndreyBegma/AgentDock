import { describe, expect, it } from 'bun:test';
import type { Exec, ExecResult } from '../detect/exec';
import { memoryLogger } from '../testing/fixtures';
import { DEMOFLOW_PACKAGE, demoflowMcpConfig } from './pin';
import { DemoflowProvisioner } from './provision';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

const machine =
  (table: Record<string, ExecResult | null>, calls: string[] = []): Exec =>
  async (binary, args) => {
    const key = [binary, ...args].join(' ');
    calls.push(key);
    return key in table ? table[key] : null;
  };

const VERSION = `npx --yes ${DEMOFLOW_PACKAGE} --version`;
const SETUP = `npx --yes ${DEMOFLOW_PACKAGE} setup`;

const provisioner = (exec: Exec) =>
  new DemoflowProvisioner({ exec, log: memoryLogger().log });

describe('DemoflowProvisioner', () => {
  it('is not ready before the first demo, and says so', () => {
    expect(provisioner(machine({})).status()).toEqual({
      version: '0.4.0',
      ready: false,
      reason: 'DemoFlow is set up on the first demo',
    });
  });

  it('runs the pinned DemoFlow through npx and `demoflow setup` once', async () => {
    const calls: string[] = [];
    const p = provisioner(
      machine(
        {
          'node --version': ok('v22.11.0\n'),
          [VERSION]: ok('0.4.0\n'),
          [SETUP]: ok('Chromium is installed: /x/chrome\n'),
        },
        calls,
      ),
    );
    const [a, b] = await Promise.all([p.ensure(), p.ensure()]);
    expect(a).toEqual({ version: '0.4.0', ready: true });
    expect(b).toBe(a);
    expect(await p.ensure()).toEqual(a);
    expect(p.status()).toEqual(a);
    expect(calls).toEqual(['node --version', VERSION, SETUP]);
  });

  it('refuses an old Node', async () => {
    const p = provisioner(machine({ 'node --version': ok('v20.10.0\n') }));
    expect((await p.ensure()).reason).toBe(
      'DemoFlow needs Node.js 22 or later; this machine has v20.10.0',
    );
  });

  it('refuses a DemoFlow that is not the pinned version', async () => {
    const p = provisioner(
      machine({
        'node --version': ok('v24.0.0'),
        [VERSION]: ok('0.5.1\n'),
      }),
    );
    const status = await p.ensure();
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('npx ran DemoFlow 0.5.1, not 0.4.0');
  });

  it('reports a failed setup and tries again on the next demo', async () => {
    const table: Record<string, ExecResult | null> = {
      'node --version': ok('v22.1.0'),
      [VERSION]: ok('0.4.0'),
      [SETUP]: { code: 3, stdout: '', stderr: 'download failed: ENOSPC\n' },
    };
    const p = provisioner(machine(table));
    expect((await p.ensure()).reason).toBe(
      'demoflow setup could not install Chromium: download failed: ENOSPC',
    );
    table[SETUP] = ok('Chromium installed: /x/chrome');
    expect((await p.ensure()).ready).toBe(true);
  });

  it('says when npx is missing', async () => {
    const p = provisioner(machine({ 'node --version': ok('v22.1.0') }));
    expect((await p.ensure()).reason).toMatch(/npx is not on the PATH/);
  });
});

describe('demoflowMcpConfig', () => {
  it('is a stdio server through the same pinned npx', () => {
    expect(JSON.parse(demoflowMcpConfig())).toEqual({
      mcpServers: {
        demoflow: {
          type: 'stdio',
          command: 'npx',
          args: ['--yes', DEMOFLOW_PACKAGE, 'mcp'],
        },
      },
    });
  });
});
