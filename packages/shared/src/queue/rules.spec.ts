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

describe('the Parallel plan table is the first table only (#279)', () => {
  const nested = [
    '## Parallel plan',
    '',
    'Two slots, no overlap.',
    '',
    '| Slot | Owns | Depends on | Lead | Model |',
    '|---|---|---|---|---|',
    '| i275-a | shared | — | yes | opus |',
    '| i275-b | web | i275-a | no | sonnet |',
    '',
    '### Live contention',
    '',
    '| File | Other spec | Rule |',
    '|---|---|---|',
    '| apps/web/src/components/design/generate-panel.tsx | #272 | do not open |',
    '| packages/shared/src/x.ts | #273 | do not open |',
    '',
    '## Risks',
  ].join('\n');

  it('parseParallelPlan returns the plan slots in table order', () => {
    expect(parseParallelPlan(nested)).toEqual([
      { slot: 'i275-a', lead: true, model: 'opus' },
      { slot: 'i275-b', lead: false, model: 'sonnet' },
    ]);
  });

  it('parseWaveDependencies has entries only for the plan slots', () => {
    expect(parseWaveDependencies(nested)).toEqual(
      new Map([
        ['i275-a', []],
        ['i275-b', ['i275-a']],
      ]),
    );
  });

  it('drops a row whose slot cell is not a slot name', () => {
    const body = [
      '## Parallel plan',
      '| Slot | Lead |',
      '|---|---|',
      '| i1-a | yes |',
      '| File | no |',
      '| `apps/web/x.tsx` | no |',
      '| i1-b | no |',
    ].join('\n');
    expect(parseParallelPlan(body)?.map((s) => s.slot)).toEqual([
      'i1-a',
      'i1-b',
    ]);
  });

  it('a plan without a table has no slots', () => {
    expect(parseParallelPlan('## Parallel plan\nTBD')).toEqual([]);
  });
});
