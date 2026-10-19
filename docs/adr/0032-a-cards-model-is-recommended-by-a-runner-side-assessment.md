# ADR-0032: A card's model is recommended by a runner-side assessment

Status: accepted, amended by [ADR-0068](0068-the-token-saver-targets-context-residency-and-is-judged-by-cost-per-round.md) · Date: 2026-10-15 · Extends [ADR-0027](0027-stored-text-is-normalized-to-english-on-the-runner.md) ·
Issue: [#322](https://github.com/AndreyBegma/AgentDock/issues/322)

## Context

A board card's work round and its design turns run on a model and a Claude
profile that the person does not see when they launch it. On 2026-10-15 the
product owner asked for a profile and a model selector at launch, with the
model defaulting to one recommended after an analysis of the task, shown as
`Opus 5.5 (recommended)`.

The server holds no model key. Every model call is a Claude Code CLI run on
the project's runner, recorded as a `runs` row (ADR-0026, ADR-0027).

## Decision

1. **The recommendation is a `haiku` call on the runner.** It is the typed
   command `card.assess` ([ADR-0010](0010-typed-command-allowlist-on-the-runner.md)),
   advertised by the runner ([ADR-0023](0023-runners-advertise-their-commands.md)).
   It runs exactly as `text.normalize` does: headless, no tools, plan mode,
   prompt on stdin, outside watched roots, hooks off. The API builds the
   prompt and parses the answer. Each call is a `runs` row of kind
   `card_assess`, priced like any other (ADR-0009).
2. **One recommendation per card for work and one for design**, each a model
   alias (`opus`, `sonnet`, `haiku`) and a one-line reason. The rule given to
   the model is the fleet's own: `opus` when the work still has to decide,
   `sonnet` when it executes a clear decision, `haiku` for trivial edits.
3. **Asynchronous and hash-gated.** A card save is never held for it. The
   call is chained after that save's normalization settles, and its answer
   applies only while the card still hashes to what was asked (ADR-0027 D4).
4. **A default, never a constraint.** The launch selector preselects the
   person's remembered choice first, then the recommendation, then the
   project's model. A choice is remembered on the card only when it differs
   from that default. Without a recommendation, launch does not wait. That
   covers an offline or outdated runner, no Claude profile, a budget stop,
   and an answer out of contract.
5. **Aliases are stored; labels are display.** A shared catalog maps each
   alias to its current label (`opus` → `Opus 5.5`). Runs, cards and commands
   keep the alias.

## Consequences

- One `haiku` call per content-changing card save, at most two running per
  project, stopped by a budget's hard stop. No per-project switch yet.
- A runner must be upgraded to advertise `card.assess`; older runners simply
  yield no recommendation.
- Labels can lag behind what an alias resolves to on a given runner until the
  catalog is updated.
- Codex profiles are not offered: card workers and design turns are
  Claude-only.
