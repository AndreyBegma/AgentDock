# finish_card fails for good on a brief runner disconnect (runner_offline)

Issue: #434 · Board card: C-79 · Kind: bug

## What to do
On C-75 the worker called `finish_card` while the runner's connection to the API was briefly down (a staging deploy). The tool answered `runner_offline: the runner is not connected`, the worker reported it and stopped, and the card sat in **Waiting for you** until a person told the worker to call it again (the second call returned `{"number":75,"finished":true}`).

Why: `apps/runner/src/connection.ts` (~L183–207) answers a local request with `runner_offline` at once when the connection is down ("a write is never replayed"). `finish_card` (`apps/runner/src/mcp/tools.ts`, method `card.finish`) inherits that. `card.finish` is idempotent on the API side (`BoardService.finishByWorker`: "A round already finished stays finished").

Fix: `card.finish` (and other idempotent card writes the worker relies on, if any) waits for the connection and retries with backoff — default up to 2 minutes — instead of failing at once. If it still cannot reach the API, the tool's error tells the worker plainly to call `finish_card` again in a minute. Non-idempotent writes keep today's behaviour.

## Acceptance criteria
- [ ] With the connection down for under 2 minutes, `finish_card` succeeds once it reconnects, with no second call (runner unit test with a fake connection and clock).
- [ ] Down for longer: the tool returns an error whose text tells the worker to retry; no duplicate finish on the API.
- [ ] Other local methods keep failing fast with `runner_offline`.
- [ ] Runner tests pass.

## Out of scope
- API-side changes.
