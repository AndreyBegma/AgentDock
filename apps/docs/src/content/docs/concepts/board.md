---
title: Board and cards
description: How a card goes from an idea to a merged pull request.
---

Each project has a Board, and the Board holds cards. A card is one piece of
work — a feature, a fix, a chore — written by a person, or proposed by the
planner and accepted by a person. Cards are numbered per project, `C-1`,
`C-2` and so on, and live in Nautelle, not in GitHub issues.

## Columns

| Column | What it means |
|---|---|
| **Inbox** | Suggestions waiting for a person. A suggestion leaves the Inbox only when someone accepts it. |
| **To Do** | Accepted work, ready to run. |
| **In progress** | A worker is on it. |
| **Finished** | The worker is done and the checks are green. |
| **Completed** | A person accepted the result. Only a person completes a card. |

## Running a card

**Run** starts a dedicated Claude Code worker for that card on the project's
runner:

1. The runner creates a git worktree next to the repository, on a branch
   named after the card (`card/c42-short-title`), and opens a tmux session in
   it.
2. The worker writes or follows the card's spec, implements it, runs the
   project's checks and commits as it goes. A draft pull request opens during
   the round.
3. When the worker finishes, the pull request leaves draft. Nautelle watches
   CI and sends the worker back to fix a failure, up to three times.
4. The card is **Finished** when the work is done and every check passed. If
   the project has auto-merge on, Nautelle merges the pull request then.

Each Run or piece of feedback is a **round**, with its own phase: Queued,
Starting, Running, Waiting for you, Running in background, Finished, Ended,
Failed or Stopped. While a round runs you can watch the session, answer its
questions, approve what it asks to do from the web app or Telegram, and send
it a message.

**Feedback** on a finished card starts a new round on a new branch and pull
request. **Completed** closes the worker and removes its worktree; it never
merges anything by itself.

## Demo videos

A finished feature card can carry a short video of the feature working,
recorded by [DemoFlow](https://github.com/AndreyBegma/DemoFlow) on the
project's runner, so you can watch it before you merge.

To turn them on for a project:

1. Open **Settings → Demo videos** and switch **Demo videos** on. **UI paths**
   says which changed files make a card record one (by default `apps/web/**`,
   `**/*.tsx` and `**/*.css`).
2. Under **Demo env**, add the secrets a scenario needs — a demo account's
   email and password, for example. They are write-only, handed only to the
   recording, and blurred in the video. Use a demo account, never a real one.
3. Commit a `demoflow.config.json` at the root of the repository. Without it
   the runner skips every demo and says so on the card.

The config tells DemoFlow where the app is and how to start it in the card's
worktree. The runner sets `PORT` to the port of `readyUrl`; DemoFlow waits
until `readyUrl` answers, records, and then stops everything `devCommand`
started:

```json
{
  "baseUrl": "http://127.0.0.1:3517",
  "allowedOrigins": ["http://127.0.0.1:3517", "http://127.0.0.1:4517"],
  "devCommand": {
    "command": "sh",
    "args": ["scripts/demo-dev.sh"],
    "readyUrl": "http://127.0.0.1:3517/login",
    "timeoutMs": 300000
  }
}
```

Give every recording the same data: let `devCommand` start the app on a
database of its own, seeded with a demo account and a little content, rather
than on whatever the shared dev database holds. Nautelle's own
`scripts/demo-dev.sh` creates `agentdock_demo_<card>`, applies the card's
migrations, creates the admin from `DEMO_LOGIN_EMAIL` and `DEMO_LOGIN_PASSWORD`
and a demo project with a few cards, and drops the database when DemoFlow stops
it.

A Next.js app in dev mode serves its scripts only to `localhost` unless told
otherwise, so a page opened on `127.0.0.1` never hydrates and a form submits as
plain HTML. Add `allowedDevOrigins: ['127.0.0.1']` to `next.config`; it has no
effect on a production build.

The card's worker writes the scenario and commits it with its pull request as
`demoflow/cards/C-<n>-<slug>.demo.json`. A scenario is a list of browser
steps; `valueFrom.env` reads a Demo env secret:

```json
{
  "schemaVersion": 1,
  "name": "Sign in and open the Board",
  "steps": [
    { "action": "navigate", "path": "/login?next=/projects/demo-project" },
    { "action": "wait", "ms": 3000 },
    { "action": "fill", "target": { "label": "Email" }, "valueFrom": { "env": "DEMO_LOGIN_EMAIL" } },
    { "action": "fill", "target": { "label": "Password" }, "valueFrom": { "env": "DEMO_LOGIN_PASSWORD" } },
    { "action": "click", "target": { "role": "button", "name": "Sign in" } },
    { "action": "click", "target": { "role": "link", "name": "Board", "exact": true } },
    { "action": "assertText", "target": { "role": "heading", "name": "Board", "exact": true }, "text": "Board" }
  ]
}
```

Run one by hand with `npx demoflow@0.4.0 run <scenario>`. A demo that fails or
is skipped shows its reason on the card; it never holds up Finished or a merge.
The runner records one demo at a time.

## Where the reasoning lives

- [ADR-0024](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0024-board-cards-and-dedicated-card-workers.md): Board cards and dedicated card workers.
- [ADR-0035](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0035-a-card-ships-itself.md): a card ships itself — draft pull request, CI fix rounds, auto-merge.
- [ADR-0058](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0058-new-work-cards-are-candidates-until-accepted.md): new work cards are candidates until accepted.
- [ADR-0080](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0080-auto-merge-needs-every-check-passed.md): auto-merge needs every check passed.
- [ADR-0084](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0084-a-card-passes-its-review-steps-before-finished.md): a card passes its review steps before Finished.
- [ADR-0090](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0090-a-finished-card-may-carry-a-demo-video-recorded-by-demoflow-on-the-runner.md): a finished card may carry a demo video recorded by DemoFlow on the runner.
- [All decisions](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/README.md).
