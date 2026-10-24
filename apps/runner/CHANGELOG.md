# nautelle-runner release notes

Each release's GitHub release links here. A release with an upgrade note says
what to do on every machine that runs the runner.

## Unreleased

## 0.16.0

**Upgrade note — demo videos need Node.js 22 or later on the machine.** The
runner fetches the pinned DemoFlow (0.4.0) with `npx` on the first demo and
runs `demoflow setup` once (Chromium and FFmpeg). Nothing else to install. A
project records demos only after its owner turns on *Settings → Automation →
Demo videos* and the repository has a `demoflow.config.json`.

- **Demo videos of finished cards.** `card.demo` records a card's DemoFlow
  scenario in the card's worktree on a free local port, with the project's
  demo secrets in the DemoFlow process environment only, and uploads the MP4
  with its SHA-256. One demo runs at a time, it is stopped after ten minutes
  with its whole process tree (the sessions it started, read from `/proc` on
  Linux and `ps` elsewhere, so a process that `exec`s another is still caught),
  and a skipped or failed demo is reported with a masked reason. The runner
  reports DemoFlow's state in the new `demoflow` capability, and a card
  session of a project with demo videos on gets DemoFlow's MCP server and a
  brief to write and commit the scenario
  ([ADR-0090](../../docs/adr/0090-a-finished-card-may-carry-a-demo-video-recorded-by-demoflow-on-the-runner.md)).
  Needs an API with the same release (#906).
- **A card session's question reaches the Board on every project.** The
  question selector a card session shows — header, text and options,
  redacted and capped on the runner — is reported whether or not the project
  ships session content, so the Board, `board_wait`, the web app and Telegram
  see it and `card_message` can answer it
  ([ADR-0094](../../docs/adr/0094-a-card-sessions-question-selector-is-reported-on-every-project.md), #914).
- **Stacks, designs and dependencies from a Claude Code session.** The
  `nautelle` MCP server gains `stack_create`, `stack_add_card`,
  `stack_remove_card`, `stack_update` (stage names too), `stack_run`,
  `stack_stop`, `stack_design`, `card_design`, `card_depend` and
  `card_undepend`; `board_list` returns stacks
  ([ADR-0089](../../docs/adr/0089-a-persons-session-may-work-stacks-designs-and-dependencies.md), #904).
- **A round's push reports how far it is ahead.** `card_run.pushed` carries
  `ahead` and `card.collect` returns the `headSha` it pushed, so a card shows
  each round's pull request head and its CI (#839).
- **Review steps before Finished.** `card.review` starts a review session for
  a card's pull request once its CI is green: a new Claude session in its own
  tmux session (`nautelle-review-<shortId>`) and its own detached worktree
  (`.wt-<repo>-review-<shortId>`) on the pull request's head, beside the
  card's worktree and session, which it never touches. The session gets its
  own `NAUTELLE_CARD` (and so its own test database and port) and reports its
  findings once with the new `report_review` MCP tool; a review session is
  offered the read tools and `report_review` only. `card.reviewStop` ends it
  and removes its worktree; `card.reviewPublish` posts the findings as one
  GitHub pull request review (inline comments, folded into the body when
  GitHub refuses them) through `gh`
  ([ADR-0084](../../docs/adr/0084-a-card-passes-its-review-steps-before-finished.md)).
  Needs an API with the same release (#884).

## 0.15.0

**Upgrade note — the local OTLP receiver now needs a token.** Run
`nautelle-runner setup claude` once on every machine whose Claude Code sends
telemetry to the runner: it writes the token header into each profile's
`settings.json`. Sessions the runner launches get it on their own. Until then
those sessions' usage and cost records are refused (401) and missing from the
web app.

- **Work the Board from a Claude Code session.** The `nautelle` MCP server
  gains eleven tools for a person's own session: `board_list`, `board_card`,
  `board_wait` (waits up to five minutes for a card to move, finish, change
  CI or ask a question), `card_create`, `card_run`, `card_move`,
  `card_feedback`, `card_message`, `card_stop`, `take_card` and
  `release_card`. `finish_card` accepts the pull request of a card the session
  took, and `request_action` can ask a person to accept a finished card. The
  `nautelle` plugin 0.6.0 adds the `nautelle:board` skill that drives them
  ([ADR-0083](../../docs/adr/0083-a-persons-session-may-work-the-board-through-mcp.md)).
  Needs an API with the same release.
- **Token saver techniques** behind per-card flags: a 400-line read guard
  that answers with a file outline, large MCP, Grep and WebFetch results cut
  to head and tail, a one-hour prompt-cache TTL, a long card session that
  starts fresh from its handoff by size, and the launch prefix measured and
  replaced by approved overlays.
- **A Sonnet card round can escalate to Opus once** (`escalate_card`), and a
  card's effort is passed at launch
  ([ADR-0076](../../docs/adr/0076-a-cards-model-and-effort-follow-its-class-and-stay-fixed-per-session.md)).
- **Design frame templates**: a design turn draws typed frames from the
  card's template, with a conformance check and one repair turn.
- **Update prompt**: after an interactive command the runner says when npm
  has a newer `nautelle-runner`. `NAUTELLE_NO_UPDATE_CHECK=1` (or `CI`) turns
  it off.
- **Pushes follow a branch policy**: the runner refuses to push to the
  repository's default branch or a protected branch (`branch_refused`), and
  reports the protected paths a card changes so the card is never
  auto-merged
  ([ADR-0077](../../docs/adr/0077-runner-pushes-follow-a-branch-policy-and-protected-paths-need-a-person.md)).
- **Security hardening**: the OTLP receiver checks its token and its Host
  header and caps a request at 5 000 records; untrusted GitHub text is fenced
  in `SessionStart` and MCP results; attachments, card files and skill copies
  are written owner-only; each event source accepts only its own event
  types; only sessions inside watched roots are reported
  ([ADR-0078](../../docs/adr/0078-only-sessions-inside-watched-roots-are-reported.md));
  plan and UI-profile cancels for another project's run are refused; issue
  labels with commas, control characters or `cs:*` are refused; the plugin
  marketplace is pinned.
- **Fixes**: a stale daemon lock is taken over atomically; capture output,
  board files and `state.json` reads are capped and transcript lines over
  16 MiB are dropped with a warning; fingerprint globs no longer backtrack;
  Bash calls stay unwrapped under a managed policy; capture, normalize and
  assess calls load no MCP server; `finish_card` is guarded in the daemon and
  a resumed card keeps its recorded permission mode; stopping an escalated
  round works when tmux cannot be read.

## 0.14.0

**Upgrade note — the runner is renamed `nautelle-runner`
([ADR-0073](../../docs/adr/0073-the-runner-and-its-protocol-are-renamed-nautelle-with-a-compatibility-window.md)).**
Releases before this one are listed under their old name, `agentdock-runner`.

- The binary, npm package, Homebrew formula, systemd unit and launchd agent
  are now `nautelle-runner`. On first start the runner moves
  `~/.config/agentdock`, `~/.local/state/agentdock` and its runtime directory
  to their `nautelle` names and leaves a symlink at each old path, so the
  watched projects, the policy in `runner.json` and the session-token secret
  carry over.
- Every `AGENTDOCK_*` variable is still read when its `NAUTELLE_*` name is
  unset, and logs a deprecation once. Runner 0.16.0 stops reading the old
  names.
- tmux sessions started under the old `agentdock-*` prefixes keep being
  recognised, so live cards and the orchestrator survive the upgrade.
- Run `nautelle-runner install-service` once: it stops and removes the old
  `agentdock-runner` unit or agent and installs the new one. After an npm
  install this is required, because the old unit points into a package that
  is gone.
- npm: `npm i -g nautelle-runner`, then `npm rm -g agentdock-runner`. The
  `agentdock-runner` package is now a deprecated shim that installs
  `nautelle-runner` and runs it.
- Homebrew: `brew upgrade` follows the formula rename, and the formula keeps
  an `agentdock-runner` link to the new binary. Swap the service with
  `brew services stop agentdock-runner` and
  `brew services start nautelle-runner`.
- The Claude Code plugin is now `nautelle`, and its MCP tools are
  `mcp__plugin_nautelle_nautelle__*`. `nautelle-runner setup claude` replaces
  `agentdock@agentdock` with it; by hand: `claude plugin uninstall
  agentdock@agentdock`, `claude plugin marketplace remove agentdock`,
  `claude plugin marketplace add AndreyBegma/Nautelle` and
  `claude plugin install nautelle@nautelle`.
- Hooks already written into a running card's settings call the old binary
  path; the `agentdock-runner` link (npm shim or Homebrew) keeps them working
  until the card ends.
- Webhooks are sent and accepted under both `X-Nautelle-*` and the old
  `X-AgentDock-*` headers until runner 0.16.0.

- A runner started on a `runner.json` with no `policy` block — one written
  before 0.13 — logs and prints an upgrade notice: it watches no project,
  which projects it watched before, and the commands that allow them. It
  allows nothing itself ([ADR-0047](../../docs/adr/0047-a-runner-local-security-policy-the-server-cannot-change.md)),
  and the daemon no longer writes a default `policy` block into that file, so
  the notice repeats on every start until you set a policy (#691).
- `agentdock-runner policy allow-root --watched [--yes]` allows the roots of
  the projects in the cached watch list, after showing them and asking.
- The runner reports the projects its policy refuses
  (`runner.watch_refused`), and the web app shows on each such project why and
  the exact command to run on the runner's machine. A refusal of a root now
  names that root in its command instead of `<dir>`.

## 0.13.0

### Upgrade note

0.13 adds the runner-local security policy
([ADR-0047](../../docs/adr/0047-a-runner-local-security-policy-the-server-cannot-change.md)):
a `policy` block in `runner.json` that only the CLI on the machine writes. Its
`allowedRoots` is empty by default, and the runner watches only projects whose
root is inside an allowed root. **A runner upgraded from 0.12 or earlier
therefore watches no project until you allow their folders**: the Board, card
collect and the Planner stop for every project of that runner.

On every machine that runs the runner, after the upgrade:

```sh
agentdock-runner policy allow-root --watched   # the roots it watched before (from the next release)
# or name the folders yourself:
agentdock-runner policy allow-root ~/dev
agentdock-runner policy show
```

A running daemon picks the change up within 5 s; no restart is needed. The
server cannot do this for you: no message from it changes the policy.
