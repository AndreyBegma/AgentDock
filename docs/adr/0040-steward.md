# ADR-0040: Steward — the runner watches agent sessions, the API decides, safe fixes are automatic

Status: accepted · Date: 2026-10-16 ·
Issue: [#447](https://github.com/AndreyBegma/AgentDock/issues/447) ·
Spec: [`docs/specs/447-steward.md`](../specs/447-steward.md)

## Context

Stuck agent work was caught by a person watching terminals:
- network-interrupted responses;
- dialogs and permission prompts;
- dead sessions;
- commits with attribution trailers;
- duplicate issues;
- silent stalls.

The orchestrator watches fleet slots, but nothing watches Board cards and runner runs, and the watching dies with the terminal that runs it.

## Decision

1. **The runner observes and acts locally** (ADR-0001). It reads panes and transcripts, classifies stalls by rules, and uses a local haiku only for an unknown stall. Nudge, dismiss and resume are typed, capability-gated commands (ADR-0010).
2. **The API decides and reports.** It owns the incident lifecycle, the per-incident notification dedupe, the settings and the digest (BullMQ, ADR-0015).
3. **Only safe actions are automatic, each limited per round and switchable per project:**
   - nudge after an API or network error;
   - dismiss a dialog from a fixed list;
   - resume a dead session in its own worktree.

   Steward never answers a permission prompt, never merges, never edits code, and never resumes a round a person stopped.
4. **The fleet is observe-only** (ADR-0005). Steward escalates for slots and includes them in the digest, but sends them no command.
5. **Session content stays on the machine** unless the project opted in (ADR-0021). The API stores the kind, a one-line reason and the actions taken.
6. **The runner refuses to push a card commit that carries a Claude attribution trailer**, and a card can be linked to an existing issue so Run creates no duplicate.

## Consequences

- One more runner loop over panes and transcripts, reusing the card poll of #435.
- Wrong automatic actions are bounded by the limits and the switches. Every action is visible in Activity.
- Chat and team roles are left for the cloud version.
