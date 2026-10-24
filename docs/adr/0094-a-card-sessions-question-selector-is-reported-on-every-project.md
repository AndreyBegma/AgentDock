# ADR-0094: A card session's question selector is reported on every project

Status: accepted · Date: 2026-10-24 ·
Issue: [#913](https://github.com/AndreyBegma/Nautelle/issues/913) ·
Spec: [`docs/specs/913-board-misses-a-card-session-s-question-w.md`](../specs/913-board-misses-a-card-session-s-question-w.md) ·
Amends [ADR-0045](0045-a-person-may-message-a-running-session-the-orchestrator-is-told.md) §4 ·
Card: C-381

## Context

ADR-0045 §4 counted a card session's question selector (`AskUserQuestion`) as
session content (ADR-0021). The runner therefore reported it as
`card_run.pending_question` only for a project that ships content. On every
other project the round still moved to *waiting*, but nothing told the Board
what the question was:

- `waitingOnQuestion` stayed false, and `board_card` returned `question: null`;
- `board_wait` emitted no question event;
- the web card and Telegram showed no options;
- `card_message` could not answer, because it had no `questionKey`.

C-369 sat on a selector for 2 h 20 min that way. The person could not see
whether the worker was waiting on them, or answer without taking control of
the terminal.

A selector is not something the session happens to print. It is the worker
addressing the person and waiting for an answer. Hiding it does not protect
the transcript. It only leaves the person unable to do what the worker asks.

## Decision

1. **The question is reported on every project.** The runner reports a card
   round's question selector as `card_run.pending_question` whether or not
   `Project.shipSessionContent` is on. This covers the header, the question
   text and the options (label, description, "Other"). It feeds
   `waitingOnQuestion`, `question` in `board.card`, the `board.wait` question
   event, the web card, the Telegram buttons and `card.message` answers by
   option or "Other". The content opt-in of ADR-0021 still governs everything
   else: the pane, the transcript and the hook payloads. This is the same line
   ADR-0052 draws for a remote `tool_use` preview.
2. **Redacted and capped on the runner, like hook content.**
   - The runner applies `redactText` (`apps/runner/src/local/redact.ts`) to
     every text before it leaves the machine.
   - It then caps the question at 2 000 characters, each label and
     description at 300, and the list at 12 options.
   - The question key is hashed from the reported values only, so a key never
     stands for a value that was masked.
   - The quote bar Claude Code draws in front of a long question (`│ `) is
     removed while parsing.
3. **A policy refusal is said by name.** A runner can turn `session.message`
   off in its local policy (ADR-0047). When it has:
   - the API refuses `card.message` before calling the runner, with
     `403 policy_refused`. It reads the policy the runner reported, and the
     message names the rule and the CLI line that lifts it
     (`nautelle-runner policy set commands.session.message true`);
   - a `policy_refused` error from the runner is passed on with the same code
     and wording;
   - the card detail carries this as `sessionMessageRefusal`, and the card
     sheet shows it under the message line;
   - MCP, the web app and Telegram all show the same reason.

## Consequences

- The header, text and options of every card question are stored with the
  round (`board_card_rounds.pendingQuestion`), also on projects that ship no
  session content. Redaction is pattern-based and may miss a secret. The
  caveat of ADR-0021 applies, as it does for ADR-0052's preview.
- A selector on a project without content shipping can be answered from the
  card, from Telegram and through `card_message`. The person no longer has to
  take control of the terminal.
- Runners from before this change still gate the question on content
  shipping. The fix needs the runner update.
- Fleet slots still do not report their question selector (ADR-0045).
- Rejected:
  - **Keep the question behind the content opt-in and only report
    `waitingOnQuestion`.** The person learns that the worker waits, but
    cannot see the question or answer it without the terminal.
  - **Turn content shipping on for such projects.** It ships the whole
    session to get one question out.
