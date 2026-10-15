# Architecture decision records

Numbered, never rewritten. A changed decision gets a new ADR that supersedes the old one.

| ADR | Decision |
|---|---|
| [0001](0001-control-plane-and-per-machine-runner.md) | Control plane and per-machine runner |
| [0002](0002-structured-orchestrator-events-markdown-as-fallback.md) | Structured orchestrator events, markdown as fallback |
| [0003](0003-usage-from-opentelemetry-transcripts-as-backfill.md) | Usage from OpenTelemetry, transcripts as backfill |
| [0004](0004-github-issues-are-the-task-queue.md) | GitHub issues are the task queue |
| [0005](0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md) | Drive the cs-orchestrator skill, do not reimplement it |
| [0006](0006-runtime-adapters-and-runtime-profiles.md) | Runtime adapters and runtime profiles |
| [0007](0007-postgresql-only.md) | PostgreSQL only |
| [0008](0008-local-accounts-with-admin-approved-registration.md) | Local accounts with admin-approved registration |
| [0009](0009-api-equivalent-cost-from-a-versioned-price-table.md) | API-equivalent cost from a versioned price table |
| [0010](0010-typed-command-allowlist-on-the-runner.md) | Typed command allowlist on the runner |
| [0011](0011-glass-ui-is-the-component-library.md) | glass-ui is the component library |
| [0012](0012-detect-where-a-projects-documentation-lives.md) | Detect where a project's documentation lives |
| [0013](0013-codex-workers-and-their-fence.md) | Codex workers and their fence |
| [0014](0014-server-originated-events-live-in-events.md) | Server-originated events live in `events` |
| [0015](0015-schedules-run-on-bullmq.md) | Schedules run on BullMQ (amends ADR-0007) |
| [0016](0016-staging-on-the-agent-host-behind-a-cloudflare-tunnel.md) | Staging on the agent host behind a Cloudflare tunnel |
| [0017](0017-runner-distribution-homebrew-and-npm.md) | The runner ships as prebuilt binaries through Homebrew and npm |
| [0018](0018-pull-requests-test-what-changed.md) | Pull requests test what changed; develop is not tested twice (amends ADR-0016) |
| [0019](0019-planner-instructions-live-in-agentdock.md) | The Planner's instructions live in AgentDock, editable, behind a fixed output contract (scopes ADR-0005) |
| [0020](0020-claude-code-integration-through-the-runner.md) | Claude Code integration — hooks observe, MCP acts, both through the runner (amends ADR-0010) |
| [0021](0021-session-content-is-opt-in-per-project.md) | Session content is opt-in per project (amends spec 12 D9) |
| [0022](0022-design-stage-html-mockups-from-a-ui-profile.md) | The design stage draws HTML mockups from a cached UI profile — no external design tool, no dev server |
| [0023](0023-runners-advertise-their-commands.md) | Runners advertise their commands; features check commands, never versions |
| [0024](0024-board-cards-and-dedicated-card-workers.md) | Board cards are work items AgentDock owns; each runs a dedicated interactive worker outside the orchestrator (amends ADR-0004, scopes ADR-0005) |
| [0025](0025-a-design-has-one-owner-a-plan-task-or-a-board-card.md) | A design has exactly one owner — a plan task or a board card (amends ADR-0022 §3) |
| [0026](0026-card-capture-reads-opt-in-session-content.md) | Card capture reads opt-in session content with a small model on the project's runner (amends ADR-0021) |
| [0027](0027-stored-text-is-normalized-to-english-on-the-runner.md) | Stored text is normalized to English on the runner (extends ADR-0026) |
| [0028](0028-one-work-surface-for-cards-and-plan-tasks.md) | One work surface: plan tasks are projected read-only onto the Board, one List replaces Tasks (scopes ADR-0024 §2) |
| [0029](0029-accepting-a-board-card-may-merge-its-pull-request-through-the-runner.md) | Accepting a board card may merge its pull request through the runner (amends ADR-0024 §6) |
| [0030](0030-terminal-work-and-fleet-work-appear-on-the-board.md) | Terminal work and fleet work appear on the Board (amends ADR-0024 §1 and §6) |
| [0031](0031-attachments-are-stored-by-the-api-on-a-local-volume.md) | Attachments are stored by the API on a local volume and reach the card worker through the runner |
| [0032](0032-a-cards-model-is-recommended-by-a-runner-side-assessment.md) | A card's model is recommended by a runner-side `haiku` assessment; profile and model are picked at launch (extends ADR-0027) |
