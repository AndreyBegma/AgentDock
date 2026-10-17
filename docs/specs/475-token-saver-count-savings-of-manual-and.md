# C-204: Token saver: count savings of manual and /cs-eco sessions (a `manual` run kind)

Issue: #475

## What
The code-sentinel plugin's `/cs-eco` (code-sentinel-skills#26) runs `agentdock-runner filter-hook` in sessions the runner did not launch: manual terminals, the orchestrator's own session and fleet workers. It writes `filter.stats` rows to `${XDG_STATE_HOME}/cs-eco/sessions/<sid>/filter-stats.jsonl`. Their `runKind` is temporarily `skill` (overridable with `CS_ECO_RUN_KIND`) because the contract has no `manual` kind.

## Do
- Add `manual` to `TOKEN_SAVER_RUN_KINDS` and to the `TokenSaverRunKind` enum (migration).
- The runner reads `cs-eco` session dirs whose session cwd is inside a watched project root. It takes the project from that root and never from the row (DA-04/DR-05), and sends the rows as `filter.stats` with `runKind: manual` and `runId: null`.
- The dashboard shows `manual` as its own run kind.

## Acceptance criteria
- [ ] A `/cs-eco` session in a watched project shows up on the Token saver dashboard under `manual`.
- [ ] Rows from a session outside every watched root are never sent.
- [ ] A row that names another project is rejected.
