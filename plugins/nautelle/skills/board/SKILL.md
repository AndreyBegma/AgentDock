---
name: board
description: Work the Nautelle Board from this session. Use when the person names a card ("do C-42", "run C-42"), asks you to finish, run or drive cards ("finish everything in To Do"), asks what is on the Board, or asks you to create a card; not for tracking the work you are already doing (track-work does that).
---

# Work the Board

The `nautelle` MCP server (`mcp__plugin_nautelle_nautelle__*`) lets you read
the Board, create cards, run them, move them, answer their questions, send
feedback, take a card to work on yourself, and wait for the Board to change.
Card numbers are per project: `C-42` is `{ card: 42 }`.

**Tools:** read — `board_list`, `board_card`, `board_wait`. Control — `card_create`,
`card_run`, `card_move`, `card_feedback`, `card_message`, `card_stop`,
`take_card`, `release_card`. Stacks, designs and dependencies — `stack_create`,
`stack_add_card`, `stack_remove_card`, `stack_update`, `stack_run`,
`stack_stop`, `stack_design`, `card_design`, `card_depend`, `card_undepend`
(below). Also `finish_card`, `request_action`, `action_status`.

Control tools answer only the person's own terminal session. A card worker or
fleet slot gets `not_a_manual_session`: say so in one line and stop; it has no
Board to drive. A `forbidden` answer means the person's role cannot do it: say so.

## Who does the work (D1, D2)

| The person says | You |
|---|---|
| One card: "do C-42" | Do it **yourself**: `take_card`, work it on your own branch in this checkout, push, open the pull request, `finish_card` with `pullRequestUrl`. |
| Several cards, or "everything in To Do" | **Conduct**: `card_run` each; a dedicated worktree and card session works it. |
| "run C-42" | Board Run, even for one card. |
| "do these two yourself" | Yourself, one at a time (below). |

The person's words override the table. If you cannot tell, take one named card
yourself and conduct several.

### Yourself

1. `board_card` first: read the body, dependencies and any `taken.branch` a
   previous session left. A branch there is where the work stands; continue on it.
2. `take_card {card}`. The answer carries the card's title, body and kind.
   - `state: taken` — you hold it. Work it like any task: read before you write, run the checks.
   - `state: queued` — you already hold a card; this one waits and you get it
     from `finish_card` or `release_card` (`next`). One active card per session.
   - `card_taken` — a running round or another live session has it. Leave it; tell the person.
3. Push your branch, open the pull request, then `finish_card` with the
   `summary` and `pullRequestUrl` (the https GitHub URL). The card moves to Finished; the response's
   `next` is the queued card you now hold. Work it the same way.
4. Cannot do the card: `release_card {card}` (back to To Do) and say why.

Do not `track_card` for a card you took: the card already exists.

## Conducting (D3)

Read `board_list` first: `settings.maxRunning`, `settings.running`,
`settings.cardMergePolicy`, then the cards in board order.

Loop until nothing is left in scope:

1. **Run** To Do cards in board order while `running < maxRunning`:
   `card_run {card}`. `model` and `effort` only when the person asked.
2. **Wait** with `board_wait` (below).
3. **React** to each event:

| Event | You |
|---|---|
| `question` | Answer it (D7). |
| `column` to `finished`, or `round_ended` | Read `board_card`: summary, pull request, `ciState`. Red → feedback; green → merge policy (D4); `pending`/`none` → keep waiting. |
| `ci` to `red` | `board_card` for `ciChecks`; `card_feedback {card, text}` naming the failing checks and what to fix. |
| `ci` to `green` on a finished card | Merge policy (D4). |
| `pr_merged` | `request_action card_accept` (D5). |
| `column` to `todo`/`inbox`, deleted card | Someone moved it. Drop it from your scope; do not fight the person. |

4. Run the next card as a slot frees. Then wait again.

**Obey the Board's refusals; never work around them.** `dependency_open`,
`design_not_approved`, `stack_design_not_approved`, `budget_exceeded`,
`max_running` come back by name. `max_running` means wait for a slot;
`dependency_open` means run the dependency first or skip the card;
`budget_exceeded`, `design_not_approved` and `stack_design_not_approved` are the
person's to resolve: report the card, move on to the next. Never `card_move`
a card around a refusal, and never retry in a loop.

`needsPerson: true` on a card means CI or a protected path needs a person.
Nothing automated acts on it: report it, do not merge it.

## Merge policy (D4)

Read `cardMergePolicy` from `board_list`.

| Policy | You |
|---|---|
| `ask` | Ask the person **once per run**, at its start, with `AskUserQuestion` (options: "You merge", "Merge green ones yourself"). Keep the answer for the whole run; do not ask again. |
| `agent` | Merge a pull request yourself only if **all** hold: CI green, `mergeStateStatus` is `CLEAN`, no `Co-Authored-By: Claude`/`Claude-Session:` trailer or "Generated with Claude Code" footer in any commit or the body. |
| `person` | Never merge. Request acceptance with `merge: true` and the person's approval merges it. |

Always the person's, under every policy: a pull request that touches
`.woodpecker/**`, and a card whose issue carries a `Gate:` line. Never merge
those; request acceptance and say why.

A pull request that fails a condition under `agent` goes back to the person the
same way. Check with `gh pr view <number> --json mergeStateStatus,statusCheckRollup,files,commits,body`.

## Completed is the person's (D5)

You cannot complete a card. `card_move` to `completed` is refused
`completed_needs_person`; do not look for another way.

When a card is Finished with green CI (merged, or open and you merged it under
`agent`): `request_action {kind: "card_accept", args: {card, merge?}, summary}`
(`summary`: one line for the approver, e.g. "C-42 green, PR #123 merged").
`merge: true` only when the pull request is still open and the policy is
`person`. The person approves in the web app or Telegram. Check
`action_status` once if the person asks; otherwise leave it pending, report it
as awaiting acceptance, and carry on. A declined request leaves the card in
Finished; ask what the person wants instead of re-filing it.

## Creating cards (D6)

| Origin | `card_create` |
|---|---|
| The person asked for the card | No `candidate`: it goes to To Do. |
| You propose it on your own | `candidate: true`: it goes to the Inbox for the person to accept. |

Never create a card that duplicates one in `board_list`. `kind` only when obvious.

## Stacks, designs and dependencies

Only when the person asks for them. `board_list` shows every stack: number,
title, stages with their card numbers, design status and run. Stack numbers are
per project: `S-3` is `{ stack: 3 }`; stages are 0-based.

| The person says | You |
|---|---|
| "group C-1..C-4 into a stack" | `stack_create {title, stages: [{cards: [1, 2]}, {cards: [3, 4]}]}`: each stage runs after the one before. `design: true` when they want one shared design first. |
| "add / take out C-5" | `stack_add_card {stack, card, stage}` (`stage` = the number of stages adds a last one), `stack_remove_card {stack, card}`. |
| "rename it", "name the stages" | `stack_update {stack, title?, body?, stages?: [{position, title}]}`. |
| "run / stop the stack" | `stack_run {stack}`, `stack_stop {stack}`. |
| "C-5 after C-4" | `card_depend {card: 5, dependsOn: 4}`; `card_undepend` removes it. |
| A design | `stack_design` or `card_design` with `action`: `status`, `generate`, `revise` (with `comments`), `approve`. |

Approving a design is the person's gate. Approve only when the person tells you
to in this session; `needs_person` means approve it in the web app. With several
variants in play, `status` lists the revisions: ask which one, then pass
`revisionId`. `stack_refused`, `dependency_cycle`, `invalid_dependency`,
`design_busy`, `design_off`, `no_open_comments` and `design_approved` come back
by name: say what was refused and why, do not retry around it.

## Card questions (D7)

A `question` event carries the text and options. Read `board_card` for the
card, its body and the code, then:

- **The card, its spec or the code settles it** → `card_message {card, kind: "option", questionKey, index}` (`index` is the option's 1-based number; `questionKey` comes from the event or `board_card`), `kind: "other"` with `questionKey` and `text` for a free answer, or `kind: "text"` with `text` for a plain message. Read the `outcome` (`answered`, `question_changed`, `no_option`, `no_session`, ...): on `question_changed` re-read the question and answer again. Say in one line what you answered.
- **It is a product decision** → ask the person in the chat with `AskUserQuestion`, with your recommendation first. Then relay the answer with `card_message`.

Do not guess past what the sources say. A wrong answer sends a worker down the
wrong path for a whole round.

## Waiting (`board_wait`)

`board_wait {cursor?, cards?, timeoutSec?}` returns the events since `cursor`
on the first change or at the timeout (`timeoutSec` 0–300, default 300), plus a new `cursor`.

- Without a cursor it starts from now and returns a cursor to start from. Events that happened before it are not reported; read `board_list` for the state now.
- **Pass the cursor you got back into the next call, every time.** The same cursor twice reports the same events, so a lost answer loses nothing.
- **Keep the cursor across compaction**: write it down in the chat when you
  summarize or after a long wait ("board cursor: ..."). After a compaction, resume
  with the last cursor you wrote down, not none. With none you re-read
  `board_list` and miss what changed meanwhile.
- `cards` narrows to the cards you conduct (up to 50). Leave it off to see every card outside Inbox and Completed.
- An empty `events` is a quiet board, not an error. Call again with the new cursor.
- Never poll `board_list` in a loop instead of waiting.

## Reporting

Short lines, one per change: "C-42 finished, CI green, awaiting your accept",
"C-43 red: lint, feedback sent", "C-44 refused: `dependency_open` (C-41)".
At the end, a table of every card in scope with its column and what the person
still has to do.

## Errors

| Code | Meaning |
|---|---|
| `not_a_manual_session` | Not the person's terminal session. Stop. |
| `forbidden` | The person's role cannot do it. Say so. |
| `completed_needs_person` | Use `card_accept`. |
| `needs_person` | A design approval is the person's: in the web app. |
| `card_taken` | A running round or another live session has the card. Leave it. |
| `not_taken` | You do not hold the card. Do not release or finish it. |
| `runner_offline`, `no_project` | Say so in one line; do not retry. |
