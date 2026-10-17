# C-135: Security [Low]: Pin runner-reported URLs to https://github.com in shared contracts and on ingest

> Security audit 2026-10-16 · **WI-33** · severity **Low** · size **M** · findings: L-01 (Z3 F9, P2-3, Z4 D-03, Z7 L2, Z8 W8-04, Z6 W-7, Z9 L1, P2-05)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-01.** Runner-reported URLs accept any scheme and host. `z.url()` admits `javascript:`, `data:` and `file:`: `packages/shared/src/protocol/events/fleet.ts:180,207,295`, `events/queue.ts:32,47`, `commands/approvals.ts:58` (plain `z.string()`), `:71`; `projects.ts:80,129` take any string. The checkpoint helpers match `https?://\S+` (`packages/shared/src/fleet/checks.ts:51`) and `isUrl` in `fleet/code-sentinel.ts:44`.

**Attacker.** A compromised runner, or an agent that writes the fleet's checkpoint text.

**Scenario.** A PR or issue link with a hostile scheme or a look-alike host is stored and shown as a link in the web, Telegram and outbound webhooks.

**Impact.** Phishing or script links in trusted UI; React 19 blocks `javascript:` in the web, but not in Telegram or webhooks.

## Fix
- Add a shared `httpsGithubUrl` schema: `https` scheme only, hostname exactly `github.com`.
- Use it in `events/fleet.ts`, `events/queue.ts`, `commands/queue.ts`, `commands/approvals.ts`, `projects.ts` and the `local.ts` results.
- Fix `fleet/checks.ts` and `fleet/code-sentinel.ts` to the same rule.
- Re-validate in the queue and fleet projectors and drop the field (not the event) when it fails.

## Acceptance criteria
- Schema tests reject `javascript:alert(1)`, a `data:` URL, `http://github.com/o/r/pull/1` and `https://github.com.evil.example/o/r`, and accept `https://github.com/o/r/pull/1`
- A projector test: an event with a bad URL is stored without the URL
- Checkpoint parsing tests: a non-github URL is not taken as the PR URL

## Touches
- packages/shared/src/protocol/**
- packages/shared/src/fleet/checks.ts
- packages/shared/src/fleet/code-sentinel.ts
- apps/api/src/queue/*projector*
- apps/api/src/fleet/*projector*

## Decision
none needed

## Must not run in parallel with
- WI-34
- WI-37


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
