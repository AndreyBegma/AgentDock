# C-236: Add an LLM provider gateway with encrypted keys and per-provider caps

Issue: #598

## What to do
Add the server-side foundation every AI feature uses. Until now, model work has run only through the runner (ADR-0019, ADR-0020), and ADR-0040 defers chat to a cloud version.

**ADR.** Record a new ADR: `apps/api` calls LLM providers directly for assistant features. It amends the chat deferral in ADR-0040; runner-driven work stays as it is.

**Gateway module** `apps/api/src/llm/`:
- One provider interface with streaming, tool calls, image input and usage reporting.
- Adapters: Anthropic (`@anthropic-ai/sdk`), OpenAI, xAI Grok and OpenRouter. Grok and OpenRouter are OpenAI-compatible.

**Provider keys** are set on a new admin-only settings page built with glass-ui (ADR-0011). Protect them as strongly as practical:
- AES-256-GCM encryption with a random IV per value and a master key from a new `LLM_SECRETS_KEY` env variable (32 bytes, base64). Document it in `apps/api/.env.example`.
- The gateway refuses to start when the master key is missing or malformed.
- Keys are write-only: the API returns only a masked suffix (last 4 characters) and an updated-at time.
- An admin can set, replace, test and delete a key.
- Keys are redacted from logs and errors.
- Every key change is recorded as an event (ADR-0014) without the value.

**Model registry.** Enabled models per provider and an instance default model. Prices go into the versioned price table (ADR-0009).

**Usage ledger.** Every call records the user, provider, model, tokens, cost and a feature tag (`assistant`, `digest`, `summary`, `search`, `triage`, `title`).

**Caps.**
- Each provider has its own monthly cap: Anthropic $200 by default, every other provider 0, which means disabled.
- Once a provider reaches its cap, calls to it fail with a typed `llm_cap_reached` error until 00:00 UTC on the 1st of the next month.
- The settings page shows this month's spend.

## Acceptance criteria
- [ ] A new ADR records direct LLM calls from the API and amends ADR-0040.
- [ ] All four adapters implement one interface with streaming, tool calls and usage, and have unit tests with mocked HTTP.
- [ ] Keys are encrypted with `LLM_SECRETS_KEY`. A test asserts the raw key never appears in a response, a log line or an event.
- [ ] A non-admin gets 403 on every key or settings endpoint.
- [ ] The admin page can set, test and delete keys; enable models; set the default model and the caps; and show this month's spend.
- [ ] Every call writes a usage row priced from the price table.
- [ ] Calls fail with `llm_cap_reached` once the cap is reached, until the UTC month resets. A test covers the boundary.
- [ ] Providers other than Anthropic stay disabled until they have a non-zero cap.

## Out of scope
- The assistant, its conversations and its UI.
- How the Planner, workers or Steward pick models.
- Per-user caps.

## Open questions
None.
