import type {
  AssistantMessageView,
  AssistantStreamEvent,
  AssistantToolStep,
} from '@agentdock/shared';

/** The reply being written: what the stream has sent so far. */
export interface LiveTurn {
  /** The person's message, shown at once and replaced by the stored one. */
  text: string;
  reply: string;
  /** Tools started and not finished are `running`. */
  tools: LiveTool[];
  projectName: string | null;
  title: string | null;
}

export type LiveTool =
  | { id: string; name: string; status: 'running' }
  | ({ status: 'done' } & AssistantToolStep);

export const startTurn = (text: string): LiveTurn => ({
  text,
  reply: '',
  tools: [],
  projectName: null,
  title: null,
});

export type TurnOutcome =
  | { kind: 'streaming'; turn: LiveTurn }
  | {
      kind: 'done';
      turn: LiveTurn;
      userMessage: AssistantMessageView;
      message: AssistantMessageView;
    }
  | {
      kind: 'error';
      turn: LiveTurn;
      error: Extract<AssistantStreamEvent, { type: 'error' }>;
    };

/** Folds one stream event into the turn. */
export function applyEvent(
  turn: LiveTurn,
  event: AssistantStreamEvent,
): TurnOutcome {
  switch (event.type) {
    case 'delta':
      return {
        kind: 'streaming',
        turn: { ...turn, reply: turn.reply + event.text },
      };
    case 'tool': {
      if (event.status === 'started') {
        return {
          kind: 'streaming',
          turn: {
            ...turn,
            tools: [
              ...turn.tools,
              { id: event.id, name: event.name, status: 'running' },
            ],
          },
        };
      }
      const done: LiveTool = event;
      const known = turn.tools.some((tool) => tool.id === event.id);
      return {
        kind: 'streaming',
        turn: {
          ...turn,
          tools: known
            ? turn.tools.map((tool) => (tool.id === event.id ? done : tool))
            : [...turn.tools, done],
        },
      };
    }
    case 'project':
      return {
        kind: 'streaming',
        turn: { ...turn, projectName: event.projectName },
      };
    case 'title':
      return { kind: 'streaming', turn: { ...turn, title: event.title } };
    case 'done':
      return {
        kind: 'done',
        turn,
        userMessage: event.userMessage,
        message: event.message,
      };
    case 'error':
      return { kind: 'error', turn, error: event };
  }
}
