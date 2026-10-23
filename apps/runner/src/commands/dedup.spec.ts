import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../testing/fake-clock';
import { CommandDedup } from './dedup';

describe('CommandDedup', () => {
  it('evicts the least recently used id when full', async () => {
    const dedup = new CommandDedup<string>(new FakeClock(), 2);
    let runs = 0;
    const start = () => {
      runs += 1;
      return Promise.resolve(`run ${runs}`);
    };
    dedup.run('a', 'f', start);
    dedup.run('b', 'f', start);
    // Touching `a` makes `b` the least recently used.
    expect(dedup.run('a', 'f', start).hit).toBe('repeated');
    dedup.run('c', 'f', start);

    expect(dedup.size).toBe(2);
    expect(dedup.run('a', 'f', start).hit).toBe('repeated');
    expect(dedup.run('b', 'f', start).hit).toBe('new');
    expect(runs).toBe(4);
  });

  it('forgets an id only while it still holds that run', () => {
    const dedup = new CommandDedup<string>(new FakeClock());
    const first = dedup.run('a', 'f', () => Promise.resolve('one')).value;
    dedup.run('a', 'g', () => Promise.resolve('two'));
    dedup.forget('a', first);
    expect(dedup.run('a', 'g', () => Promise.resolve('three')).hit).toBe(
      'repeated',
    );
  });
});
