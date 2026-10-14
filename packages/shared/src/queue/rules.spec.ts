import { describe, expect, it } from 'bun:test';
import { parseParallelPlan, parseWaveDependencies } from './rules';

describe('parseWaveDependencies', () => {
  const body = [
    '## Parallel plan',
    '| Slot | Owns | Depends on | Lead | Model |',
    '|---|---|---|---|---|',
    '| i160-data | shared | — | yes | opus |',
    '| i160-canvas | web | i160-data | no | opus |',
    '| i160-panel | web | `i160-data`, i160-canvas, #159, i9-x | no | opus |',
  ].join('\n');

  it('reads the Depends on column: slots of the same plan only', () => {
    expect(parseWaveDependencies(body)).toEqual(
      new Map([
        ['i160-data', []],
        ['i160-canvas', ['i160-data']],
        ['i160-panel', ['i160-data', 'i160-canvas']],
      ]),
    );
  });

  it('leaves parseParallelPlan as it was', () => {
    expect(parseParallelPlan(body)).toEqual([
      { slot: 'i160-data', lead: true, model: 'opus' },
      { slot: 'i160-canvas', lead: false, model: 'opus' },
      { slot: 'i160-panel', lead: false, model: 'opus' },
    ]);
  });

  it('is empty per slot without the column, and null without a plan', () => {
    const plain =
      '## Parallel plan\n| Slot | Lead |\n|---|---|\n| i1-a | yes |';
    expect(parseWaveDependencies(plain)).toEqual(new Map([['i1-a', []]]));
    expect(parseWaveDependencies('## Acceptance criteria\n- [ ] x')).toBeNull();
  });
});
