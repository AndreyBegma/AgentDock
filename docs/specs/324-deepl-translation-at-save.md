# Translate saved text to English at save time with DeepL

Issue: [#324](https://github.com/AndreyBegma/Nautelle/issues/324) ·
Decision: [ADR-0033](../adr/0033-deepl-translates-stored-text-at-save-time.md) (amends ADR-0027)

## Summary

ADR-0027 made Nautelle store English. A save returns the text as typed, and a
`haiku` call on the runner replaces it later, in about 10–60 s. Meanwhile:

- the card shows the original;
- an issue or branch made right away can read it;
- a project without an online Claude runner keeps it as typed.

On 2026-10-15 the product owner asked that a card be English **from the moment
it is created**, using DeepL. This issue makes DeepL the translator. The API
calls DeepL inside the save, so the save's response, the live event and every
later read already hold English. The runner path stays as the fallback.

## Scope

### In scope

- A DeepL client in the API. `DEEPL_API_KEY` is optional, server-side only.
- Every field ADR-0027 §1 normalizes is translated synchronously by DeepL in
  `TextNormalizer.request`:
  - card title and body;
  - round feedback;
  - design comments;
  - plan brief;
  - task review comments;
  - plan-turn messages and answers.
- Owner services return the translated text from the save that triggered it.
- Kind classification for `kindSource = auto` cards by a fixed English keyword
  rule when DeepL translated, so no model call is needed for it.
- The record of which engine translated, and the characters billed.
- `.env.example` files for local and staging.

### Out of scope

- Translating back into the person's language.
- Backfilling rows saved before this change.
- A DeepL glossary.
- Showing DeepL character usage on the Usage page. It is recorded here, and
  display is a follow-up.
- Removing the runner's `text.normalize`. It stays as the fallback.

## Decisions

- **D1 — DeepL first, synchronous.** When `DEEPL_API_KEY` is set, `request()`
  creates the `text_normalizations` row as today. It then calls DeepL **before
  returning**, with a total budget of `TEXT_DEEPL_TIMEOUT_MS = 4000`, and
  applies the result through the existing apply path:
  - field by field;
  - only where the column still hashes to what was asked (ADR-0027 D4);
  - emitting `TEXT_CHANGED_EVENT`.

  Owner services build their response **after** `request()` resolves (a
  re-read of the owner). The `POST` that creates a card answers with the
  English title and body. (Product owner, 2026-10-15.)
- **D2 — Failure never fails the save.** These all leave the text as typed
  and enqueue the existing BullMQ job:
  - a timeout;
  - a network error;
  - `429`, `5xx`;
  - `456` (quota);
  - `403` (bad key).

  The job tries DeepL again with the existing backoff (`TEXT_RUN_RETRIES`).
  If the failure is `456` or `403`, or the retries are spent, it falls back to
  the runner `text.normalize` call (ADR-0027 §3) when the runner advertises
  it. Otherwise the field ends "Not normalized" with the reason, as today.
- **D3 — No key, no change.** Without `DEEPL_API_KEY` the behaviour is
  exactly ADR-0027's. Self-hosters who do not want a third party keep the
  runner path.
- **D4 — The call.** It is one `POST /v2/translate` per save, with every asked
  field as its own `text` entry, and these parameters:
  - `target_lang=EN-US`
  - `tag_handling=xml`
  - `ignore_tags=x`
  - `preserve_formatting=1`
  - `outline_detection=0`
  - `split_sentences=nonewlines`

  Endpoint and auth:
  - The host is `api-free.deepl.com` when the key ends in `:fx`, else
    `api.deepl.com`.
  - The header is `Authorization: DeepL-Auth-Key <key>`.

  [Confirmed against the live API on 2026-10-15: Markdown lists, blank lines
  and `<x i="1"/>` tags survive; the free key's limit is 500,000
  characters/month.]
- **D5 — Masking keeps ADR-0027 §5.**
  - `maskText` runs as today. Each `⟦n⟧` placeholder is sent as
    `<x i="n"/>`, and the rest of the text is XML-escaped (`&`, `<`, `>`).
  - On the way back, tags become placeholders, the text is unescaped, and
    `unmask` restores the spans byte for byte.
  - A field whose answer lost, repeated or invented a tag is `rejected` and
    keeps its original, as today. The other fields of the call still apply.
- **D6 — English detection.**
  - The fixed heuristic (ADR-0027 §6) still skips the call for reliably
    English text.
  - A field whose answer has `detected_source_language = EN` gets outcome
    `already_english`, and its column is not rewritten.
- **D7 — Kind without a model.** When DeepL translated a card whose
  `kindSource` is `auto` and that has not yet run, a pure shared rule
  `classifyCardKindEnglish(title, body)` sets `bug` or `feature`.
  - `bug` when the English title or the first 500 characters of the body
    match a fixed word list: `bug`, `fix`, `broken`, `crash`, `error`,
    `fails`, `failing`, `doesn't work`, `does not work`, `regression`,
    `exception`, `wrong`, `500`, `404`.
  - Otherwise `feature`.

  The ADR-0027 §7 guard is unchanged: it never overwrites a person's choice
  and stops at the first Run. On the runner fallback, `haiku` classifies as
  today.
- **D8 — What is recorded.** `text_normalizations` gains:
  - `engine` (`deepl | runner`, null while pending);
  - `billedChars Int?` (DeepL's `billed_characters`, else the sum of the
    lengths sent).

  A DeepL call creates **no** `runs` row: it is not a model run, and ADR-0009
  prices model runs only.
- **D9 — The key.**
  - `DEEPL_API_KEY` is read from the API's environment only.
  - It is documented, empty, in `apps/api/.env.example` and
    `deploy/staging/env/api.env.example`; staging's `refresh.sh` adds the
    missing key.
  - It is never logged, never returned by any endpoint, never sent to the web
    or a runner.
  - [Done on 2026-10-15: the value is already in the local `apps/api/.env`
    and staging's `env/api.env`.]
- **D10 — Privacy, stated.** With a key set, the saved text leaves the host
  for DeepL. ADR-0033 records this. The project switch
  `text_settings.normalizeEnabled` (ADR-0027 §8) still turns all translation
  off for a project.

## Data / Schema

`apps/api/prisma/schema.prisma`, migration
`apps/api/prisma/migrations/20261123000000_text_normalization_engine/`:

- `enum TextEngine { deepl runner }`.
- `model TextNormalization`: `engine TextEngine?`, `billedChars Int?`.

## API

- `apps/api/src/text/deepl-client.ts`:
  - `DeepLClient.translate(texts, signal)` returns
    `{ text, detectedSourceLanguage }[]` and `billedChars`;
  - typed errors `quota | auth | rate | unavailable | timeout`;
  - `fetch` with `AbortSignal.timeout`; no new dependency.
- `TextNormalizer.request`: the D1 synchronous attempt. `process()` (the job)
  is D2: DeepL again, then the runner.
- The `TextModule` provider list gains `DeepLClient`. `TextModule` stays
  `@Global()` and imported by `AppModule` only.
- Owner services re-read after `request()` before answering:
  - `board.service.ts` (create, update);
  - `board-rounds.service.ts` (feedback);
  - `plan.service.ts`;
  - `plan-turn.service.ts`;
  - `design.service.ts` (comments).
- `DEEPL_API_KEY` is read through `ConfigService` in `TextModule` (it already
  reads its own config there [Confirmed `apps/api/src/text/text.module.ts`]);
  optional string.

## UI

No change. "Show original" and "Not normalized" already exist. A card simply
arrives in English.

## Configuration

| Variable | Where | Default |
|---|---|---|
| `DEEPL_API_KEY` | `apps/api/.env`, staging `env/api.env` | empty: the runner path (ADR-0027) |

## Acceptance criteria

- [ ] With `DEEPL_API_KEY` set (DeepL stubbed in e2e), `POST` a card with a
  Russian title and body:
  - the **201 response** holds the English title and body;
  - `text_normalizations` has `engine = deepl`, `status = done`, and the
    originals;
  - no `runs` row of kind `text_normalize` is created.
- [ ] A body with a fenced code block, an inline `` `path` ``, a URL and
  `#123` comes back with those spans byte-identical.
- [ ] A stubbed answer that drops a tag leaves that field as typed with
  outcome `rejected`. The other field of the same save is translated.
- [ ] A stubbed timeout (> 4 s) answers the save within ~4.5 s with the text
  as typed and enqueues a job. The job, with DeepL now answering, applies
  the translation.
- [ ] A stubbed `456` sends the job to the runner `text.normalize` path. With
  no runner online, the field ends "Not normalized".
- [ ] With `DEEPL_API_KEY` unset, behaviour is identical to today: the
  existing text e2e suites pass unchanged.
- [ ] English input makes no DeepL call (heuristic), and DeepL answering
  `detected_source_language: EN` leaves the column untouched.
- [ ] A card with `kindSource = auto` and the title "Кнопка Run падает с
  ошибкой" becomes `bug`. One whose kind a person set stays as set.
- [ ] `DEEPL_API_KEY` appears in no log line, no API response, and no runner
  command (grep the e2e log and the runner args).
- [ ] `normalizeEnabled = false` makes no DeepL call.
- [ ] `classifyCardKindEnglish` and the XML mask round-trip have unit tests in
  `packages/shared`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i324-api | DeepL client, synchronous path, fallback, schema, shared helpers, env examples | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261123000000_text_normalization_engine/**, apps/api/src/text/**, apps/api/src/board/board.service.ts, apps/api/src/board/board-rounds.service.ts, apps/api/src/planner/plan.service.ts, apps/api/src/planner/plan-turn.service.ts, apps/api/src/design/design.service.ts, apps/api/.env.example, deploy/staging/env/api.env.example, packages/shared/src/text/** | — | yes | opus |

This is honestly **one slot**. The schema change is two columns, the shared
helpers serve only this path, and the API change is one seam in
`apps/api/src/text/` plus a re-read in five services. Splitting it would make
slots that cannot merge on their own.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/src/text/** | i324-api | #322's i322-api is cut **after** #324 merges (it owns the same directory for the normalization-settled seam) |
| apps/api/prisma/schema.prisma | i324-api | #322's i322-contract waits for #324, or appends only its own columns and rebases |

## Risks

- **Medium — the free quota.** 500,000 characters/month. *Mitigation:*
  - the English heuristic skips most saves;
  - `billedChars` is recorded;
  - `456` falls back to the runner.
- **Medium — save latency.** A save can take up to 4 s longer. *Mitigation:*
  the hard timeout and the async fallback; DeepL usually answers in
  200–600 ms [observed 2026-10-15].
- **Low — a crude kind rule.** *Mitigation:* a person's choice wins. #322's
  assessment may refine kind later.
- **Low — third-party data flow.** *Mitigation:* opt-in by key, a
  per-project switch, and ADR-0033 states it.

## Open questions

- **Q1 — Formality / variant.** Default: `EN-US`.
- **Q2 — Translate model-written text too?** Default: no (ADR-0027 §1 is
  unchanged).

Depends on #271 (closed)
