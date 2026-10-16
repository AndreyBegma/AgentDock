# Context handoff

Context handoff ([#449](https://github.com/AndreyBegma/AgentDock/issues/449),
[ADR-0042](../adr/0042-context-handoff.md), [spec](../specs/449-context-handoff.md))
keeps a short note for every card, so the next round or session starts in
context at the lowest cost. It is on with Token saver; there is no separate
switch.

This guide is for the person using it. The runner events and commands are in
[the runner protocol](../architecture/runner-protocol.md).

## The note

Every card (and every design or planner run) has one handoff note. The agent
keeps it current at key moments: after the plan, after a decision, after a
commit and before it stops. If a session died without a fresh note, the runner
writes one from the transcript with a local haiku model, so session content
stays on the machine.

A note is markdown with these `## ` sections, in this order, and at most about
3,000 tokens:

1. Goal
2. Done
3. Next
4. Decisions and why
5. Dead ends
6. Files touched
7. How to verify
8. Checklist status
9. Open questions

A note that misses a section, repeats one, is out of order, has an empty Goal
or is too large is refused with the reasons, and the agent rewrites it.

The note lives in the card's worktree (`.agentdock/handoff.md`, git-excluded).
Only a project with **session content on** also sends a copy to the server.

## Keeping the note fresh

The runner checks the note at every stop and right before Claude Code compacts
the session (the plugin's `PreCompact` hook, plugin 0.3.0). A note older than
the round's last commit is stale, and the agent is asked to update it **once
per round**:

- At a stop, the request is typed at the agent's prompt.
- Before a compaction, no hook can reach the model and its prompt is busy, so
  the request comes with the note in the context Claude Code adds right after
  the compaction. The stops of that round do not ask again.

## Design builds and planner turns

A design build or a planner turn runs headless and read-only, so its agent
does not keep a note. When one is interrupted — killed, cancelled, timed out
or failed — haiku writes a note from its stream. The next attempt at the same
work (the same project and the same prompt) that starts a **new** session
starts from that note. A planner turn that resumes its session already has the
context and is not given the note. A run that succeeds clears it.

## Where you see it

- **Card sheet → Handoff**: the note's sections, who updated it (the agent,
  haiku or a person) and when. Lines a person wrote are highlighted.
- **With session content off** the section says the note is kept on the
  machine. Nothing of it reaches the server.
- **Card face chip**: `resumed from handoff · saved ≈ $x` when the runner
  started a fresh session from the note, or `resumed session` when it used
  `--resume`. A card's first round has no chip.

## How the next round starts

Before a round the runner estimates the cost of its first turn both ways:

- **Resume**: the whole session history, priced as a cache read while the
  prompt cache is warm and as uncached input once it is cold.
- **Fresh**: the note, a summary of the diff and the checklist status, and the
  card prompt.

It picks the cheaper one, stores both estimates on the round, and never
discards the old session — it can still be resumed. A warm cache and a short
history resume; a cold cache and a long history start fresh from the note.

## Steering a round by editing the note

An operator can click **Edit** in the Handoff section, change the note and
**Save note**. The next round starts from your version.

- Lines you add or change are marked as yours. **The agent never rewrites
  them**; it keeps them verbatim when it updates the note. Write an instruction
  there ("do not touch the migration", "next: only the API tests") and it
  stays.
- The note must keep the format above. The editor shows the problems it can
  see, and the server lists every reason when it refuses a save.
- **Edit** needs the project to ship session content and the card to have a
  worktree (its first round writes the note). The runner must be online and
  up to date; otherwise the save fails and the note is unchanged.

| The save says | It means |
|---|---|
| not edited: session content on the machine, or no worktree | there is nothing on the server to edit, or the first round has not run yet |
| not saved: does not follow the format | fix the listed sections and save again |
| runner offline or too old | start or update the runner, then save again |
| runner could not apply the note | the runner answered with an error; the note is unchanged |

## In your own terminal

A Claude Code session you start in a card's worktree or branch receives the
note through the agentdock plugin's `SessionStart` hook. `track_card` on that
card returns it, and the `resume_context` tool returns it on demand.
