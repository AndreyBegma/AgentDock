# ADR-0027: Stored text is normalized to English on the runner

Status: accepted · Date: 2026-10-15 · Extends [ADR-0026](0026-card-capture-reads-opt-in-session-content.md) ·
Issue: [#271](https://github.com/AndreyBegma/AgentDock/issues/271)

## Context

People type into AgentDock in whatever language they think in — Russian,
Ukrainian, English. What they type is read again by models (card workers, the
Planner, the design stage), turned into GitHub issues and branch names, and
read by other people on the team. On 2026-10-15 the product owner decided that
AgentDock stores English: the original is kept for audit, saving never waits
for a translation, a card's kind is classified rather than asked, and a project
can turn it off.

The server holds no model key. Every model call AgentDock makes is a Claude
Code CLI run on a runner, recorded as a `runs` row — the pattern ADR-0026 set
for card capture.

## Decision

1. **The column holds English.** Free text a person saves — a board card's
   title and body, a card round's feedback, a design comment, a plan brief, a
   task review comment, a plan turn's message and free-text answers — is
   translated to English, and the owner's own column is replaced with the
   translation. Prompt builders, issue creation and fingerprints read the
   column, so they read English with no change of their own. Model-written
   text, UI-profile edits and Planner instructions are not normalized.
2. **The original is kept.** One `text_normalizations` row per save holds each
   field's original text, the hash of what was asked about, the English text
   and the outcome. "Show original" reads it. Rows live as long as their owner.
3. **Translation runs on the project's runner.** It is the typed command
   `text.normalize` ([ADR-0010](0010-typed-command-allowlist-on-the-runner.md)),
   offered only by a runner that advertises it
   ([ADR-0023](0023-runners-advertise-their-commands.md)): headless `claude -p`
   with `haiku`, no tools, `--permission-mode plan`, the prompt on stdin, in a
   run directory outside every watched root and with `AGENTDOCK_HOOKS=off`, as
   `cards.extract` runs. Each call is a `runs` row of kind `text_normalize`,
   priced through the Claude session id the API assigns it
   ([ADR-0009](0009-api-equivalent-cost-from-a-versioned-price-table.md)). The
   server still holds no model key.
4. **Asynchronous, last write wins.** A save returns at once with the text as
   typed; a BullMQ job ([ADR-0015](0015-schedules-run-on-bullmq.md)) makes the
   call. A result is applied field by field, only where the column still
   hashes to the text it was asked about, so a person's edit in the meantime
   always wins.
5. **Code is never translated.** Fenced blocks, inline code, URLs, e-mail
   addresses, paths, identifiers, references and mentions are masked with
   numbered placeholders before the call and restored byte for byte after. A
   field whose translation loses, repeats or invents a placeholder keeps its
   original; the other fields of the same answer still apply.
6. **No call for English.** A text that is reliably English by a fixed
   heuristic is recorded as such with no model call.
7. **Kind is classified.** For a card whose kind no person has set, the same
   call classifies `bug` or `feature`. It is applied only until the card's
   first Run fixes its branch prefix; a person's choice is never overwritten.
8. **A switch per project.** `text_settings.normalizeEnabled` (project admin,
   default on) turns it off; existing English text and originals stay.

## Consequences

- One `haiku` call per non-English save, bounded to two running per project
  and stopped by a project budget's hard stop.
- While the runner is offline, or a project has no Claude profile, text stays
  as typed and the UI says "Not normalized"; an operator can retry.
- A model reads the text before its translation lands, in the language it was
  typed in. Models read any language, so nothing waits.
- The UI shows English; translating back to a person's language, and
  normalizing rows saved before this decision, are out of scope.
- Codex runtimes do not normalize.
