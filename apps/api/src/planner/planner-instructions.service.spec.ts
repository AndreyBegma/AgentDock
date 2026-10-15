import { mergeMethodOf, specDirOf } from './planner-instructions.service';

describe('mergeMethodOf (#273 D12)', () => {
  it.each(['merge', 'squash', 'rebase'] as const)(
    'reads orchestrator.mergeMethod %s',
    (method) => {
      expect(mergeMethodOf({ orchestrator: { mergeMethod: method } })).toBe(
        method,
      );
    },
  );

  it('rejects anything but merge, squash or rebase', () => {
    for (const mergeMethod of ['Squash', 'fast-forward', '', 1, null, true]) {
      expect(mergeMethodOf({ orchestrator: { mergeMethod } })).toBeNull();
    }
  });

  it('is null without a config, an orchestrator or the key', () => {
    expect(mergeMethodOf(null)).toBeNull();
    expect(mergeMethodOf([])).toBeNull();
    expect(mergeMethodOf('merge')).toBeNull();
    expect(mergeMethodOf({})).toBeNull();
    expect(mergeMethodOf({ orchestrator: ['merge'] })).toBeNull();
    expect(mergeMethodOf({ orchestrator: { specDir: 'docs' } })).toBeNull();
  });

  it('leaves specDirOf as it was', () => {
    const config = { orchestrator: { specDir: 'docs/specs', mergeMethod: 'x' } };
    expect(specDirOf(config)).toBe('docs/specs');
    expect(mergeMethodOf(config)).toBeNull();
  });
});
