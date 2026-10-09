import { describe, expect, it } from 'bun:test';
import {
  commandErrorCodeSchema,
  commandResultMessageSchema,
  commands,
  isCommandName,
  TERMINAL_ATTACH_TIMEOUT_MS,
  terminalAttachArgsSchema,
  terminalAttachResultSchema,
  terminalCommands,
} from '../index';

const attach = {
  id: 'term_4c1d',
  target: {
    kind: 'slot',
    projectId: 'prj_a',
    root: '/home/dev/repo',
    slot: 'i42',
  },
  mode: 'read',
  cols: 160,
  rows: 48,
} as const;

const parses = (args: unknown): boolean =>
  terminalAttachArgsSchema.safeParse(args).success;

describe('terminal.attach', () => {
  it('is admin only, with its own timeout', () => {
    const definition = terminalCommands['terminal.attach'];
    expect(definition.minRole).toBe('admin');
    expect(definition.timeoutMs).toBe(TERMINAL_ATTACH_TIMEOUT_MS);
  });

  it('is in the commands map, added by the runner slot together with its handler', () => {
    expect(isCommandName('terminal.attach')).toBe(true);
    expect(Object.keys(commands)).toContain('terminal.attach');
  });

  it('accepts each target kind with its own field', () => {
    expect(parses(attach)).toBe(true);
    expect(
      parses({
        ...attach,
        mode: 'write',
        target: { kind: 'orchestrator', projectId: 'prj_a', root: '/r' },
      }),
    ).toBe(true);
    expect(
      parses({
        ...attach,
        target: {
          kind: 'skill_run',
          projectId: 'prj_a',
          root: '/r',
          runId: 'run_01HZX',
        },
      }),
    ).toBe(true);
  });

  it.each([
    ['a raw session name', { session: 'cs-i42' }],
    ['a command', { command: 'bash' }],
    ['a tmux target', { tmuxTarget: '=cs-i42:' }],
  ])('refuses %s in the target', (_name, extra) => {
    expect(parses({ ...attach, target: { ...attach.target, ...extra } })).toBe(
      false,
    );
  });

  it.each([
    ['a raw session name', { session: 'cs-i42' }],
    ['a command', { command: 'bash' }],
    ['argv', { argv: ['tmux', 'kill-server'] }],
  ])('refuses %s next to the target', (_name, extra) => {
    expect(parses({ ...attach, ...extra })).toBe(false);
  });

  it('refuses a target missing its own field, or carrying another kind’s', () => {
    for (const target of [
      { kind: 'slot', projectId: 'prj_a', root: '/r' },
      { kind: 'skill_run', projectId: 'prj_a', root: '/r' },
      { kind: 'orchestrator', projectId: 'prj_a', root: '/r', slot: 'i42' },
      { kind: 'slot', projectId: 'prj_a', root: '/r', slot: 'i42', runId: 'r' },
      { kind: 'shell', projectId: 'prj_a', root: '/r' },
    ]) {
      expect(parses({ ...attach, target })).toBe(false);
    }
  });

  it.each([
    ['a tmux target separator', 'i42:0'],
    ['a dot', 'i42.1'],
    ['a flag', '-t'],
    ['a path', '../i42'],
    ['upper case', 'I42'],
  ])('refuses a slot with %s', (_name, slot) => {
    expect(parses({ ...attach, target: { ...attach.target, slot } })).toBe(
      false,
    );
  });

  it.each([
    ['a path', '../../etc'],
    ['a slash', 'run/1'],
    ['empty', ''],
    ['too long', 'r'.repeat(65)],
  ])('refuses a runId that is %s', (_name, runId) => {
    expect(
      parses({
        ...attach,
        target: { kind: 'skill_run', projectId: 'prj_a', root: '/r', runId },
      }),
    ).toBe(false);
  });

  it('refuses a relative root, an unknown mode, a bad id and a size out of bounds', () => {
    for (const bad of [
      { target: { ...attach.target, root: 'repo' } },
      { mode: 'rw' },
      { id: 'term:1' },
      { cols: 9 },
      { rows: 201 },
    ]) {
      expect(parses({ ...attach, ...bad })).toBe(false);
    }
  });

  it('answers with the resolved session, and has its refusal codes', () => {
    const output = { attached: true, session: 'cs-i42' };
    expect(terminalAttachResultSchema.safeParse(output).success).toBe(true);
    expect(
      terminalAttachResultSchema.safeParse({ ...output, attached: false })
        .success,
    ).toBe(false);
    for (const code of ['not_found', 'busy', 'unsupported', 'disabled']) {
      expect(commandErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(
        commandResultMessageSchema.safeParse({
          type: 'command.result',
          id: 'cmd_31',
          ok: false,
          error: { code },
        }).success,
      ).toBe(true);
    }
  });
});
