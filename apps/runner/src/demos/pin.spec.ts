import { describe, expect, it } from 'bun:test';
import { DEMOFLOW_PACKAGE, DEMOFLOW_VERSION, demoflowCommand } from './pin';

describe('DemoFlow pin', () => {
  it('is 0.6.0, the first with --port and --fresh-app (C-387)', () => {
    expect(DEMOFLOW_VERSION).toBe('0.6.0');
    expect(DEMOFLOW_PACKAGE).toBe('demoflow@0.6.0');
    expect(demoflowCommand('run').args).toEqual([
      '--yes',
      'demoflow@0.6.0',
      'run',
    ]);
  });
});
