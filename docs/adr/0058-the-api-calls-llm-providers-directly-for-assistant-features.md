# ADR-0058: The API calls LLM providers directly for assistant features

Status: accepted · Date: 2026-10-17 ·
Card: C-236 (stack S-3, stage 1) ·
Issue: [#598](https://github.com/AndreyBegma/AgentDock/issues/598) ·
Spec: [`docs/specs/598-add-an-llm-provider-gateway-with-encrypt.md`](../specs/598-add-an-llm-provider-gateway-with-encrypt.md) ·
Amends: [ADR-0040](0040-steward.md) (Consequences, "Chat … left for the cloud version") ·
Keeps: [ADR-0019](0019-planner-instructions-live-in-agentdock.md), [ADR-0020](0020-claude-code-integration-through-the-runner.md)

## Context

Until now every model call in AgentDock has run on a runner: the Planner,
card workers, the assessment `haiku`, Steward (ADR-0019, ADR-0020, ADR-0032,
ADR-0040). The control plane itself never spoke to a model provider, and
ADR-0040 left chat for a cloud version.

Stack S-3 adds a multi-provider assistant to the web app and Telegram, a
daily digest, one-click summaries, natural-language Board search and triage
hints. None of these read a project's files — they work on what the API
already stores — and they must answer when no runner is online. Running them
through a runner would tie a chat reply to a machine being awake and would
spend the person's Claude Code subscription on a feature the instance owns.
Several providers are wanted (Anthropic, OpenAI, xAI Grok, OpenRouter), each
paid with its own API key and bounded by its own budget.

## Decision

1. **The API calls providers directly for assistant features.** `apps/api`
   holds one LLM gateway (`src/llm/`) and every assistant feature calls models
   through it — the assistant, digest, summaries, search, triage and titles.
   Runner-driven work does not change: the Planner, card workers, Steward and
   the assessment still run on the runner with the runner's runtime (ADR-0019,
   ADR-0020). The gateway never reads a project's filesystem (ADR-0001); what
   it sends a provider is what the API already stores or what the person typed.
   This amends ADR-0040's deferral of chat to a cloud version.
2. **One provider interface.** An adapter streams text, returns whole tool
   calls, accepts images (base64) and reports usage in the price table's token
   buckets (ADR-0009). Anthropic goes through `@anthropic-ai/sdk`; OpenAI, xAI
   Grok and OpenRouter share one chat-completions adapter over `fetch`, since
   they speak the same protocol. Testing a key is a call that costs nothing
   (the provider's model or key listing).
3. **Provider keys are write-only and sealed.** An admin sets, replaces, tests
   and deletes a key on Admin › AI providers. A key is sealed with AES-256-GCM,
   a random 12-byte IV per value (`SecretCipher`'s `v1` format), under a master
   key from `LLM_SECRETS_KEY` — 32 bytes, base64, separate from
   `APP_ENCRYPTION_KEY` so either can be rotated or lost alone. The API returns
   only the key's last four characters and when it was set; the plaintext is
   opened only for the duration of one provider call. Provider error text is
   redacted (the key itself, and anything shaped like a key or bearer token)
   before it is thrown, logged or returned.
4. **Without a usable master key the gateway does not start.** A missing or
   malformed `LLM_SECRETS_KEY` is logged once at start-up; every call and every
   key route then answers `llm_gateway_unavailable` (503) and the settings page
   says why. The rest of the API runs on: a missing AI key must not take down
   the control plane, the same trade ADR-0033 made for DeepL.
5. **Key changes are audit events.** `llm.key_set`, `llm.key_deleted`,
   `llm.key_tested`, `llm.provider_updated` and `llm.default_model_set` are
   written to the hash-chained audit log (spec 8) with the key's suffix, never
   its value. They are not `events` rows: ADR-0014 anchors a server event on a
   project's runner and says an event about no project needs a new decision;
   a provider key belongs to the instance, and the audit log is where the
   instance's admin changes already live.
6. **Model registry.** Each provider has a list of enabled models, and the
   instance has one default model, which must be enabled. A model can be
   enabled only when the current price table prices it: prices stay in the
   versioned table of ADR-0009 (Admin › Prices), never in the registry.
7. **Usage ledger.** Every call that reaches a provider writes one
   `llm_calls` row when it ends — success, failure or abort — with the user it
   was made for, the provider, the model, the feature tag (`assistant`,
   `digest`, `summary`, `search`, `triage`, `title`), the token buckets and the
   cost from the current price version. A call refused before it is sent writes
   nothing.
8. **Per-provider monthly caps in UTC.** Each provider has a cap in USD per
   calendar month in UTC: Anthropic starts at $200, every other provider at 0,
   which means disabled — a provider with a key and models still refuses
   (`llm_provider_disabled`) until an admin sets a cap above 0. Before a call,
   this month's spend of the provider (the sum of its `llm_calls.costUsd` since
   00:00 UTC on the 1st) is compared with the cap; at or above it the call fails
   with `llm_cap_reached` (429) and `resetsAt`, 00:00 UTC on the 1st of the next
   month. A call that starts under the cap may finish over it; the next one is
   refused.

## Consequences

- Assistant features work with every runner offline, and their spend is real
  provider money, metered per provider and per feature on the settings page.
- Two cost ledgers exist: `llm_requests` (runner sessions, API-equivalent cost)
  and `llm_calls` (gateway calls, money actually spent). Both are priced by the
  same price table.
- The instance now holds third-party API keys. Their protection rests on
  `LLM_SECRETS_KEY` staying out of the database and its backups.
- Caps are per provider and per instance. Per-user caps and how runner-side
  roles pick models are out of scope and need their own decisions.
