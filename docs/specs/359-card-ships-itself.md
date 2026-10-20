# A card ships itself: draft PR while working, CI watched and fixed, auto-merge at Finished

Issue: [#359](https://github.com/AndreyBegma/Nautelle/issues/359) ·
Decision: [ADR-0035](../adr/0035-a-card-ships-itself.md) (amends ADR-0024 §6 and ADR-0029)

## Summary

Card C-6's pull request (#355) showed what a card ships today:
- a one-line description ("Work of Nautelle board card C-6");
- no link to its spec, although the spec file was in the branch;
- nobody watching its CI, which went red on a lint of the committed mockup;
- no merge until a person clicks Accept.

The product owner asked (2026-10-15) that a card work the way the
orchestrator fleet works:
- a spec, and a PR opened while the work is under way;
- CI watched, and red CI fixed by the worker itself;
- the PR merged when the worker is done and CI is green;
- the card kept on the Board, so a follow-up can reuse it.

## Scope

### In scope

- A draft PR as soon as the worker's first commit exists, ready for review
  at the end.
- A PR description: spec link, Closes #issue for bugs, what changed and why,
  and the acceptance checklist.
- A spec file for every card, and an issue only for bugs.
- CI watched by Nautelle: a red run becomes an automatic fix round (at most
  3); a merge conflict does too.
- Finished means the worker is done and CI is green, and then **auto-merge**
  (a per-project switch).
- After the merge, the card stays in Finished as Merged. Feedback starts a new
  round on a fresh branch with a second PR. Completed is a person's move,
  with cleanup.
- `finish_card` available in every card session without per-profile plugin
  setup.

### Out of scope

- Reading CI logs from a specific CI system: Woodpecker's API is not used.
  The fix round names the failed checks and their links, and the worker
  reproduces them with the project's own checks.
- Merge queues and required reviews (GitHub branch protection decides; a
  refused merge is reported).
- Fleet and terminal cards: their PRs are owned by the orchestrator or the
  person (#282).

## Decisions

- **D1 — Draft PR while working.**
  - The runner's card executor already polls the card session every
    `CARD_SESSION_POLL_MS`. When the worktree's HEAD is ahead of
    `origin/<base>` and not yet pushed, it pushes the branch (git over `gh`,
    #329 D1).
  - When no PR exists for the branch, it opens one with `gh pr create
    --draft`, titled `C-<n>: <title>`, with the D3 body as far as it is known
    (spec link and the card summary).
  - Later commits are pushed on the next poll (at most one push per 30 s). The
    worker still never pushes: the worker prompt's rule stays and only its
    reason changes.
  - The PR link appears on the card in In progress (#329 D6).
- **D2 — `finish_card` everywhere.**
  - The runner starts every card session with `--mcp-config` naming its own
    MCP server, the one the agentdock plugin uses (`apps/runner/src/mcp/`).
    `finish_card` then exists with no per-profile plugin setup.
  - When the profile already has the plugin, nothing is doubled: the server
    name is the same, and the CLI flag wins.
  - [Unknown, verify in the runner slot: whether `--mcp-config` together with
    the plugin's server under the same name loads one server. If not, the
    runner skips the flag when the profile reports the plugin, #281.]
  - The prompt's "reply DONE" fallback stays.
- **D3 — The PR description.** The worker writes it: the prompt asks for
  `.agentdock/pull-request.md` in the worktree (git-excluded, beside
  attachments) before `finish_card`. The file has these sections:

  ```
  Spec: <repository link to docs/specs/card-<n>-<slug>.md on the branch>
  Closes #<issue>                       (bugs only, D4)

  ## What changed and why
  <by module, short>

  ## Acceptance criteria
  - [x] <criterion from the spec> — <how it was checked>
  - [ ] <criterion not met> — <why>
  ```

  - Collect (#329) reads it and sets it as the PR body with `gh pr edit
    --body-file`.
  - When the file is missing, collect builds the body from the card summary,
    the spec link and the issue line, so there is never a one-liner without a
    spec link.
- **D4 — Documentation per card.**
  - Every card gets its spec file at Run: `specOnRun` is always on and is
    removed as a switch. The file goes to `docs/specs/card-<n>-<slug>.md` in
    the card's first commit; when the project has no `specDir`, the issue body
    holds the spec.
  - A **bug** card also gets a GitHub issue at Run (`issueOnRun` follows the
    kind: on for `bug`, off for `feature`; a person can still override it per
    card). The PR then says `Closes #<n>`.
  - Since PRs target a non-default base (develop), `Closes` does not close the
    issue. Nautelle closes it after the merge, as the fleet does.
- **D5 — CI watched.** While a card's PR is open, the API reads its checks
  through the runner (`gh pr checks --json`).
  - It polls every 60 s while the PR has pending checks, and on every
    `card_run` finish.
  - It stores `ciState`: `none | pending | green | red`, plus the failed
    checks (name and link). The card face shows a CI dot next to the PR chip.
- **D6 — Red CI is an automatic round.** When `ciState` turns `red` on the
  card's current head, and the worker's round is over, Nautelle starts a
  round with the trigger `ci_fix`. Its prompt says:

  > "CI failed on <head>: <check> — <link> (and the rest). Reproduce it with
  > the project's checks (<orchestrator.checks or CLAUDE.md>), fix it, commit,
  > and call finish_card."

  - At most **3** `ci_fix` rounds per PR. The fourth red check sets
    `needsPerson`: the card shows "CI still failing after 3 fixes" and stops
    automating until a person acts (feedback, Run, or Accept).
  - A merge conflict with the base (the PR is `CONFLICTING`) is handled the
    same way, with the prompt "merge origin/<base>, resolve, commit" and the
    same budget.
- **D7 — Finished = done + green, then auto-merge.**
  - A card moves to **Finished** only when the worker has finished (finish_card
    or DONE, or the session ended) **and** CI on the head is `green`, or the
    repository has no checks.
  - Until then it stays in In progress with a sub-state badge: "Checks
    running" or "Fixing CI (2/3)".
  - On entering Finished, with the project's **auto-merge** switch on, the API
    merges through `card.merge` (#273/#329):
    - the method from the repository settings;
    - `deleteBranch: true`;
    - `headSha` = the green head.
  - The switch lives in the project's board settings. It defaults to **on**
    when the base is not the repository's default branch (develop), and to
    **off** for main.
  - With the switch off, Finished waits for Accept, as today.
- **D8 — After the merge the card stays.**
  - A merged card stays in **Finished** with a **Merged** badge and its PR
    link. The worktree, the session and the local branch are kept.
  - **Send back** with feedback starts a new round in the same Claude session
    on a fresh branch `card/c<n>-<slug>-<k>`, made from the updated
    `origin/<base>`. That round opens a new draft PR (D1). The card lists its
    PRs.
  - **Completed** is a person's move. It runs the cleanup of #329:
    - kill tmux;
    - remove the worktree and the local branches;
    - remote branches are already gone after each merge.
- **D9 — What a person can still do.** Everything is overridable:
  - Accept on a Finished card that did not auto-merge;
  - Stop on any round;
  - dragging back to In progress = feedback;
  - turning auto-merge off per project.

## Data / Schema

`apps/api/prisma/schema.prisma`, migration
`apps/api/prisma/migrations/20261127000000_card_ships_itself/`:

- `enum CardCiState { none pending green red }`.
- `model BoardCard`:
  - `ciState CardCiState @default(none)`;
  - `ciChecks Json?`: the failed checks, name and link;
  - `ciFixAttempts Int @default(0)`;
  - `needsPerson Boolean @default(false)`;
  - `mergedAt DateTime?`.
- New `model BoardCardPullRequest { id, cardId, number, url, branch, state, round, createdAt }`.
  Every PR of a card is kept, and `prUrl` stays the latest.
- `enum CardRoundTrigger`: add `ci_fix`.
- `model BoardSettings` (or the project's board settings row):
  `autoMergeCards Boolean?`. Null means the D7 default.

## API / Runner

- Runner (cards executor):
  - D1, push and draft PR on the poll;
  - D2, `--mcp-config` at launch;
  - D3, collect reads `.agentdock/pull-request.md`, then `gh pr ready` and
    `gh pr edit`;
  - a new typed command `card.checks` (`gh pr checks --json
    name,state,link`), allowlisted and advertised.
- API, `board-work.ts`:
  - the CI poller and `ciState`;
  - D6 rounds and budget;
  - D7 the Finished gate and the auto-merge;
  - D8 the new-branch round and the PR list;
  - D4 issue for bugs and closing it after the merge.
- Shared, worker prompt (`packages/shared/src/board/worker-prompt.ts`):
  - the push rule's reason (D1);
  - the PR description file (D3);
  - the `ci_fix` round prompt (D6).
- Web:
  - the CI dot and the sub-state badges;
  - the Merged badge;
  - the card's PR list;
  - the auto-merge switch in board settings;
  - the "CI still failing" banner with its actions.

## Acceptance criteria

- [ ] **Draft PR while working:** after the worker's first commit, within one
  poll, the branch is on GitHub with a **draft** PR whose body links the spec
  file. The card shows the PR link in In progress.
- [ ] **Description:**
  - At finish, the PR leaves draft, and its body is the worker's
    `.agentdock/pull-request.md`: spec link, what changed, and the acceptance
    checklist.
  - Without the file, the body still has the spec link and the summary.
- [ ] **Bugs and features:**
  - A `bug` card gets an issue at Run and `Closes #n` in its PR. The issue is
    closed by Nautelle after the merge.
  - A `feature` card gets no issue, but does get the spec file.
- [ ] **No plugin needed:** with a profile that has no agentdock plugin,
  `finish_card` is available in the card session (the launch args carry
  `--mcp-config`). Calling it finishes the round.
- [ ] **CI fix round:**
  - With a stubbed red check, the card stays in In progress showing "Fixing
    CI (1/3)", and a `ci_fix` round starts with the check's name and link in
    its prompt.
  - After 3 red rounds, `needsPerson` is set, and no 4th round starts.
- [ ] **Finished and auto-merge:** green CI plus a finished worker moves the
  card to Finished. With auto-merge on (base develop):
  - `card.merge` runs with `deleteBranch: true`;
  - the card shows Merged and stays in Finished.

  With auto-merge off, it waits for Accept.
- [ ] **Follow-up round:** Send back on a merged card starts a round in the
  same session on `card/c<n>-<slug>-2` from the fresh base. It opens a second
  draft PR, and the card lists both PRs.
- [ ] **Conflict:** a PR that becomes `CONFLICTING` starts a fix round with the
  merge prompt (it counts toward the 3).
- [ ] **Completed cleanup:** Completed removes the worktree and local branches
  and kills the session.
- [ ] **Authorization:** the auto-merge switch needs project admin, while
  `ci_fix` rounds and auto-merges run as the system actor and are audited.
  Another project's card is never touched by the poller.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i359-contract | schema, migration, shared contracts and worker prompt | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261127000000_card_ships_itself/**, packages/shared/src/board/**, packages/shared/src/protocol/commands/cards.ts | #337 merged | yes | opus |
| i359-runner | D1, D2, D3 collect, `card.checks` | apps/runner/src/**, packages/shared/src/protocol/commands.ts | i359-contract | no | opus |
| i359-api | D4–D9 | apps/api/src/board/**, apps/api/src/settings/** | i359-contract | no | opus |
| i359-web | badges, PR list, the switch, the banner | apps/web/src/components/board/**, apps/web/src/lib/board/**, apps/web/src/app/(app)/projects/[projectId]/settings/**, docs/ui/screens.md | i359-contract | no | sonnet |

The runner slot is `opus`: D1 pushes from a poll loop the session does not
control, and D2 touches every card launch.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/src/board/**, apps/web/src/components/board/** | i359-api / i359-web | #337's slots own the same: **#359 starts after #337 merges** |
| schema.prisma | i359-contract | serialized after #337's migration (26), this is 27 |

## Risks

- **High — auto-merge of model-written code into develop.** *Mitigation:*
  - green CI is required;
  - the switch is per project, off for main;
  - develop is the integration branch, as for the fleet's `autoMerge: true`;
  - a person can turn it off.
- **Medium — fix-round loops cost money.** *Mitigation:* the budget of 3, then
  `needsPerson`; the project's budget hard stop applies.
- **Medium — pushes from a poll while the worker is mid-change.** *Mitigation:*
  only committed HEAD is pushed (never the index or the working tree), and at
  most one push per 30 s.
- **Low — `--mcp-config` vs plugin duplication** (D2 Unknown).

## Open questions

- **Q1 — Re-run a flaky check before a fix round?** Default: only when the
  check is a GitHub Actions run (`gh run rerun --failed`, once). Other CI
  goes straight to a fix round.
- **Q2 — A card's spec index row in `docs/specs/README.md`?** Default: no.
  Card specs are linked from their PRs, not indexed.

Depends on #329 (closed) · #337 (Board contention)
