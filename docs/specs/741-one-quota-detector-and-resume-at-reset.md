# #741 — One quota detector for every limit banner, and resume a session when its limit resets

Issue: https://github.com/AndreyBegma/Nautelle/issues/741 · Kind: bug · Found by: runner audit, 2026-10-21

## Summary

The runner has two quota detectors that disagree:

- **The Board's detector** is `classifyPane` (`apps/runner/src/collectors/tmux/classify.ts`). It feeds `pane.quota_hit` through `collectors/tmux/sessions.ts`, `collectors/orchestrator/orchestrator.ts` and `control/orchestrator.ts:333`. It matches only the case-sensitive text `QUOTA_MARKER = 'hit your weekly limit'` [Confirmed].
- **The steward's detector** (`apps/runner/src/steward/pane-rules.ts:89-93`) also matches `usage limit reached` and `hit your (session|usage|5-hour) limit`, case-insensitively [Confirmed].

As a result, the Board, notifications and the orchestrator never see the 5-hour or session limit. Neither detector reads the reset time on the banner (`You've hit your weekly limit · resets Mon 9:00am`, `collectors/tmux/__fixtures__/quota.txt`) [Confirmed]. So a session that hit a limit sits idle until a person notices it.

## Scope

### In scope
- One shared detector for every limit banner, plus a parser for the reset time.
- `pane.quota_hit` carries the limit kind and the reset time.
- The runner resumes a session after its limit resets.
- The card or slot shows "waiting for the limit until <time>".

### Out of scope
- Switching to another runtime profile on a limit.
- Codex banners (Codex is not developed further, person 2026-10-21).

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | **One detector.** `classify.ts` exports `detectQuota(text): { kind: 'weekly' \| 'session' \| 'usage' \| 'unknown'; resetsAt: string \| null } \| null`. The patterns are the union of today's two lists, all case-insensitive. `classifyPane` and `pane-rules.ts` both use it, and `QUOTA_MARKER` is removed. | orchestrator, from the audit |
| D2 | **Reset time.** Parse `resets <weekday>? <h>(:<mm>)?(am\|pm)` and `resets in <n> (hours\|minutes)`, plus an optional `(<IANA zone>)` suffix when the banner shows one. Resolve it to the next matching instant in the zone given, or else in the runner's local zone. Emit it as an ISO-8601 UTC string. Text that does not parse gives `resetsAt: null`. | orchestrator |
| D3 | **Event payload.** `pane.quota_hit` gains optional `limit` (D1 kind) and `resetsAt` (ISO string or null). This is an additive protocol change, so older APIs ignore the new fields (ADR-0073). The API stores both on the slot or card projection. The web shows "Waiting for the limit until <local time>", or "Limit reached" when `resetsAt` is null. | orchestrator |
| D4 | **Automatic resume** (person, 2026-10-21: "the runner resumes by itself"). At `resetsAt` + 60 s, the runner checks that the pane still shows the banner, so a person has not already acted. If so, it sends the session `continue` through the existing pane input path (`apps/runner/src/control/tmux.ts`: literal text, then Enter as a separate key). It emits a new event `pane.quota_resumed` and does not try again for that banner. When `resetsAt` is null it does not resume. A daemon restart re-arms the timer from the next pane scan. | person, 2026-10-21 |
| D5 | **Which sessions.** Card sessions and orchestrator `cs-*` slots that the runner watches. Manual terminals are not resumed automatically: they get the event and the display only. | orchestrator, default |

## Acceptance criteria

- [ ] Unit tests for `detectQuota`: the weekly banner (fixture), `usage limit reached`, `hit your 5-hour limit`, and `hit your session limit` are all detected with the right `limit`. The match is case-insensitive.
- [ ] Unit tests for the reset parser: `resets Mon 9:00am`, `resets 2pm`, `resets in 3 hours`, and a banner with `(Europe/Kyiv)` each give the correct UTC instant against a fixed clock. Unparseable text gives `null`.
- [ ] `classifyPane` and the steward give the same quota answer for every fixture (one shared test table).
- [ ] Runner test (fake clock, fake tmux): a card pane with a banner that has `resetsAt` receives `continue` and then Enter exactly once at reset + 60 s, and `pane.quota_resumed` is emitted. A pane whose banner is gone by then receives nothing.
- [ ] API: `pane.quota_hit` with `resetsAt` sets it on the slot projection. The activity title includes the time. Old payloads without the fields still parse.
- [ ] Web: the card or slot shows "Waiting for the limit until <time>", using a glass-ui component (ADR-0011).
- [ ] `bun run check`, `bun run test` and `bun run build` are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i741 | the detector, reset parser, auto-resume, event fields, projection, display | apps/runner/src/collectors/tmux/**, apps/runner/src/collectors/orchestrator/**, apps/runner/src/steward/**, apps/runner/src/control/orchestrator.ts, apps/runner/src/control/tmux.ts, apps/runner/src/quota/**, packages/shared/src/protocol/events/fleet.ts, packages/shared/src/activity/**, packages/shared/src/notifications/**, packages/shared/src/webhooks/**, apps/api/src/fleet/**, apps/api/src/notifications/event-mapping.ts, apps/web/src/** | — | yes | sonnet |

Sonnet: every decision is written down above, and the work follows existing patterns (pane events, slot projection).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/protocol/events/fleet.ts | i741 | #740 changes only the command and result protocol and must not open it |
| apps/runner/src/collectors/tmux/**, apps/runner/src/steward/**, apps/runner/src/control/** | i741 | #740 must not open them |

## Risks

- **Medium: `continue` is typed into a session that a person is using.** Mitigation: D4 re-checks the banner first, and manual terminals are excluded (D5).
- **Low: the banner wording changes in a new Claude Code version.** Mitigation: an unknown wording gives `limit: 'unknown'` with no resume, and the fixtures are easy to extend.

Depends on: nothing.
