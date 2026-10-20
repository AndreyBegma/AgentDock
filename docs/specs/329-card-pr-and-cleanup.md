# A card always reaches a pull request, and Accept cleans up its branch

Issue: [#329](https://github.com/AndreyBegma/Nautelle/issues/329)

## Summary

On 2026-10-15 card C-6 ended in **Finished** with three commits and **no pull
request**, and nothing on the card said so. What happened:

- `card.collect` failed on the runner (`git … failed: … and the repository
  exists`). The runner runs as a systemd user unit and has no SSH agent, and
  this machine keeps no private keys: they come from an agent forwarded from
  the owner's laptop.
- The API only logged the failure (`BoardWork.collectNow`) [Confirmed
  `apps/api/src/board/board-work.ts`].

The product owner asked (2026-10-15) for these outcomes:

1. **A card that should have a PR gets one.** The runner's git reaches GitHub
   without SSH. A failed collect is shown on the card, retried automatically,
   and can be retried by hand with **Create pull request**.
2. **The PR is one click away** from the card in every column where it
   exists.
3. **Accepting a card offers to clean up.** Merging deletes the PR's branch
   on GitHub. Accepting without merging can close the PR and delete its
   branch.

## Scope

### In scope

- Runner git over HTTPS with `gh` credentials for GitHub remotes. This covers
  every fetch and push (cards, skill runs, planner, UI profile).
- The collect outcome on the card, an automatic retry, and a manual
  **Create pull request**.
- The PR link on the card face and sheet in every column, plus the PR's state
  (open, draft, merged, closed).
- Accept: **Delete branch** after a merge, and **Close PR and delete branch**
  when accepting without a merge.

### Out of scope

- A draft PR opened during round 1 (Open question Q1).
- CI status on the card (Q2).
- Non-GitHub remotes. Their behaviour is unchanged.
- Reopening a closed PR.

## Decisions

- **D1 — Runner git authenticates through `gh` for GitHub.**
  - At start, the runner checks `gh auth status --hostname github.com`. When
    it passes, every `git` child process gets these settings through
    `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`:

    ```
    url.https://github.com/.insteadOf = git@github.com:
    url.https://github.com/.insteadOf = ssh://git@github.com/
    credential.https://github.com.helper = (empty, resets inherited helpers)
    credential.https://github.com.helper = !gh auth git-credential
    ```

  - The settings live in one place: the runner's exec wrapper for `git`. Call
    sites stay unchanged.
  - When `gh` is not authenticated, nothing is set. The runner's `hello`
    reports `git: { github: 'gh' | 'native' }`, so the Board can explain a
    failure.
  - This is the fix for C-6. `gh pr merge` already worked through the same
    token [Confirmed: `card.merge` uses `gh`].
- **D2 — The collect outcome is stored.** `board_cards` gains:
  - `collectState`: `none | pending | ok | no_changes | failed`;
  - `collectError`: text (≤ 500), the runner's one-line message;
  - `collectAttempts`: int;
  - `collectedAt`.

  `collectNow` writes these on every attempt, success or failure, for **every**
  card source. Today only `terminal` cards record a failure.
  - `ahead: 0` sets `no_changes`.
  - A PR opened, or already open, sets `ok` with `prUrl`.
- **D3 — An open PR is always reported back.** When `card.collect` finds an
  open PR for the branch, its result carries that PR's `prNumber` / `prUrl`
  too, not only when it opened one. The API then fills a lost `prUrl`.
- **D4 — Automatic retry.** A `failed` collect is retried:
  - once after 2 minutes;
  - when the project's runner next connects (`hello`);
  - at most 3 automatic attempts in all, counted by `collectAttempts`.

  A card a person moved out of Finished is not retried.
- **D5 — Create pull request, by hand.** `POST
  /projects/:projectId/board/cards/:number/collect` (`ProjectRole('operator')`)
  runs the collect now and answers with the outcome.
  - It is offered in the card sheet when the card is in Finished or
    Completed, has a `branch`, has no `prUrl`, and `collectState` is not
    `no_changes`.
  - The sheet shows `collectError` above the button: "No pull request:
    <error>".
  - It resets the automatic attempts.
  - In Completed the card's worktree is already gone: Accept's `card.close`
    removed it and the runner's record with it. `card.collect` then checks
    the branch `card.close` kept (or `origin/<branch>`) out in a temporary
    worktree, collects it as usual, and removes that worktree again (#344).
- **D6 — The PR link everywhere.**
  - The card face and the sheet header show `PR #<n>` with the PR's state in
    **every column** where the card has a `prUrl`. A card dragged back to In
    progress for a feedback round keeps its PR [Confirmed: the face and sheet
    read `card.prUrl`; this checks every column and adds the state].
  - The state comes from the existing PR polling (fleet/PR poll) or, if
    absent, from `card.collect` / `card.merge` results. It is stored as
    `prState`: `open | draft | merged | closed`.
  - Without a PR, the face shows the issue link if there is one.
- **D7 — Accept and merge deletes the branch.**
  - `card.merge` gains `deleteBranch: boolean`. After a successful merge, the
    runner deletes `refs/heads/<branch>` on GitHub with `gh api -X DELETE
    repos/<o>/<r>/git/refs/heads/<branch>`. It never touches the base or a
    branch that is not the PR's head.
  - The result gains `branchDeleted: boolean`. A failed deletion does not
    undo the merge; it is reported in the result.
  - The Accept dialog shows **Delete the branch on GitHub**. It is checked by
    default, and unchecked and disabled for `terminal` cards: their branch is
    the person's session branch.
  - The existing `card.close` then removes the worktree, the tmux session and
    the local branch [Confirmed: `effects.includes('accept')` → `close` with
    `removeWorktree: true`].
- **D8 — Accept without merging can close the PR.**
  - A new typed command `card.prClose` (ADR-0010, advertised per ADR-0023)
    takes `{ cardId, projectId, root, pr, deleteBranch }`. It runs `gh pr close
    <pr> --repo <o/r> --comment "Closed from the Nautelle Board (C-<n>)"`,
    then deletes the branch as in D7.
  - The Accept dialog's *Accept without merging* gets a choice:
    - **Leave the PR open** (default);
    - **Close the PR and delete its branch**.
  - The card moves to Completed only after the command succeeds, as ADR-0029
    does for a merge.
  - The linked issue is closed as `not planned` only if the person ticks it.
    It is off by default.
- **D9 — Older runners.** A runner that does not advertise `card.prClose`, or
  is older than the `deleteBranch` arg, gets the options hidden with "Update
  the runner to …" (ADR-0023 pattern). D1 needs no new command; it ships in a
  runner release.

## Data / Schema

`apps/api/prisma/schema.prisma`, migration
`apps/api/prisma/migrations/20261124000000_card_collect_state_and_pr_state/`:

- `enum CardCollectState { none pending ok no_changes failed }`
- `enum CardPrState { open draft merged closed }`
- `model BoardCard`:
  - `collectState CardCollectState @default(none)`
  - `collectError String?`
  - `collectAttempts Int @default(0)`
  - `collectedAt DateTime?`
  - `prState CardPrState?`

## API

- `board-work.ts`:
  - `collectNow` stores D2 for every source;
  - D4: a delayed retry through the existing board queue, and a retry on the
    runner `hello`;
  - `card.prClose` on Accept without merging (D8);
  - `deleteBranch` on Accept with merging (D7).
- `board.controller.ts`: `POST …/collect` (D5).
- `dto.ts`, `AcceptBoardCardDto`:
  - `merge.deleteBranch?: boolean`;
  - `closePr?: { deleteBranch: boolean; closeIssue: boolean }`;
  - `merge` and `closePr` are mutually exclusive (400).
- Board card view: `collectState`, `collectError`, `prState`.
- Authorization: collect and accept keep `operator`. A card of project B is
  never reachable through project A's routes.

## Runner

- `apps/runner/src/git-auth.ts`: the D1 probe and the `GIT_CONFIG_*`
  environment, applied in the exec wrapper to every `git` call.
- `cards/git.ts`: D3, the open PR reported back.
- `cards/merge.ts`: D7, `deleteBranch`.
- `cards/pr-close.ts`: D8, the handler; allowlist entry in
  `packages/shared/src/protocol/commands.ts`.
- `hello` capability `git.github`.

## UI

- `card-face.tsx`: the PR chip with its state in every column.
- `card-sheet.tsx`: the PR link with its state in the header; the "No pull
  request" banner with `collectError` and **Create pull request** (D5).
- `accept-dialog.tsx`:
  - **Delete the branch on GitHub** (D7);
  - under *Accept without merging*, the radio **Leave the PR open** / **Close
    the PR and delete its branch** and the checkbox **Close the issue as not
    planned** (D8);
  - runner-outdated hints (D9).
- glass-ui components only (ADR-0011). Rows in `docs/ui/screens.md`.

## Acceptance criteria

- [ ] **Runner, no agent:** with `SSH_AUTH_SOCK` unset, a git remote
  `git@github.com:o/r.git`, and `gh` authenticated (stubbed in tests):
  - `card.collect` runs `git` with the D1 `GIT_CONFIG_*` environment;
  - the push targets `https://github.com/o/r.git` (asserted on the exec
    stub);
  - with `gh` not authenticated, no `GIT_CONFIG_*` is set.
- [ ] **Collect failure is visible:** a stubbed `card.collect` failure on a
  board-source card moving to Finished stores `collectState = failed` and
  `collectError`. The card view carries both, and the sheet shows "No pull
  request: …" with **Create pull request**.
- [ ] **Retry:**
  - the failed collect is retried after 2 minutes and on the runner's next
    `hello`;
  - after 3 failures there are no further automatic attempts;
  - `POST …/collect` runs it again, and on success stores `prUrl`,
    `collectState = ok`, `prState = open`.
- [ ] **Lost link:** a card whose PR is already open but `prUrl` is null gets
  `prUrl` filled by the next collect (D3).
- [ ] **Link in every column:** a card with `prUrl` shows `PR #n` on its face
  in todo, in_progress, finished and completed (web test over the face
  component).
- [ ] **Merge and delete:** Accept with merge and **Delete the branch**:
  - `card.merge` gets `deleteBranch: true`;
  - the runner calls `gh api -X DELETE …/git/refs/heads/<branch>` only after
    the merge succeeded, and never for the base;
  - `branchDeleted` is reported;
  - `card.close` removes the worktree.
- [ ] **Close without merging:** Accept without merging with **Close the PR and
  delete its branch** sends `card.prClose`. The card moves to Completed only on
  success; on a refusal it stays in Finished with the runner's message. With
  **Leave the PR open**, nothing is sent to GitHub.
- [ ] **Terminal cards:** the delete-branch checkbox is unchecked and disabled,
  and the API refuses `deleteBranch: true` for one with 422.
- [ ] **Old runner:** without `card.prClose` advertised, the close option is
  hidden with the update hint, and the API refuses it with
  `command_unavailable`.
- [ ] **Authorization:** a viewer gets 403 on `POST …/collect` and on accept
  with `closePr`; another project's card number is 404.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i329-contract | schema, migration, shared contracts (collect/merge/prClose args and results, card view, accept request), compile fixes | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261124000000_card_collect_state_and_pr_state/**, packages/shared/src/protocol/commands/cards.ts, packages/shared/src/protocol/capabilities.ts, packages/shared/src/board/** | — | yes | opus |
| i329-runner | D1 git auth, D3, D7, D8 handlers, allowlist entry | apps/runner/src/**, packages/shared/src/protocol/commands.ts | i329-contract | no | opus |
| i329-api | D2, D4, D5, D7, D8 in the API | apps/api/src/board/**, apps/api/src/runners/** | i329-contract | no | opus |
| i329-web | D5, D6, D7, D8 in the UI | apps/web/src/components/board/**, apps/web/src/lib/board/**, docs/ui/screens.md | i329-contract | no | sonnet |

i329-runner is `opus`: the exec wrapper is shared by every executor, and D1
must not break a non-GitHub remote or an existing credential setup.
i329-api is `opus`: the retry has to fit the board queue and the runner
`hello` seam. After i329-runner merges: runner release 0.8.0 (or 0.7.2 if it
ships first).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma + migration | i329-contract | do not open |
| apps/api/src/board/** | i329-api | #322's i322-api also owns it: #322's api slot is cut after i329-api merges, or the reverse; never both live |
| packages/shared/src/protocol/commands.ts | i329-runner | #322's i322-runner also adds an entry: serialize the two runner slots |
| apps/web/src/components/board/** | i329-web | #322's i322-web: serialize |

## Risks

- **Medium — the `GIT_CONFIG_*` environment overrides a person's own git
  setup** for GitHub in runner processes. *Mitigation:*
  - it is applied only to the runner's children;
  - it is applied only when `gh` is authenticated;
  - the credential helper is reset only for `https://github.com`.
- **Medium — a branch deletion on a branch someone still uses.** *Mitigation:*
  - only the card's own PR head, never the base;
  - off for terminal cards;
  - only after a merge, or after a person explicitly chose to close.
- **Low — retry storms on a broken runner.** *Mitigation:* 3 automatic
  attempts, then manual only.

## Open questions

- **Q1 — A draft PR from round 1**, so the link exists while the card is in
  progress? Default: no. The PR appears at Finished, and a feedback round keeps
  it.
- **Q2 — CI status on the card**, and blocking Accept & merge while red?
  Default: not in this issue.

Depends on #273 (accept merge, closed) · #282 (closed)
