import { describe, expect, it } from 'bun:test';
import { SharedRunSlots } from './slots';

describe('SharedRunSlots', () => {
  it('holds at most the cap, and a holder acquiring again keeps its one slot', () => {
    const slots = new SharedRunSlots(2);
    expect(slots.tryAcquire('run:a')).toBe(true);
    expect(slots.tryAcquire('run:a')).toBe(true);
    expect(slots.tryAcquire('plan:b')).toBe(true);
    expect(slots.tryAcquire('run:c')).toBe(false);
    expect(slots.inUse).toBe(2);
  });

  it('tells every listener when a slot frees, and nothing when the id held none', () => {
    const slots = new SharedRunSlots(1);
    const heard: string[] = [];
    slots.onFree(() => heard.push('skills'));
    const off = slots.onFree(() => heard.push('planner'));
    slots.tryAcquire('run:a');
    slots.release('run:z');
    expect(heard).toEqual([]);
    slots.release('run:a');
    expect(heard).toEqual(['skills', 'planner']);
    off();
    slots.tryAcquire('plan:b');
    slots.release('plan:b');
    expect(heard).toEqual(['skills', 'planner', 'skills']);
    expect(slots.tryAcquire('run:c')).toBe(true);
  });
});
