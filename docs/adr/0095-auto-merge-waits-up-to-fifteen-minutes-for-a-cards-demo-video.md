# ADR-0095: Auto-merge waits up to fifteen minutes for a card's demo video

Status: accepted · Date: 2026-10-24 ·
Card: C-370 (stack S-12, stage 2) ·
Spec: [`docs/specs/card-370-demo-videos-record-automatically-when-a.md`](../specs/card-370-demo-videos-record-automatically-when-a.md) ·
Amends: [ADR-0090](0090-a-finished-card-may-carry-a-demo-video-recorded-by-demoflow-on-the-runner.md) §1 and §8 ·
Relates to: [ADR-0035](0035-a-card-ships-itself.md), [ADR-0084](0084-a-card-passes-its-review-steps-before-finished.md), [ADR-0001](0001-control-plane-and-per-machine-runner.md)

## Context

ADR-0090 records a demo video of a feature card once its CI is green, and says
that Finished and merge never wait for it. With auto-merge on, a card is merged
the moment its checks pass — the same moment its demo is asked for — so the
person never gets to watch the feature before it lands. The card says the merge
should wait for the demo, briefly, and that nothing else may: the card still
moves to Finished on time, and a demo that fails or never ends is only a warning.

The Board must also decide *when* a card is "a UI card" without reading the
project's filesystem (ADR-0001), and must not record the same head twice when
the poller reads a green PR every minute.

## Decision

1. **Trigger.** The Board's shipping check (ADR-0035) asks for an `auto` demo
   when a `feature` card's PR head is the one that ships: green, after the
   review steps of ADR-0084, as the card moves to (or sits in) Finished. A
   Finished card that is not merged automatically — merge policy `ask`, a
   protected path — is still recorded once its head reads green. Bugs, a card
   that needs a person, and projects with demo videos off get none.
2. **UI card, from the PR.** The changed files come from `pr.inspect` on the
   project's runner, matched against `demoUiPaths` with a small glob matcher in
   `packages/shared` (`**`, `*`, `?`). A PR whose files touch no UI path is
   remembered per head in memory, so the poll does not ask again. When the file
   list cannot be read, the demo row is created `skipped` with the reason.
3. **One demo per head.** `card_demos.headSha` holds the head a demo records.
   An `auto` demo is created only when the card has no demo of that head, so a
   poll never queues a second one and nothing retries a skipped or failed demo.
4. **Supersede.** When the shipping check reads a new head on an open PR, every
   queued or recording demo of an older head is `skipped` with "Superseded by
   the newer head …". The new head gets its own demo once it ships.
5. **Skip, never retry.** Before sending `card.demo`, the API checks that the
   runner is connected, serves `card.demo`, has it enabled, and advertises
   `cardDemo` in its last capabilities. Otherwise the demo is `skipped` with the
   reason. A runner refusal of `unknown_command`, `disabled`, `unsupported` or
   `busy` is `skipped`; any other error is `failed`; a timeout leaves the demo
   queued for the runner to report on. The runner reports `skipped` (not
   `failed`) when DemoFlow is not ready on its machine.
6. **Auto-merge waits, with a cap (amends ADR-0090 §8).** With auto-merge on,
   a card's merge waits while one of its demos is queued or recording and was
   asked for less than **15 minutes** ago (`DEMO_MERGE_WAIT_MS`). The demo
   ending — `ready`, `failed` or `skipped` — re-checks the card at once; the
   poller keeps reading a Finished green card for the cap plus two polls after
   its last demo, so a demo that never ends releases the merge on time. Finished
   itself never waits, and with merge policy `ask` nothing changes.
7. **"Record again".** `POST /projects/:p/board/cards/:n/demos` works on any card
   with a pull request, in every column but Completed (`409 no_pull_request`,
   `409 card_completed`). It sends `card.demo` like an `auto` demo. A demo still
   queued or recording after 30 minutes (`DEMO_STALE_MS`) is one the runner
   never finished: "Record again" fails it instead of answering
   `409 demo_in_flight`.
8. **Activity.** The API records `card.demo_ready` and `card.demo_failed`
   itself (ADR-0014), once per demo. A failed demo never sets the card's
   `needsPerson`.

## Consequences

- With auto-merge on, a UI card's merge lands up to 15 minutes later than
  before — the time its demo takes, bounded. A person can watch it in between.
- `card.demo` is sent through one service (`DemoRunner`), so the Board's e2e
  world answers it in one place.
- `pr.inspect` runs once per shipping head of a feature card on a project with
  demo videos on.
- A superseded demo the runner already queued may still record; its env fetch
  and upload then answer 409 `demo_not_active`, and the video is discarded.
- The no-UI memo lives in the API's memory: after a restart the next green poll
  reads the PR's files once more.
- Rejected:
  - **Holding Finished for the demo.** The card asked for the opposite; a slow
    runner would hold the Board up.
  - **Reading the diff in the API.** The control plane never reads a project's
    filesystem (ADR-0001); the runner's `pr.inspect` already lists the files.
  - **Waiting without a cap.** A runner that goes offline mid-recording would
    hold the merge forever.
  - **Retrying a skipped demo.** A runner without DemoFlow would be asked on
    every poll; "Record again" is the person's retry.
