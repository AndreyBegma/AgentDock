import { describe, expect, it } from 'bun:test';
import { createExec } from './exec';

const env = { PATH: process.env.PATH };

describe('createExec timeout', () => {
  it('kills a call that outlives the default', async () => {
    const exec = createExec(env, 100);
    expect(await exec('sleep', ['2'])).toBeNull();
  });

  it('honours a longer per-call timeout over the default', async () => {
    const exec = createExec(env, 100);
    const result = await exec('sleep', ['0.4'], { timeoutMs: 5_000 });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('honours a shorter per-call timeout', async () => {
    const exec = createExec(env, 5_000);
    expect(await exec('sleep', ['2'], { timeoutMs: 100 })).toBeNull();
  });
});
