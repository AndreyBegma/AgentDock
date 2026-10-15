import { describe, expect, it } from 'bun:test';
import { createNormalizeHandlers, type NormalizeExecutor } from './index';

describe('text.normalize handler (#271)', () => {
  it('hands the command to the normalize executor', async () => {
    const seen: string[] = [];
    const executor = {
      run: async (a: { runId: string }) => {
        seen.push(a.runId);
        return { phase: 'running' as const };
      },
    } as unknown as NormalizeExecutor;
    const handlers = createNormalizeHandlers(executor);
    expect(
      await handlers['text.normalize']({
        runId: 'run_1',
        projectId: 'prj_a',
        sessionId: '11111111-1111-4111-8111-111111111111',
        prompt: 'translate',
        profileKey: 'claude-work',
        model: 'haiku',
        timeoutSec: 120,
      }),
    ).toEqual({ phase: 'running' });
    expect(seen).toEqual(['run_1']);
  });
});
