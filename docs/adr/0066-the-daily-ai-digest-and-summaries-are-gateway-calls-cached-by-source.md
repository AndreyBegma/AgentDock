# ADR-0066: The daily AI digest and one-click summaries are gateway calls, the digest skipped and summaries cached by their source

Status: accepted · Date: 2026-10-19 ·
Card: C-242 (stack S-3, stage 4) · Issue: [#658](https://github.com/AndreyBegma/AgentDock/issues/658) ·
Spec: [`docs/specs/658-add-a-daily-ai-digest-and-one-click-card.md`](../specs/658-add-a-daily-ai-digest-and-one-click-card.md) ·
Keeps: [ADR-0015](0015-schedules-run-on-bullmq.md), [ADR-0021](0021-session-content-is-opt-in-per-project.md), [ADR-0059](0059-the-api-calls-llm-providers-directly-for-assistant-features.md) ·
Beside: [ADR-0040](0040-steward.md) (the Steward digest is unchanged)

## Context

ADR-0059 named a daily digest and one-click summaries among the features the
API makes through its LLM gateway, tagged `digest` and `summary` and bounded
by the providers' monthly caps. Issue #658 asks for both: a per-project daily
digest at a time in the project's timezone, sent to Telegram and shown in the
web activity view, separating what got done, what is stuck and what waits for
a person; and Summarize buttons on card detail and on agent sessions, cached
until their source changes and written in the reader's language.

Four things were not decided anywhere:

- A project has no timezone. The Steward digest (#447 D14) reads its time in
  the server's zone.
- Steward's digest already sums up a project's day, written by haiku on the
  runner (ADR-0040, #491). The AI digest must work with every runner offline.
- What happens to a digest the gateway refuses — the cap is reached, no model
  is set. The card says the digest is skipped with an event recorded.
- What "the source changed" means for a cached summary, and what the API knows
  of a PR's review state: it stores the PR's state, its CI and the card's
  column, not GitHub's review decision.

## Decision

1. **The AI digest is its own setting, with its own timezone.**
   `ai_digest_settings` holds `enabled` (default off), `time` (`HH:MM`, default
   `09:00`) and `timezone` (an IANA zone, default `UTC`; the web form starts
   from the browser's zone). A missing row is the defaults. A project admin
   changes it; the change is audited as `project.update` with
   `{ aiDigest: … }` before and after. It is separate from the Steward
   digest, which stays as ADR-0040 and #447 D14 made it: the two answer
   different questions (Steward's is a template written by haiku on a runner
   when one is awake; this one is a gateway call that needs none) and either
   can be on alone.
2. **A BullMQ tick, an occurrence claimed in PostgreSQL** (ADR-0015, the
   Steward digest's pattern). One job scheduler on the `ai-digest` queue ticks
   every minute. An enabled project is due when today's `time` in its
   `timezone` has passed; a time a DST jump skips is read after the jump. The
   occurrence is claimed by inserting `ai_digests (projectId, dueAt)` as
   `pending` — the unique key makes a repeated or concurrent tick a no-op —
   then made, then marked `sent` or `skipped`. A setting saved after today's
   time starts the next day, so switching it on in the afternoon does not
   send at once.
3. **The sections are built from rows; the model writes only the overview.**
   Done: PRs merged and rounds finished in the last 24 hours. Stuck: open PRs
   with failing checks, rounds that failed in the period, open and escalated
   Steward incidents. Waiting: a round that asks the person, a card that
   needs one, a finished card whose PR waits for review, a card new in Inbox.
   Each line links to its PR, else to the card on the web Board (`APP_URL`).
   The default model gets these facts and how the Board moved as JSON,
   without the links, and writes two to four English sentences. So the
   sections and their links are exact, and a model cannot invent a card.
4. **A refused digest is skipped, with an event.** When there is no default
   model, or the gateway refuses (`llm_cap_reached`, `llm_provider_disabled`,
   any `LlmError`), nothing is sent: the occurrence is stored as `skipped`
   with the code, and `ai_digest.skipped` is recorded in `events` (ADR-0014).
   It is not retried that day. A sent digest records `ai_digest.sent` with
   its counts and how many Telegram chats it reached. Both events are curated
   activity items linking to the project's activity page, where the latest
   sent digest is shown in full. Telegram goes to the linked chats of active
   admins and the project's members, as the Steward digest does.
5. **A summary is cached per subject and reader language, keyed by the hash of
   its source.** The source is the text the model reads, built only from
   stored rows: for a card, its fields, its PR (number, link, base, branch),
   CI state and failed checks, a review state derived from the PR state and
   the card's column, and its latest five rounds with their summaries,
   feedback and errors; for a session, its stored content (ADR-0021) as a
   bounded transcript. `ai_summaries (subject, subjectId, language)` keeps the
   text with `sha256(source)`. A request whose source hashes the same is
   served from the row with no call and no `llm_calls` row; a changed source,
   another language or Regenerate makes a new call. The reader's language is
   the browser's primary subtag, sent with the request.
6. **A session summary needs session content.** The route answers
   `summary_no_session_content` (409) unless the project ships content and
   the session has some; the web shows the button only then. Any member may
   summarize, as any member reads content (ADR-0050).
7. **The gateway's refusal is the button's message.** `llm_cap_reached` (429)
   reaches the web unchanged, and the button shows the provider and the day
   its cap resets.

## Consequences

- A digest and a summary are real provider spend, metered per feature on
  Admin › AI providers, and stop at the cap like every other gateway call.
- The review state in a summary is what AgentDock knows, not GitHub's review
  decision: an open PR on a Finished card reads as waiting for a person's
  review. Reading reviews from GitHub would need the GitHub App to fetch them
  and is left for later.
- A digest that crashes between its claim and its result stays `pending` and
  that day's digest is lost; the error is logged. Retrying it would risk two
  provider calls for one occurrence.
- Summaries outlive the content they were made from until their subject is
  deleted; a purge of session content (ADR-0021) leaves the summary text. The
  summary is a few sentences the person asked for, not the content itself.
- Rejected:
  - **Reuse the Steward digest and add a model call to it.** It needs a
    runner for its prose and is on by default with Steward; the card wants an
    opt-in digest that works with every runner offline.
  - **Let the model write the sections.** Links and labels would be the
    model's, unverifiable, and a long day would cost more tokens.
  - **Send a template digest when the cap is reached.** The card asks for the
    digest to be skipped with an event.
  - **Cache summaries by the subject's `updatedAt`.** A card's CI and rounds
    change without touching it, and unrelated edits would bust the cache.
