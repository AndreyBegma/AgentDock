import { describe, expect, it } from 'bun:test';
import {
  type SetupStep,
  type TerminalSetupFacts,
  type TerminalSetupItem,
  type TerminalSetupProfileFacts,
  terminalSetup,
  terminalSetupProfileKeys,
} from './terminal-setup';

const claude = (
  key: string,
  over: Partial<TerminalSetupProfileFacts> = {},
): TerminalSetupProfileFacts => ({
  key,
  runtime: 'claude',
  agentdock: { plugin: '0.3.0', telemetry: true },
  sessions: { hooked: 4, unhooked: 0, unhookedAfterReport: 0 },
  ...over,
});

const ready: TerminalSetupFacts = {
  projectId: 'p1',
  runnerConnected: true,
  profiles: [claude('main')],
  shipSessionContent: true,
  captureEnabled: true,
};

const item = (
  facts: TerminalSetupFacts,
  id: TerminalSetupItem['id'],
  profileKey?: string,
): TerminalSetupItem | undefined =>
  terminalSetup(facts).items.find(
    (entry) => entry.id === id && entry.profileKey === profileKey,
  );

const commands = (steps: SetupStep[]): string[] =>
  steps.flatMap((step) => (step.kind === 'command' ? [step.code] : []));

describe('terminalSetup', () => {
  it('is complete for a set-up project, with the closing line', () => {
    const view = terminalSetup(ready);
    expect(view.complete).toBe(true);
    expect(view.todo).toBe(0);
    expect(view.closing).toContain("Board's Inbox");
    expect(view.items.map((entry) => entry.id)).toEqual([
      'runner_online',
      'plugin',
      'plugin_loaded',
      'content',
      'capture',
      'telemetry',
    ]);
  });

  describe('plugin', () => {
    it('is todo with D1 plugin null, and its steps hold the setup command', () => {
      const facts = {
        ...ready,
        profiles: [
          claude('main', { agentdock: { plugin: null, telemetry: false } }),
        ],
      };
      const plugin = item(facts, 'plugin', 'main');
      expect(plugin?.state).toBe('todo');
      expect(plugin?.optional).toBe(false);
      expect(commands(plugin?.steps ?? [])).toEqual([
        'agentdock-runner profiles',
        'agentdock-runner setup claude --profile main',
      ]);
      expect(terminalSetup(facts).complete).toBe(false);
      expect(terminalSetup(facts).todo).toBe(1);
    });

    it('is done with D1 absent and only hooked sessions', () => {
      const facts = {
        ...ready,
        profiles: [claude('main', { agentdock: null })],
      };
      expect(item(facts, 'plugin', 'main')?.state).toBe('done');
    });

    it('is unknown with D1 absent and no sessions', () => {
      const facts = {
        ...ready,
        profiles: [
          claude('main', {
            agentdock: null,
            sessions: { hooked: 0, unhooked: 0, unhookedAfterReport: 0 },
          }),
        ],
      };
      expect(item(facts, 'plugin', 'main')?.state).toBe('unknown');
      expect(terminalSetup(facts).complete).toBe(false);
      expect(terminalSetup(facts).todo).toBe(0);
    });

    it('is todo with D1 absent and only unhooked sessions', () => {
      const facts = {
        ...ready,
        profiles: [
          claude('main', {
            agentdock: null,
            sessions: { hooked: 0, unhooked: 273, unhookedAfterReport: 0 },
          }),
        ],
      };
      expect(item(facts, 'plugin', 'main')?.state).toBe('todo');
    });

    it('is unknown with D1 absent and mixed sessions', () => {
      const facts = {
        ...ready,
        profiles: [
          claude('main', {
            agentdock: null,
            sessions: { hooked: 2, unhooked: 1, unhookedAfterReport: 0 },
          }),
        ],
      };
      expect(item(facts, 'plugin', 'main')?.state).toBe('unknown');
    });

    it('reads a profile with no runtime as Claude', () => {
      const facts = {
        ...ready,
        profiles: [
          claude('seen', {
            runtime: null,
            agentdock: null,
            sessions: { hooked: 0, unhooked: 3, unhookedAfterReport: 0 },
          }),
        ],
      };
      expect(item(facts, 'plugin', 'seen')?.state).toBe('todo');
    });

    it('quotes a key that is not one shell word', () => {
      const facts = {
        ...ready,
        profiles: [
          claude("it's mine", {
            agentdock: { plugin: null, telemetry: false },
          }),
        ],
      };
      expect(
        commands(item(facts, 'plugin', "it's mine")?.steps ?? []),
      ).toContain("agentdock-runner setup claude --profile 'it'\\''s mine'");
    });
  });

  describe('plugin_loaded', () => {
    it('is todo when D1 reports the plugin and newer sessions are unhooked', () => {
      const facts = {
        ...ready,
        profiles: [
          claude('main', {
            sessions: { hooked: 1, unhooked: 2, unhookedAfterReport: 1 },
          }),
        ],
      };
      expect(item(facts, 'plugin', 'main')?.state).toBe('done');
      const loaded = item(facts, 'plugin_loaded', 'main');
      expect(loaded?.state).toBe('todo');
      expect(commands(loaded?.steps ?? [])).toEqual([
        'agentdock-runner status',
      ]);
    });

    it('is not listed unless D1 reports a version', () => {
      const facts = {
        ...ready,
        profiles: [claude('main', { agentdock: null })],
      };
      expect(item(facts, 'plugin_loaded', 'main')).toBeUndefined();
    });
  });

  describe('capture', () => {
    it('is blocked while content is todo, and says why', () => {
      const facts = {
        ...ready,
        shipSessionContent: false,
        captureEnabled: false,
      };
      const capture = item(facts, 'capture');
      expect(item(facts, 'content')?.state).toBe('todo');
      expect(capture?.state).toBe('todo');
      expect(capture?.blockedBy).toBe('content');
      expect(
        capture?.steps.some(
          (step) =>
            step.kind === 'note' &&
            step.text.startsWith('Turn on session content first'),
        ),
      ).toBe(true);
    });

    it('shows no internals — status codes, error codes, ADR numbers — in any step', () => {
      const view = terminalSetup({
        ...ready,
        shipSessionContent: false,
        captureEnabled: false,
      });
      const texts = view.items.flatMap((entry) =>
        entry.steps.flatMap((step) => {
          if (step.kind === 'note') return [step.text];
          if (step.kind === 'link') return [step.label];
          return step.label ? [step.label] : [];
        }),
      );
      for (const text of [...texts, view.closing]) {
        expect(text).not.toMatch(/ADR-\d+|\b4\d\d\b|capture_needs_content/);
      }
    });

    it('is not blocked once content is on', () => {
      const facts = { ...ready, captureEnabled: false };
      const capture = item(facts, 'capture');
      expect(capture?.state).toBe('todo');
      expect(capture?.blockedBy).toBeUndefined();
    });

    it('links the project settings', () => {
      expect(item(ready, 'capture')?.steps).toContainEqual({
        kind: 'link',
        href: '/projects/p1/settings?tab=board',
        label: 'Settings › Board › Capture',
      });
      expect(item(ready, 'content')?.steps).toContainEqual({
        kind: 'link',
        href: '/projects/p1/settings?tab=sessions',
        label: 'Settings › Sessions',
      });
    });
  });

  it('never lets telemetry make the list incomplete', () => {
    for (const agentdock of [{ plugin: '0.3.0', telemetry: false }, null]) {
      const facts = { ...ready, profiles: [claude('main', { agentdock })] };
      const telemetry = item(facts, 'telemetry', 'main');
      expect(telemetry?.optional).toBe(true);
      expect(telemetry?.state).not.toBe('done');
      expect(terminalSetup(facts).complete).toBe(true);
      expect(terminalSetup(facts).todo).toBe(0);
    }
  });

  it('lists a Codex profile once and never as a blocker', () => {
    const facts = {
      ...ready,
      profiles: [
        claude('main'),
        claude('cx', {
          runtime: 'codex',
          agentdock: null,
          sessions: { hooked: 0, unhooked: 9, unhookedAfterReport: 9 },
        }),
      ],
    };
    const view = terminalSetup(facts);
    const codex = view.items.filter((entry) => entry.profileKey === 'cx');
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({ id: 'plugin', optional: true });
    expect(codex[0].steps).toEqual([
      { kind: 'note', text: 'Codex sessions do not report hooks.' },
    ]);
    expect(view.complete).toBe(true);
  });

  describe('no Claude profile is known', () => {
    const none = { ...ready, profiles: [] };

    it('emits one unknown plugin item that says how to list profiles, then set up', () => {
      const plugins = terminalSetup(none).items.filter(
        (entry) => entry.id === 'plugin',
      );
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        state: 'unknown',
        optional: false,
      });
      expect(plugins[0].profileKey).toBeUndefined();
      expect(commands(plugins[0].steps)).toEqual([
        'agentdock-runner profiles',
        'agentdock-runner setup claude --profile <key>',
      ]);
      expect(terminalSetup(none).complete).toBe(false);
    });

    it('does the same when only a Codex profile is known', () => {
      const view = terminalSetup({
        ...ready,
        profiles: [claude('cx', { runtime: 'codex', agentdock: null })],
      });
      expect(
        view.items.filter(
          (entry) => entry.id === 'plugin' && entry.profileKey === undefined,
        ),
      ).toHaveLength(1);
    });

    it('is not emitted once a Claude profile is listed', () => {
      expect(
        terminalSetup(ready).items.filter(
          (entry) => entry.id === 'plugin' && entry.profileKey === undefined,
        ),
      ).toHaveLength(0);
    });
  });

  it('is todo while the runner is offline', () => {
    const facts = { ...ready, runnerConnected: false };
    expect(item(facts, 'runner_online')?.state).toBe('todo');
    expect(terminalSetup(facts).todo).toBe(1);
  });

  it('counts each required todo', () => {
    const view = terminalSetup({
      ...ready,
      profiles: [
        claude('main', { agentdock: { plugin: null, telemetry: false } }),
      ],
      shipSessionContent: false,
      captureEnabled: false,
    });
    expect(view.todo).toBe(3);
  });
});

describe('terminalSetupProfileKeys', () => {
  it('lists default, orchestrator, sessions, card runs — deduplicated', () => {
    expect(
      terminalSetupProfileKeys({
        defaultKey: 'main',
        orchestratorKey: 'orch',
        sessionKeys: ['personal', null, 'main', ''],
        cardRunKeys: ['orch', 'worker'],
      }),
    ).toEqual(['main', 'orch', 'personal', 'worker']);
  });

  it('adds the profiles the runner reports last, deduplicated', () => {
    expect(
      terminalSetupProfileKeys({
        defaultKey: 'main',
        orchestratorKey: null,
        sessionKeys: [],
        cardRunKeys: [],
        reportedKeys: ['alt', 'main'],
      }),
    ).toEqual(['main', 'alt']);
  });

  it('is empty with nothing set', () => {
    expect(
      terminalSetupProfileKeys({
        defaultKey: null,
        orchestratorKey: null,
        sessionKeys: [],
        cardRunKeys: [],
      }),
    ).toEqual([]);
  });
});
