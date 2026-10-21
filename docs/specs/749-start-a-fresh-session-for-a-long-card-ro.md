# Sessions: a long card session restarts fresh from its handoff, and the 1-hour cache TTL goes under A/B

Issue: #749 · Epic: [#745](745-token-economy.md) · Lead: #746 (measurement and A/B flags) · ADR: [ADR-0074](../adr/0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md) §7

## Summary

A card round resumes the card's Claude session (`cardSessionFlags`, `apps/runner/src/cards/launch.ts:66`) unless Context handoff picks a fresh start [Confirmed]. Context handoff is #449, ADR-0042, run as card C-92. It has shipped and is on whenever Token saver is on (`handoffOn`, `apps/runner/src/handoff/service.ts:109`) [Confirmed].

Its restart rule, #449 D3, prices only the **first** turn (`decideRestart`, `apps/runner/src/handoff/restart.ts:37`) [Confirmed]:
- resume = history × 0.1 while the cache is warm, × 1 when it is cold;
- fresh = the seed's tokens.

A large history that is still warm therefore keeps resuming, even though every later turn of the round re-reads it. A cold resume also rewrites the whole history as a cache write: 1.25× on 5-minute writes, 2× on 1-hour writes [Reported, platform prompt-caching docs].

This issue adds a size rule on top of D3. When the history reaches a threshold, the next round starts a fresh session seeded with the existing handoff (note, diff, checklist, card prompt) whenever a seed is possible. Below the threshold, D3 decides as today. The rule is A/B technique `resume-by-size`.

It also puts the 1-hour prompt-cache TTL behind A/B. #663 already sets `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` for every card and CI-fix round with Token saver on (`apps/runner/src/launch/token-saver.ts:145,161,375`; spec 663 D12) [Confirmed]. Under technique `cache-ttl-1h`, the control arm pins `5m`.

## Scope

### In
- Card and CI-fix rounds (`runKind: 'card'`) with Token saver on.
- The size rule in the restart decision, reusing #449's note, seed, recording and "old session kept" unchanged.
- The TTL env per arm.

### Out
- A new handoff format, note lifecycle, UI chip or API field. #449 has them all: `restartMode`, `restartEstimate`, warm-up, `resumed from handoff · saved ≈ $x`.
- Design, Planner and terminal sessions. Their handoff stays as #449 and #494 define it, and their TTL stays as today.
- Subagent TTL. `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` is not set; scout and `Explore` stay on Claude Code's default.
- Per-arm metrics and the dashboard (#746). Model and effort (#750).

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Card rounds by size: a short session continues with `--resume` as today; above a threshold, a fresh session with a compact handoff (done, diff, decisions, open items). The threshold is tuned by A/B | person, 2026-10-21 (Q-rounds) |
| D2 | **The compact handoff is #449's**: the note's fixed sections (Goal, Done, Next, Decisions and why, Dead ends, Files touched, How to verify, Checklist status, Open questions), plus the diff summary, the checklist and the round-1 card prompt (`freshSeed`, `apps/runner/src/handoff/seed.ts`). Nothing new is built | #449 D3, D5; ADR-0042; card C-92 |
| D3 | **Rule:** with `resume-by-size` on, the history (`TranscriptStats.historyTokens`) is at least `RESUME_BY_SIZE_TOKENS`, and a seed exists, the mode is `fresh` whatever the cache. Otherwise #449 D3 decides unchanged. With no seed (no valid note, no saved card prompt, a seed that does not fit), it resumes, as D3 already does. The old session stays recorded | spec, on D1 and #449 D3 |
| D4 | **Default threshold: 60,000 tokens of history.** Reasoning: a seed is about 5-15k tokens (note ≤ ~3k, diff ≤ 300 lines, checklist, card prompt). At 60k, a warm resume re-reads about 6k-equivalent on **every** turn of the round, against about 1-1.5k for the seed, so a round of three or more turns is cheaper fresh. A cold resume costs at least 75k-equivalent in cache writes. Compaction is at 150k (`COMPACT_AT_TOKENS`) | spec; tuned by A/B (D1) |
| D5 | 1-hour prompt-cache TTL for card sessions, under A/B; other sessions keep 5 minutes | person, 2026-10-21 (Q-ttl) |
| D6 | **TTL mechanics.** `cache-ttl-1h` on, or absent: `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`, as today. Off: `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`, set explicitly. [Confirmed] in the installed Claude Code 2.1.306: the resolution order is `FORCE_PROMPT_CACHING_5M` → env `CLAUDE_CODE_PROMPT_CACHE_TTL` → setting `promptCacheTtl` → agent frontmatter → `ENABLE_PROMPT_CACHING_1H` → automatic. Automatic is "1 hour on a Claude subscription within its usage limits, 5 minutes on an API key", so leaving the variable unset would not give a 5-minute control. The research's `promptCacheTtl` [Reported] exists as a settings key; the env wins over it, and the launch uses the env | person (D5); installed CLI |
| D7 | **A key that is absent means behaviour as before this issue**: no size rule, and 1h. Non-card launches never get the keys | spec (compatibility) |
| D8 | #449's warm/cold test already reads the TTL from the transcript (`cacheTtlMs`: 1h when the session wrote 1-hour cache, `restart.ts:21`). With the 5m arm, the cache counts as cold after 5 minutes, without a change | #449 open question; [Confirmed] code |

## Data / Schema

None. `board_card_rounds.restartMode` and `restartEstimate` record the decision and both estimates already (#449). The arm per card is #746's. i749-restart adds the keys `resume-by-size` and `cache-ttl-1h` to #746's registry (`packages/shared/src/token-economy/techniques.ts`), default mode `ab` (ADR-0074 §7): while the test runs, arm A cards of `cache-ttl-1h` use the 5-minute TTL. `restartEstimateSchema` is strict (`packages/shared/src/handoff/contracts.ts:44`), so the threshold is **not** added to it: a new runner would break an older API.

## API

None. `card.run`'s `tokenSaver.techniques` comes from #746, with keys `resume-by-size` and `cache-ttl-1h`.

## Configuration

- Runner constant `RESUME_BY_SIZE_TOKENS = 60_000` in `apps/runner/src/handoff/restart.ts`.
- Launch env `CLAUDE_CODE_PROMPT_CACHE_TTL`, `1h` or `5m`, for `runKind: 'card'` only. It is Claude Code's variable, not a Nautelle one, so `.env.example` does not change.

## Acceptance criteria

- [ ] **Size rule** (`restart.spec.ts`):
  - with `resume-by-size` on, a warm session of 60,000 history tokens and a valid seed starts `fresh`;
  - 59,999 tokens follow #449 D3 (warm with a small seed → `resume`);
  - with no seed it resumes;
  - with the flag off or absent, every existing #449 D3 test passes unchanged.
- [ ] **Recording:** a fresh start by size records `restartMode: 'fresh'` and both estimates on the round, and keeps the previous session id resumable (`service.spec.ts`).
- [ ] **Seed:** a fresh start's first prompt contains the note, the diff summary, the checklist and the card prompt, exactly as #449's fresh seed.
- [ ] **TTL:**
  - a card launch with `cache-ttl-1h` true or absent has `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`;
  - false gives `5m`;
  - a non-card launch has neither (`token-saver.spec.ts`).
- [ ] **TTL live check:** on the installed CLI, a round in each arm writes cache of the expected TTL, `cache_creation.ephemeral_1h_input_tokens` > 0 only in the 1h arm (transcript usage).
- [ ] `docs/guides/context-handoff.md` explains the size rule and its default. `docs/specs/449-context-handoff.md` and `docs/specs/663-token-saver-v2.md` get an amendment line pointing to this spec.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i749-restart | size rule, flag read from `args.tokenSaver.techniques`, tests, guide and the 449 amendment | apps/runner/src/handoff/restart.ts, apps/runner/src/handoff/restart.spec.ts, apps/runner/src/handoff/service.ts, apps/runner/src/handoff/service.spec.ts, packages/shared/src/token-economy/techniques.ts, docs/guides/context-handoff.md, docs/specs/449-context-handoff.md | #747 merged (chain order; `tokenSaver.techniques` in `cardRunArgsSchema` comes from #746 before it) | yes | opus |
| i749-ttl | TTL per arm in the launch helper, the live check, the 663 amendment | apps/runner/src/launch/token-saver.ts, apps/runner/src/launch/token-saver.spec.ts, docs/specs/663-token-saver-v2.md | #747 merged (i747-launch owns the same files first) | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/runner/src/launch/token-saver.ts, token-saver.spec.ts | #747 i747-launch first, then i749-ttl; then #751 i751-runner | do not open them |
| docs/specs/663-token-saver-v2.md | #747 i747-launch first, then i749-ttl | append amendment lines only |
| apps/runner/src/handoff/** | i749-restart | do not open them. #750 i750-runner-web adds the forced-fresh branch to `service.ts` after this merges |

## Risks

- **High: a fresh start loses what the old session knew, and the round re-explores.** Mitigations:
  - #449's fixed sections include Decisions and Dead ends;
  - the old session stays resumable;
  - #449's warm-up metric and #746's quality signals (rounds per card, retries) per arm show it;
  - a worse signal rolls the technique back (person, Q-quality).
- **High: no note, so no fresh start ever happens.** [Confirmed] The API builds the round-1 prompt without `tokenSaver` (`apps/api/src/board/board-rounds.service.ts:610-654`), so workers are never asked to keep `.agentdock/handoff.md` (`HANDOFF_NOTE_PATH`). Notes then come only from #449's Stop refresh request and the haiku fallback. Mitigation: #747's open question fixes the prompt flag; this issue's live check confirms that notes exist before the arm is judged.
- **Medium: the 1h arm costs more per write (2× against 1.25×)** [Reported prices]. Mitigation: that is what the A/B measures; #746 records cache writes split by 5m and 1h.
- **Medium: a profile env carrying `FORCE_PROMPT_CACHING_5M` defeats the 1h arm silently.** Mitigation: the measured 5m/1h write split per round (#746) exposes it. i749-ttl documents it in the guide.
- **Low: the threshold is wrong for some projects.** Mitigation: tune by A/B; the rule is one constant.

## Open questions

- **How the threshold is tuned.** A boolean arm tests rule on against off, not two thresholds. Default: the runner constant changes by release after a report; no project setting now.
- **A fresh start by size inside a warm, short gap** (a CI-fix round seconds after the last). Default: the rule applies anyway; size, not time, is the person's criterion.

Depends on #747
