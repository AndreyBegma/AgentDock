import { describe, expect, it } from 'bun:test';
import { type AssessExecutor, createAssessHandlers } from './index';

describe('card.assess handler (#322)', () => {
  it('hands the command to the assess executor', async () => {
    const seen: string[] = [];
    const executor = {
      run: async (a: { runId: string }) => {
        seen.push(a.runId);
        return { phase: 'running' as const };
      },
    } as unknown as AssessExecutor;
    const handlers = createAssessHandlers(executor);
    expect(
      await handlers['card.assess']({
        runId: 'run_1',
        projectId: 'prj_a',
        sessionId: '11111111-1111-4111-8111-111111111111',
        prompt: 'assess',
        profileKey: 'claude-work',
        model: 'haiku',
        timeoutSec: 120,
      }),
    ).toEqual({ phase: 'running' });
    expect(seen).toEqual(['run_1']);
  });
});
