# Steward

Steward ([#447](https://github.com/AndreyBegma/AgentDock/issues/447),
[ADR-0040](../adr/0040-steward.md), [spec](../specs/447-steward.md)) watches
the work your agents do, fixes the few things that are safe to fix without you,
and tells you in one line when it needs a person. It is not a chat assistant
and not a second orchestrator.

This guide is for the person using it. The runner events and commands are in
[the runner protocol](../architecture/runner-protocol.md).

## What it watches

- **Board cards**: every round of a card's worker.
- **Runner runs**: skills, design, planner, assess, capture, normalize.
- **Fleet slots**: observed only. Steward opens an incident and tells you, and
  it includes the slot in the digest. It never sends a slot a command — the
  orchestrator owns its slots ([ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md)).

An incident is one stuck situation. It opens when Steward sees one of:

| Kind | What Steward saw |
|---|---|
| API error | `API Error: …` or an interrupted response in the session |
| Dialog | a Claude Code dialog is open |
| Permission prompt | the session asks for a permission |
| Quota | the quota banner |
| Silent | no activity for the **silence threshold** (default 10 minutes) and no live background task |
| Session ended | a card's tmux session is gone |
| Claude trailer | a card commit carries a Claude attribution trailer |
| Unknown | none of the above matched; a small local model gives a one-line reason |

A round that waits on a long background task is never "silent".

## What it does by itself

Only these, each with a limit, and each can be switched off:

- **Nudge** after an API or network error: one fixed line is typed into the
  session, at most **2 per round** — the first at once, the second 2 minutes
  later. A third error escalates.
- **Dismiss** a dialog that needs no decision (a short, fixed list). An
  unknown dialog is never answered.
- **Resume** a dead card session: `--resume` in the same worktree, at most **2
  per round**, only when the worktree still exists. A round **you** stopped is
  never resumed.
- **Hold a push** whose commits carry a Claude attribution trailer. The worker
  is told which commits to rewrite; once it has, the push goes through.

## What it never does

- Answer a permission prompt, merge, or change code.
- Act on a fleet slot.
- Read pane or transcript text into the control plane. The API gets the kind of
  incident, a one-line reason and the action taken. A tail of the pane is sent
  with an escalation only when the project ships session content.

## What it escalates

Anything it cannot fix safely, and anything past a limit: one notification
(web and Telegram) per incident. A changed reason notifies again. When the work
recovers, the incident is closed with a **Resolved** entry in Activity and no
notification.

## Where you see it

- **Activity**: *More filters › Type › Steward* lists the incident events —
  opened, action taken, needs you, resolved (category Fleet). The API filters
  by one type at a time.
- **Board**: a card with an open incident shows a chip such as
  `Stuck: API error · nudged 1/2`; once escalated it reads `… · needs you`.
  The card sheet has a **Steward** section with the card's incidents and what
  was done about each.
- **Overview › Digest**: the latest digest of each project.
- **Telegram**: the same digest, daily and when you switch away mode off.

### Linking a card to an existing issue

The card sheet's **Steward** section has an **Issue** field. Enter the number
of an **open** issue of the project's repository and **Link**: Run then creates
no new issue, and the pull request says `Closes #n`. An empty field and
**Unlink** removes the link. A closed issue, a pull request or a number the
project does not have is refused with the reason. If the card text says
`Closes #n` or `GitHub issue: #n`, the field offers that number.

## The digest

Daily at the project's digest time (default 09:00, in your time zone) and when
away mode is switched off ("while you were away"). It lists what is **done**
(merged and finished), what is **stuck** and why, what is **waiting on you**,
and the spend. A short summary on top is written by a small local model; if the
runner is offline the digest is the plain template without it.

## Settings

**Project › Settings › Steward** (a project administrator saves; everyone else
reads):

| Setting | Meaning |
|---|---|
| Steward | the master switch, on by default. Off: no incidents, no actions, no digest |
| Silence threshold | minutes without activity before a round counts as silent (1–240) |
| Digest time | time of day for the daily digest |
| Nudge, Dismiss, Resume, Hold pushes | one switch per automatic action. An action that is off is not performed — Steward escalates instead |

The small local model used for unknown stalls and the digest counts against
the project's budget.
