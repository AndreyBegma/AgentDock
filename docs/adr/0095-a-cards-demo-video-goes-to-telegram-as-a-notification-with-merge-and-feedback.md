# ADR-0095: A card's demo video goes to Telegram as a notification with Merge and Feedback

Status: accepted · Date: 2026-10-24 ·
Spec: [`docs/specs/card-372-demo-videos-send-a-ready-demo-to-telegra.md`](../specs/card-372-demo-videos-send-a-ready-demo-to-telegra.md) ·
Relates to: [ADR-0090](0090-a-finished-card-may-carry-a-demo-video-recorded-by-demoflow-on-the-runner.md), [ADR-0046](0046-the-telegram-bot-acts-on-the-board-through-a-command-router.md), [ADR-0064](0064-a-dependent-card-branches-from-its-dependency-with-a-stacked-pr.md), [ADR-0014](0014-server-originated-events-live-in-events.md) ·
Card: C-372 (stack S-12, stage 2)

## Context

ADR-0090 records a demo video of a finished card and keeps a per-project
switch, `demoTelegram` (on by default), that says a ready video also goes to
Telegram. Nothing sent it. The person reviewing a card from their phone had to
open the web app to watch the demo and to merge or answer it.

Three constraints shape how it is sent:

- The Telegram Bot API accepts an upload of at most 50 MB from a bot. A demo
  video may be up to 100 MiB (ADR-0090).
- The API cannot decode a video: its image ships production dependencies only
  and has no ffmpeg (ADR-0079), and the runner uploads the video without a
  poster frame.
- Merge from Telegram must be the web's Accept: the same permission check, the
  same policy checks, and the stacked base check of ADR-0064. Feedback must
  become the card's next round, as on the web.

## Decision

1. **A demo is a notification.** When a demo becomes `ready`, or `failed`,
   and the project's `demoTelegram` is on, `CardDemosService` records the
   server event `card.demo` (`cardId, number, title, round, demoId, status,
   reason, size`; deduplicated per demo). It maps to a new notification kind,
   `card.demo`, that is Telegram-only and limited to operators and admins
   (`operatorsOnly`). It therefore follows the existing rules, mutes, rate
   limit, retries and delivery ledger. A person not linked to Telegram gets no
   row. The event name shares a word with the runner's typed `card.demo`
   command (ADR-0090); events and commands are separate registries.
2. **The delivery sends the demo itself.** `TelegramDemoService` turns a
   `card.demo` notification into its message. At delivery time it checks
   again that the person may act on the project (`write`), then:
   - a ready video of at most 50 MB goes as `sendVideo` with a plain caption:
     `C-<n> demo: <title>`, the PR number and CI state, the project, and a
     link to the card when no Open card button can carry it. Within one
     delivery pass a video is uploaded once and then resent by the `file_id`
     Telegram returned;
   - a ready video over 50 MB goes as a text message with the same facts, the
     video's size and the Open card button (or the link);
   - a failed demo goes as one plain line, `C-<n> demo failed: <reason>`,
     without a video or buttons.
   When the card, the video or the permission is gone, the plain notification
   is sent instead.
3. **The buttons are the card actions of #578.** Merge is the card's
   `accept` callback, shown only with a pull request and while Accept is
   allowed. A press asks for confirmation, names the stacked target when the
   pull request is based on another card's branch, and merges through
   `BoardService.accept`, so the web's permission, policy and live-base checks
   apply. A refusal because the base was merged is said in words. Feedback is
   the card's `feedback` callback: a forced reply that becomes the next round.
   Open card is the Mini App button (ADR-0055) when the app URL is `https`.
4. **No first frame over the limit, for now.** The card asked for the first
   frame as a photo above 50 MB. The API cannot make one (see Context), so the
   text message stands in for it. A poster frame made by the runner next to
   the video is the follow-up that lets the bot send the photo.

## Consequences

- A person who can act on the project and is linked to Telegram can watch a
  demo, merge it or send feedback without opening the web app. Viewers and
  people not linked get nothing.
- A notification rule or mute on `card.demo` turns the demo messages off for
  one person; `demoTelegram` turns them off for the project.
- A WebM demo is sent with `sendVideo` too; Telegram may show it as a file.
- Over 50 MB there is no picture until the runner sends a poster frame.
- Rejected:
  - **A separate sender outside the notification pipeline.** It would repeat
    the linking, rules, rate limit and retries the pipeline already has.
  - **Decoding the first frame in the API.** It needs ffmpeg in the API
    image, against ADR-0079.
  - **A new Merge action.** It would duplicate the checks of Accept; the
    existing `accept` → confirm → merge path already has them.
