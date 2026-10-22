import type { RunnerEvent } from '@nautelle/shared/protocol';
import { stripStewardContent } from './steward-content';

const event = (type: string, data: unknown): RunnerEvent => ({
  v: 1,
  seq: 1,
  ts: new Date().toISOString(),
  type,
  source: 'code-sentinel',
  data,
});

describe('stripStewardContent (C-186, DA-12)', () => {
  it('drops the pane tail of any steward event, valid or not', () => {
    const observed = event('steward.observed', {
      kind: 'not-a-kind',
      paneTail: 'SECRET pane text',
    });
    stripStewardContent(observed);
    expect(observed.data).toEqual({ kind: 'not-a-kind' });
    expect(JSON.stringify(observed.data)).not.toContain('SECRET');
  });

  it('leaves other events and tail-less data alone', () => {
    const other = event('pane.busy', { paneTail: 'kept' });
    stripStewardContent(other);
    expect(other.data).toEqual({ paneTail: 'kept' });

    const list = event('steward.acted', ['paneTail']);
    stripStewardContent(list);
    expect(list.data).toEqual(['paneTail']);
  });
});
