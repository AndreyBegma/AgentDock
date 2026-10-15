# ADR-0026: Card capture reads opt-in session content with a small model on the project's runner

Status: accepted · Date: 2026-10-15 · Amends [ADR-0021](0021-session-content-is-opt-in-per-project.md) ·
Issue: [#244](https://github.com/AndreyBegma/AgentDock/issues/244)

## Context

People work on a project in their own Claude Code sessions as well as through
the fleet. In those sessions they notice bugs, name follow-ups and put work off
for later — and that work is lost unless someone writes a card by hand. On
2026-10-14 the product owner decided that a model should read those sessions
and suggest the cards itself, that suggestions land in an Inbox column on the
project Board ([ADR-0024](0024-board-cards-and-dedicated-card-workers.md)), and
that only what is needed is read.

ADR-0021 lets a project ship session content, and says content "is a view
only". Reading it to suggest cards is a new use of it. The server also has no
model key: every model call AgentDock makes is a Claude Code CLI run on a
runner, recorded as a `runs` row.

## Decision

1. **A second switch per project.** `board_settings.captureEnabled` (project
   admin) turns capture on. It can be on only while
   `Project.shipSessionContent` is on (else `422 capture_needs_content`), and
   turning content off turns capture off. Content alone still feeds nothing
   but the view.
2. **Manual sessions only.** Capture reads sessions with `origin = manual` in
   such a project. Worker, run, card worker, planner and extraction sessions
   are never read, so an extraction never reads another extraction.
3. **The least content that works.** Only `prompt` rows (first 2 KiB) and
   `response` rows (last 1 KiB), never tool input or output; only rows after the
   session's watermark (the last extraction's `contentToId`), so no content is
   sent twice; newest first, at most 24 KiB; plus the titles of up to 100 open
   cards, for dedupe. Under 300 characters of new content, nothing runs.
4. **A small model on the project's own runner.** The extraction is the typed
   command `cards.extract` ([ADR-0010](0010-typed-command-allowlist-on-the-runner.md)):
   headless `claude -p` with `haiku` by default (`sonnet` allowed),
   `--permission-mode plan`, no tools, the prompt on stdin, in a run directory
   outside every watched root. The runner it runs on is the machine the
   content came from, so content does not travel to a second machine. The
   environment carries `AGENTDOCK_HOOKS=off`, which makes
   `agentdock-runner hook` exit at once: the extraction's own session ships no
   content and triggers no capture. Each extraction is a `runs` row of kind
   `card_capture` (trigger `capture`), priced from the price table
   ([ADR-0009](0009-api-equivalent-cost-from-a-versioned-price-table.md)) through the
   Claude session id the API assigns it.
5. **A fixed output contract, applied all or nothing.** The model answers with
   exactly one `agentdock-cards` block of at most 5 cards whose evidence ids
   must be in the input. A violation applies nothing. The prompt is fixed, not
   editable.
6. **Suggestions are content.** Inbox cards are derived from content, so
   ADR-0021 §5 applies to them: only operators and above see the Inbox and its
   notification; evidence excerpts (at most 300 characters each) appear only in
   the card sheet and are stripped on Accept; a content purge deletes Inbox
   cards and capture rows; Inbox cards past the content retention are deleted;
   the stored model result is deleted with content retention.
7. **A person decides.** A suggestion becomes a card in To Do only when a
   person accepts it. Dismissing records the title's fingerprint so the same
   suggestion is not made again for 90 days. Nothing is accepted automatically.

## Consequences

- Prompts and responses of manual sessions reach a model. They already reach
  one — the session's own — and the extraction runs under the same Claude
  account on the same machine; the setting's help text says this plainly.
- Each extraction costs tokens. Limits bound it: one running extraction per
  project, 48 per project per day, one per session per 30 minutes, none while
  the Inbox holds 30 cards, and a project budget's hard stop skips it.
- Codex sessions are not read: their content does not come through hooks.
- Rejected:
  - **Extract on the server.** There is no model key on the server, and adding
    one would send content to a second place.
  - **Read transcripts or OTel.** ADR-0021 §3 keeps both content-free.
  - **Tool input and output.** Large, most likely to hold secrets, and not
    needed to find the person's intentions.
  - **Auto-accept above a confidence.** A wrong card in To Do costs a worker
    run; a wrong card in the Inbox costs a click.
