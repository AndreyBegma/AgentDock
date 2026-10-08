import { describe, expect, it } from 'bun:test';
import {
  ownedSlot,
  parseSessionName,
  sessionPrefix,
  slotOfWorktree,
  slotWorktreePath,
} from './session-name';

describe('parseSessionName', () => {
  it('parses the legacy and the prefixed form to the same slot', () => {
    expect(parseSessionName('cs-i42-api')).toEqual({
      slot: 'i42-api',
      prefix: null,
    });
    expect(parseSessionName('cs-agentdock--i42-api')).toEqual({
      slot: 'i42-api',
      prefix: 'agentdock',
    });
    expect(parseSessionName('cs-claude-code-plugin--i8-approvals')).toEqual({
      slot: 'i8-approvals',
      prefix: 'claude-code-plugin',
    });
  });

  it.each([
    'agentdock-orchestrator',
    'cs-',
    'cs-agentdock--',
    'cs---i42',
    'cs-I42',
    'cs-i42 api',
    'xcs-i42',
  ])('refuses %s', (name) => {
    expect(parseSessionName(name)).toBeNull();
  });
});

describe('sessionPrefix', () => {
  it('slugs the basename as plugin#11 D2 does', () => {
    expect(sessionPrefix('AgentDock')).toBe('agentdock');
    expect(sessionPrefix('claude_code  plugin!')).toBe('claude-code-plugin');
    expect(sessionPrefix('--Weird..Name--')).toBe('weird-name');
    expect(sessionPrefix('a-very-long-repository-name-indeed')).toBe(
      'a-very-long-repository-n',
    );
    expect(sessionPrefix('abcdefghijklmnopqrstuvw-xyz')).toBe(
      'abcdefghijklmnopqrstuvw',
    );
  });
});

describe('worktree paths', () => {
  it('builds and reads dispatch.sh worktree paths', () => {
    expect(slotWorktreePath('/dev/AgentDock', 'i42-api')).toBe(
      '/dev/.wt-AgentDock-i42-api',
    );
    expect(slotWorktreePath('/dev/AgentDock/', 'i42')).toBe(
      '/dev/.wt-AgentDock-i42',
    );
    expect(slotOfWorktree('/dev/AgentDock', '/dev/.wt-AgentDock-i42-api')).toBe(
      'i42-api',
    );
    expect(slotOfWorktree('/dev/AgentDock', '/dev/.wt-Other-i42')).toBeNull();
    expect(slotOfWorktree('/dev/AgentDock', '/tmp/.wt-AgentDock-i42')).toBe(
      null,
    );
    expect(slotOfWorktree('/dev/AgentDock', '/dev/AgentDock')).toBeNull();
  });
});

describe('ownedSlot', () => {
  const ownership = {
    root: '/dev/AgentDock',
    worktreeSlots: new Set(['i42-api', 'i7']),
  };

  it('owns both forms when the worktree is one of the root', () => {
    expect(ownedSlot('cs-i42-api', ownership)).toBe('i42-api');
    expect(ownedSlot('cs-agentdock--i42-api', ownership)).toBe('i42-api');
  });

  it('ignores a session whose worktree belongs to another repository', () => {
    expect(ownedSlot('cs-i99', ownership)).toBeNull();
    expect(ownedSlot('cs-glass-ui--i99', ownership)).toBeNull();
  });

  it('ignores another repository prefix even when the slot name matches', () => {
    expect(ownedSlot('cs-glass-ui--i42-api', ownership)).toBeNull();
  });

  it('accepts the configured prefix instead of the derived one', () => {
    const configured = { ...ownership, configuredPrefix: 'dock' };
    expect(ownedSlot('cs-dock--i7', configured)).toBe('i7');
    expect(ownedSlot('cs-agentdock--i7', configured)).toBeNull();
  });

  it('ignores sessions that are not slot sessions', () => {
    expect(ownedSlot('agentdock-orchestrator', ownership)).toBeNull();
  });
});
