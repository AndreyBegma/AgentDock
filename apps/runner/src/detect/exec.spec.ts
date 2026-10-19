import { describe, expect, it } from 'bun:test';
import { createExec } from './exec';

const env = { PATH: process.env.PATH };

describe('createExec timeout', () => {
  it('kills a call that outlives the default', async () => {
    const exec = createExec(env, 100);
    expect(await exec('sleep', ['2'])).toBeNull();
  });

  it('honours a longer per-call timeout over the default', async () => {
    // The default is far below the child's runtime, and the per-call limit far
    // above it, so only the per-call value deciding can let the child finish —
    // a loaded host stretches neither margin into the other.
    const exec = createExec(env, 20);
    const result = await exec('sleep', ['0.5'], { timeoutMs: 60_000 });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('honours a shorter per-call timeout', async () => {
    const exec = createExec(env, 5_000);
    expect(await exec('sleep', ['2'], { timeoutMs: 100 })).toBeNull();
  });
});
