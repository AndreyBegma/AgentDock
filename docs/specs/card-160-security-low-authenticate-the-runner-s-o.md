# C-160: Security [Low]: Authenticate the runner's OTLP receiver

> Security audit 2026-10-16 · **WI-58** · severity **Low** · size **S** · findings: L-30 (Z5 L1)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-30.** The OTLP receiver listens on `127.0.0.1` (`apps/runner/src/otlp/receiver.ts:18,220-221`) with no authentication and no `Host` check; Claude Code is pointed at it through `OTEL_EXPORTER_OTLP_ENDPOINT` (`apps/runner/src/setup/claude.ts:34`).

**Attacker.** Another local user on a shared machine, or a web page using DNS rebinding.

**Scenario.** The attacker posts forged OTLP records to the port.

**Impact.** Forged usage and cost data in AgentDock (budgets and hard stops act on it).

## Fix
Generate a per-boot random token and inject it through `OTEL_EXPORTER_OTLP_HEADERS` for the sessions the runner launches and in the setup it writes; the receiver answers 401 without it. Refuse a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. Cap records per request.

## Acceptance criteria
- Receiver tests: a POST without the header gives 401; a foreign `Host` gives 421 (regression tests).
- A setup test shows the header is written next to the endpoint.
- Records over the per-request cap are refused with 413.

## Touches
- apps/runner/src/otlp/receiver.ts
- apps/runner/src/otlp/*.spec.ts
- apps/runner/src/setup/claude.ts
- apps/runner/src/setup/*.spec.ts

## Decision
none needed

## Must not run in parallel with
- WI-60


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
