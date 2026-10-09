import { describe, expect, it } from 'bun:test';
import {
  ptyAvailable,
  terminalCapability,
  terminalUnsupported,
  versionAtLeast,
} from './capabilities';

describe('versionAtLeast', () => {
  it('compares the leading numbers', () => {
    expect(versionAtLeast('3.2', [3, 2])).toBe(true);
    expect(versionAtLeast('3.2a', [3, 2])).toBe(true);
    expect(versionAtLeast('3.5a', [3, 2])).toBe(true);
    expect(versionAtLeast('4.0', [3, 2])).toBe(true);
    expect(versionAtLeast('3.1c', [3, 2])).toBe(false);
    expect(versionAtLeast('2.9', [3, 2])).toBe(false);
    expect(versionAtLeast('1.3.5', [1, 3, 5])).toBe(true);
    expect(versionAtLeast('1.3.4', [1, 3, 5])).toBe(false);
    expect(versionAtLeast('1.4', [1, 3, 5])).toBe(true);
    expect(versionAtLeast(null, [3, 2])).toBe(false);
    expect(versionAtLeast('next', [3, 2])).toBe(false);
  });
});

describe('terminal capability (spec 29 D3, D10)', () => {
  it('is true with a PTY and tmux ≥ 3.2', () => {
    expect(
      terminalCapability({ tmux: '3.5a', disabledCommands: [], pty: true }),
    ).toBe(true);
  });

  it('is false when terminal.attach is in disabledCommands', () => {
    expect(
      terminalCapability({
        tmux: '3.5a',
        disabledCommands: ['terminal.attach'],
        pty: true,
      }),
    ).toBe(false);
  });

  it('is false without a PTY API, without tmux, or with tmux < 3.2', () => {
    expect(
      terminalCapability({ tmux: '3.5a', disabledCommands: [], pty: false }),
    ).toBe(false);
    expect(
      terminalCapability({ tmux: null, disabledCommands: [], pty: true }),
    ).toBe(false);
    expect(
      terminalCapability({ tmux: '3.1c', disabledCommands: [], pty: true }),
    ).toBe(false);
    expect(terminalUnsupported('3.1c', true)).toContain('tmux 3.1c');
    expect(terminalUnsupported('3.5a', false)).toContain('PTY');
  });

  it('finds the PTY API on the Bun the runner is built with', () => {
    expect(ptyAvailable()).toBe(process.platform !== 'win32');
  });
});
