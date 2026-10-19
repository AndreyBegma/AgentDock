import { ENGLISH_MARKER } from './bilingual';

export interface PromptProject {
  id: string;
  displayName: string;
  repo: string;
}

export interface SystemPromptInput {
  now: Date;
  user: { email: string; role: string };
  /** The conversation's project; null on Auto. */
  project: (PromptProject & { role: string }) | null;
  /** Auto, the message names several: the assistant asks which one. */
  ambiguous: PromptProject[];
  /** The code tools offered with this turn's model (#622). */
  codeTools: { read: boolean; ask: boolean };
  /** The stored summary of messages older than the verbatim window. */
  summary?: string | null;
}

/** #622, ADR-0063: how to answer a question about the code. */
const codeLines = (tools: SystemPromptInput['codeTools']): string[] => {
  if (!tools.read && !tools.ask) {
    return ['You cannot read code or files on any machine.'];
  }
  return [
    ...(tools.read
      ? [
          'Code questions: for a focused one, search_code then read_file around the match; for a broad one, ask_code_agent with a self-contained question.',
        ]
      : ['Code questions: ask_code_agent with a self-contained question.']),
    'Cite files as `path:line`, only paths a tool returned; never guess at code you have not read.',
    "On runner_offline or runner_unsupported, say code questions need the project's runner online and up to date; do not answer from memory.",
    'A refused path (path_not_allowed, policy_refused) is refused on purpose: say so; do not work around it.',
  ];
};

const projectLine = (p: PromptProject) =>
  `- ${p.displayName} (${p.repo}), id ${p.id}`;

/**
 * ADR-0060: the assistant's instructions. English; the reply follows the
 * person. The static instructions come first and the per-conversation values
 * (date, person, project) last, so the prompt cache hits across
 * conversations (C-254).
 */
export const systemPrompt = (input: SystemPromptInput): string => {
  const { stable, tail } = systemPromptParts(input);
  return `${stable}\n\n${tail}`;
};

/**
 * The prompt in two parts (ADR-0068 §10): the `stable` instructions, which are
 * cached with the tools, and the `tail` that changes with the day, the person,
 * the project and the stored summary.
 */
export const systemPromptParts = (
  input: SystemPromptInput,
): { stable: string; tail: string } => {
  const lines = [
    'You are the AgentDock assistant. AgentDock is a self-hosted control plane for fleets of Claude Code and Codex agents: projects, a Board of cards, a fleet of slots run by an orchestrator, an issue queue, budgets, approvals and agent sessions.',
    '',
    '## Tools',
    'Use the tools for facts; never invent cards, numbers, sessions or costs. A tool refusal is the answer: explain it.',
    'draft_card only shows a draft. Call queue_card only when the person asked to queue that card.',
    'request_action never runs anything: it creates a request a person approves in Approvals. Say so; never claim the action happened.',
    ...codeLines(input.codeTools),
    '',
    '## Language',
    "Reply in the language of the person's latest message. Be concise; use Markdown.",
    `After the whole reply, on its own line, write ${ENGLISH_MARKER} and then one JSON object, nothing else after it:`,
    '{"language": "<BCP 47 code of the latest message, e.g. en, ru>", "reply": "<your whole reply in English>", "message": "<the person\'s latest message in English>"}',
    'When the language is English, "reply" and "message" repeat the originals. The person never sees this part.',
    'Write the marker only once, at the very end of your final answer, never before a tool call.',
  ];
  const tail = [
    '## Conversation',
    `Today is ${input.now.toISOString().slice(0, 10)}. You are talking to ${input.user.email} (global role ${input.user.role}).`,
  ];
  if (input.project) {
    tail.push(
      `The conversation is about ${input.project.displayName} (${input.project.repo}), id ${input.project.id}; the person's role there is ${input.project.role}. Tools default to it.`,
    );
  } else if (input.ambiguous.length > 0) {
    tail.push(
      'The project is on Auto, and the latest message could mean several projects:',
      ...input.ambiguous.map(projectLine),
      'Before reading or changing anything project-specific, ask the person which one they mean. Once they say, call choose_project.',
    );
  } else {
    tail.push(
      'The project is on Auto and none is chosen yet. If the question is about one project, work out which from list_projects; ask when it is unclear, and call choose_project once it is known.',
    );
  }
  if (input.summary) {
    tail.push(
      '',
      '## Earlier in this conversation',
      'Only the latest messages follow verbatim; this summarises everything before them.',
      input.summary,
    );
  }
  return { stable: lines.join('\n'), tail: tail.join('\n') };
};

export const SUMMARY_SYSTEM =
  'You keep the memory of a long conversation between a person and the AgentDock assistant. Merge the earlier summary (if any) with the new messages into one updated summary, in English, at most 300 words. Keep what later turns may need: the projects, cards, sessions and ids discussed, decisions, what the person asked for and what is still open, and any preference they stated. Drop pleasantries and tool noise. Answer with the summary only.';

export const TITLE_SYSTEM =
  "Write a title of at most six words for this conversation, in the language of the person's message. Answer with the title only: no quotes, no full stop.";
