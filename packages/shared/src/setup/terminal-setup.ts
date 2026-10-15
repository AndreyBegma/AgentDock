import type { ProfileAgentdock, Runtime } from '../protocol';

/**
 * The "Terminal → Board" checklist (issue #281 D4): what a project needs before
 * the work people do in their own terminal reaches its Board. Pure — the API
 * gathers the facts from session rows and the runner's stored capabilities,
 * never the project filesystem (ADR-0001). Nothing here is installed from the
 * web (D7): the steps are what the person runs.
 */

/**
 * - `runner_online` — the project's runner is connected;
 * - `plugin` — the agentdock plugin is installed in a profile (one per profile);
 * - `plugin_loaded` — sessions of a profile with the plugin do report hooks;
 * - `content` — the project ships session content (ADR-0021);
 * - `capture` — card capture is on (ADR-0026);
 * - `telemetry` — a profile sends OTel to the runner; optional, never a blocker.
 */
export const TERMINAL_SETUP_ITEM_IDS = [
  'runner_online',
  'plugin',
  'plugin_loaded',
  'content',
  'capture',
  'telemetry',
] as const;
export type TerminalSetupItemId = (typeof TERMINAL_SETUP_ITEM_IDS)[number];

/** `unknown`: the facts cannot tell — an older runner and no recent sessions. */
export type SetupState = 'done' | 'todo' | 'unknown';

/**
 * - `command` — shell code the person runs, `label` says what it is for;
 * - `link` — a page of the web app that does the step;
 * - `note` — an instruction with nothing to copy or open.
 */
export type SetupStep =
  | { kind: 'command'; code: string; label?: string }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'note'; text: string };

export interface TerminalSetupItem {
  id: TerminalSetupItemId;
  state: SetupState;
  /** An optional item never makes the checklist incomplete. */
  optional: boolean;
  /** Set on the per-profile items: `plugin`, `plugin_loaded`, `telemetry`. */
  profileKey?: string;
  /** The item that has to be done first; `capture` waits for `content`. */
  blockedBy?: TerminalSetupItemId;
  steps: SetupStep[];
}

/** `GET /projects/:projectId/terminal-setup` (D5). */
export interface TerminalSetupView {
  items: TerminalSetupItem[];
  /** Every required item is done. */
  complete: boolean;
  /** Required items in `todo` — the Overview's "N steps" (D6). */
  todo: number;
  /** What happens once the checklist is complete. */
  closing: string;
}

/** D2: a profile's sessions in the project over the last 7 days. */
export interface TerminalSetupSessionCounts {
  /** Origin `manual`: a hook event reached the session. */
  hooked: number;
  /** Origin `unknown`: no hook event ever reached it. */
  unhooked: number;
  /** Unhooked sessions that started after the runner's report (`runner.lastSeenAt`). */
  unhookedAfterReport: number;
}

export interface TerminalSetupProfileFacts {
  key: string;
  /** Null for a key seen only on sessions, with no profile row; read as Claude. */
  runtime: Runtime | null;
  /** D1 from the runner's stored capabilities (`profileAgentdockOf`); null is unknown. */
  agentdock: ProfileAgentdock | null;
  sessions: TerminalSetupSessionCounts;
}

export interface TerminalSetupFacts {
  projectId: string;
  /** Whether the project's runner has an open socket. */
  runnerConnected: boolean;
  /** D3's profiles, in `terminalSetupProfileKeys` order. */
  profiles: readonly TerminalSetupProfileFacts[];
  /** `projects.shipSessionContent`. */
  shipSessionContent: boolean;
  /** `projects.captureEnabled`. */
  captureEnabled: boolean;
}

export const TERMINAL_SETUP_CLOSING =
  "Suggestions from your terminal sessions appear in the Board's Inbox; accept one to make it a card.";

/** D3 sources, in the order the checklist lists them. */
export interface TerminalSetupProfileSources {
  defaultKey: string | null;
  orchestratorKey: string | null;
  /** Profiles of the project's `manual` and `unknown` sessions, last 7 days (D2). */
  sessionKeys: readonly (string | null)[];
  /** Profiles of the project's `card` runs, last 7 days. */
  cardRunKeys: readonly (string | null)[];
  /** Claude profiles the project's runner reports (`reportedClaudeProfileKeysOf`). */
  reportedKeys?: readonly string[];
}

/** D3: the profile keys the checklist lists, deduplicated, in source order. */
export const terminalSetupProfileKeys = (
  sources: TerminalSetupProfileSources,
): string[] => {
  const keys = [
    sources.defaultKey,
    sources.orchestratorKey,
    ...sources.sessionKeys,
    ...sources.cardRunKeys,
    ...(sources.reportedKeys ?? []),
  ].filter((key): key is string => typeof key === 'string' && key.length > 0);
  return [...new Set(keys)];
};

const SAFE_SHELL_WORD = /^[A-Za-z0-9._-]+$/;

/** A profile key as one shell word; runner keys never need the quotes. */
const shellWord = (value: string): string =>
  SAFE_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

const setupCommand = (key: string): string =>
  `agentdock-runner setup claude --profile ${shellWord(key)}`;

const RESTART_NOTE: SetupStep = {
  kind: 'note',
  text: 'Restart open Claude Code sessions of this profile — a running session does not load a new plugin.',
};

const pluginSteps = (key: string): SetupStep[] => [
  {
    kind: 'command',
    code: 'agentdock-runner profiles',
    label: 'Find the key: the first column',
  },
  {
    kind: 'command',
    code: setupCommand(key),
    label: 'Install the agentdock plugin into this profile',
  },
  RESTART_NOTE,
  { kind: 'note', text: 'A new session then shows as Manual in Sessions.' },
];

/**
 * No Claude profile is known — none configured, none seen on a session, none
 * reported by the runner (offline, or an older one): the person is told how to
 * list the keys and which command takes one.
 */
const unknownProfilePlugin = (): TerminalSetupItem => ({
  id: 'plugin',
  state: 'unknown',
  optional: false,
  steps: [
    {
      kind: 'command',
      code: 'agentdock-runner profiles',
      label: 'List the profile keys: the first column',
    },
    {
      kind: 'command',
      code: 'agentdock-runner setup claude --profile <key>',
      label: 'Install the agentdock plugin into the profile you work in',
    },
    RESTART_NOTE,
    { kind: 'note', text: 'A new session then shows as Manual in Sessions.' },
  ],
});

const pluginState = ({
  agentdock,
  sessions,
}: TerminalSetupProfileFacts): SetupState => {
  if (agentdock) return agentdock.plugin ? 'done' : 'todo';
  if (sessions.hooked > 0 && sessions.unhooked === 0) return 'done';
  if (sessions.hooked === 0 && sessions.unhooked > 0) return 'todo';
  return 'unknown';
};

/** One profile's items, each kind placed in its own spot of the list. */
interface ProfileItems {
  plugin: TerminalSetupItem;
  loaded: TerminalSetupItem[];
  telemetry: TerminalSetupItem[];
}

const profileItems = (profile: TerminalSetupProfileFacts): ProfileItems => {
  const profileKey = profile.key;
  if (profile.runtime === 'codex') {
    return {
      plugin: {
        id: 'plugin',
        state: 'unknown',
        optional: true,
        profileKey,
        steps: [{ kind: 'note', text: 'Codex sessions do not report hooks.' }],
      },
      loaded: [],
      telemetry: [],
    };
  }
  const plugin: TerminalSetupItem = {
    id: 'plugin',
    state: pluginState(profile),
    optional: false,
    profileKey,
    steps: pluginSteps(profileKey),
  };
  const loaded: TerminalSetupItem[] = [];
  if (profile.agentdock?.plugin) {
    loaded.push({
      id: 'plugin_loaded',
      state: profile.sessions.unhookedAfterReport > 0 ? 'todo' : 'done',
      optional: false,
      profileKey,
      steps: [
        RESTART_NOTE,
        {
          kind: 'command',
          code: 'agentdock-runner status',
          label: 'Check that the runner is connected',
        },
      ],
    });
  }
  const telemetry: TerminalSetupItem = {
    id: 'telemetry',
    state: profile.agentdock
      ? profile.agentdock.telemetry
        ? 'done'
        : 'todo'
      : 'unknown',
    optional: true,
    profileKey,
    steps: [
      {
        kind: 'command',
        code: setupCommand(profileKey),
        label: 'Point the profile’s telemetry at the runner',
      },
      {
        kind: 'note',
        text: 'Telemetry feeds tokens and cost, not the Board.',
      },
    ],
  };
  return { plugin, loaded, telemetry: [telemetry] };
};

/** D4: the ordered checklist. */
export const terminalSetup = (facts: TerminalSetupFacts): TerminalSetupView => {
  const settings = `/projects/${facts.projectId}/settings`;
  const perProfile = facts.profiles.map(profileItems);
  const contentState: SetupState = facts.shipSessionContent ? 'done' : 'todo';

  const capture: TerminalSetupItem = {
    id: 'capture',
    state: facts.captureEnabled ? 'done' : 'todo',
    optional: false,
    steps: [
      {
        kind: 'link',
        href: `${settings}?tab=board`,
        label: 'Settings › Board › Capture',
      },
    ],
  };
  if (!facts.captureEnabled && contentState === 'todo') {
    capture.blockedBy = 'content';
    capture.steps.unshift({
      kind: 'note',
      text: 'Turn on session content first: capture reads it, and is refused without it.',
    });
  }

  const items: TerminalSetupItem[] = [
    {
      id: 'runner_online',
      state: facts.runnerConnected ? 'done' : 'todo',
      optional: false,
      steps: [
        {
          kind: 'link',
          href: '/install',
          label: 'Install and start the runner',
        },
        {
          kind: 'command',
          code: 'agentdock-runner status',
          label: 'Check that the runner is connected',
        },
      ],
    },
    ...(facts.profiles.some((profile) => profile.runtime !== 'codex')
      ? []
      : [unknownProfilePlugin()]),
    ...perProfile.map((items) => items.plugin),
    ...perProfile.flatMap((items) => items.loaded),
    {
      id: 'content',
      state: contentState,
      optional: false,
      steps: [
        {
          kind: 'link',
          href: `${settings}?tab=sessions`,
          label: 'Settings › Sessions',
        },
        {
          kind: 'note',
          text: 'Session content is prompts, replies and tool input and output from hook events, redacted on the runner and kept for the project’s retention.',
        },
      ],
    },
    capture,
    ...perProfile.flatMap((items) => items.telemetry),
  ];

  const required = items.filter((item) => !item.optional);
  return {
    items,
    complete: required.every((item) => item.state === 'done'),
    todo: required.filter((item) => item.state === 'todo').length,
    closing: TERMINAL_SETUP_CLOSING,
  };
};
