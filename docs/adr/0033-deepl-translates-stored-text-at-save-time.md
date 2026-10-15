# ADR-0033: DeepL translates stored text at save time

Status: accepted · Date: 2026-10-15 · Amends [ADR-0027](0027-stored-text-is-normalized-to-english-on-the-runner.md) §3, §4, §7 ·
Issue: [#324](https://github.com/AndreyBegma/AgentDock/issues/324)

## Context

ADR-0027 stores English, translated by a `haiku` call on the project's runner,
asynchronously. A card therefore shows its original language for the first
10–60 seconds, and stays untranslated when no Claude runner is online. On
2026-10-15 the product owner asked that text be English from the moment it is
saved, and provided a DeepL API key.

## Decision

1. **DeepL is the translator when `DEEPL_API_KEY` is set.** The API calls
   DeepL inside the save, within 4 seconds, and the save answers with English.
   This amends ADR-0027 §4 (asynchronous) for the DeepL path.
2. **The runner path is the fallback** (ADR-0027 §3): it handles a DeepL
   timeout, outage, exhausted quota or rejected key, and any deployment
   without a key. ADR-0027 §1, §2, §5, §6 and §8 are unchanged.
3. **Kind is classified by a fixed English keyword rule** when DeepL
   translated; `haiku` classifies only on the runner path. This amends
   ADR-0027 §7.
4. **The key is a server secret**, read from the API's environment only. It
   is not a model key: no agent or model run uses it.
5. **A DeepL call is not a run.** It creates no `runs` row; the
   normalization row records the engine and the characters billed.

## Consequences

- With a key set, saved free text leaves the host for DeepL, a third party.
  The project switch (ADR-0027 §8) turns it off per project; unsetting the key
  turns it off for the deployment.
- Saves that need translation take up to 4 s longer. Usually it is under 1 s.
- The free DeepL tier is 500,000 characters a month; beyond it the runner path
  takes over.
- The keyword kind rule is cruder than a model. A person's choice still wins.
