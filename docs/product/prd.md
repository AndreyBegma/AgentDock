# Product requirements — AgentDock

Status: draft · Owner: Andrey Begma · Last reviewed: 2026-10-07

## Problem

The Code Sentinel orchestrator (`/code-sentinel:orchestrator`) runs a fleet of
agent sessions unattended: one tmux session and one git worktree per slot, a
markdown board inside `.git`, reply files in each worktree, labels on GitHub.
It works, but:

- **Nothing shows the whole fleet.** What is running, on which model, what each
  slot last reported, what merged today — answering any of these means
  `tmux ls`, reading markdown inside `.git`, and `gh pr list`, per project.
- **Nothing remembers.** The watch stream is stdout; history is scattered over
  daily board folders. Cost and tokens are not recorded anywhere.
- **It is Claude-only and machine-bound.** Codex cannot take a slot. A fleet on
  the server cannot be watched from elsewhere except by phone Remote Control,
  one session at a time.
- **Skills are run by hand**, project by project, with no schedule and no record.

## Users

| Persona | Needs |
|---|---|
| **Owner / admin** (one person today) | run fleets on several projects, see everything, approve merges and new users, control spend |
| **Operator** (invited teammate) | watch and steer fleets on assigned projects, run skills |
| **Viewer** (stakeholder) | see progress, history and cost on assigned projects |

## Goals

1. One screen answers: what is every agent on every project doing right now,
   on which runtime and model, and what is blocked on a person.
2. Every run — orchestrator slot, skill run, scheduled job — is recorded with
   its outcome, tokens and API-equivalent cost.
3. The fleet can be steered from the UI without opening a terminal: start/stop
   the orchestrator, stop a slot, message a worker, approve a merge.
4. Claude Code and Codex are equal citizens behind one adapter interface, each
   launched through a configurable runtime profile (e.g. `claude rc` =
   `CLAUDE_CONFIG_DIR=~/.claude-profiles/blacktoorroot`).
5. Works locally and remotely: the control plane talks to a runner on each
   machine, never to the machine's filesystem directly.

## Non-goals

- Reimplementing the orchestrator's scheduling logic. AgentDock drives the
  `cs-orchestrator` skill and observes it (ADR-0005).
- A task tracker of its own. GitHub issues are the queue (ADR-0004).
- Prompt management, evals, LLM-as-judge, datasets.
- Arbitrary remote shell. The runner executes a typed allowlist only (ADR-0010).

## Feature areas

Delivery order is in [roadmap.md](roadmap.md).

| Area | Summary |
|---|---|
| **Auth & access** | first admin seeded by CLI; email + password; registration toggled by admin; new accounts wait for admin approval, which assigns a role; roles admin / operator / viewer; per-project access |
| **Runners** | daemon per machine, paired by one-time code, outbound WebSocket, heartbeat, capabilities (runtimes, profiles, tmux, gh) |
| **Projects** | connect a local repository path on a runner; detect origin, config, base branch, and **where its documentation lives** (in-repo or separate repo, ADR-0012) |
| **Agent fleet** | live slots: issue, branch, worktree, runtime, model, last checkpoint, PR + checks, idle/quota/prompt state |
| **Orchestrator control** | start / stop / `next` / `status` per project through a runtime profile; stop a slot; message a worker; open a read-only live pane |
| **Task queue** | GitHub issues with the ready label and their computed state (READY / IN FLIGHT / BLOCKED — work / BLOCKED — person / NO SPEC); create an issue from the UI |
| **Merge approval** | per-project switch; green PRs wait in an approval queue (Approve / Request changes) when on |
| **Activity feed** | every event across projects, filterable, live |
| **Sessions** | Claude Code and Codex sessions of connected projects (all sessions for admin): turn → LLM request / tool / subagent tree, waterfall, tokens and cost per node |
| **Execution history** | rounds, slots, skill runs, scheduled runs — outcome, duration, PR, tokens, cost |
| **Cost & tokens** | API-equivalent cost from a versioned price table; by project, issue, slot, model, runtime, user, day; budgets (alert or hard stop) per project and per user |
| **Skills** | browse skills.sh; install to a project or globally, per runtime; run a skill on a project with chosen runtime profile and model, in an isolated worktree; output is a report or a PR (configurable) |
| **Cron** | schedule = skill/orchestrator command + project + args + profile + model; runner executes; missed-run policy (skip / catch up) |
| **Webhooks** | inbound (signed POST → run a skill / wake orchestrator; GitHub App events) and outbound (signed, retried, delivery log, test button) |
| **Notifications** | in-app centre + Telegram bot (gate, credential, decision, prompt pane, queue dry, budget) |
| **Audit** | append-only, hash-chained log of every privileged action with before/after |
| **Codex** | Codex workers in orchestrator slots and Codex as orchestrator, both selectable per project |

## Success measures

- From the dashboard, answering "what is blocked on me" takes one click, with
  no terminal open.
- 100% of slot and skill runs carry tokens and cost (OTel or transcript backfill).
- A runner on another machine pairs and shows its fleet in under five minutes.

## Constraints

- Stack fixed by `cs-init`: Bun, Turborepo, NestJS 11, Prisma 7, PostgreSQL 16,
  Next.js 16, React 19, Tailwind 4.
- UI built only from [glass-ui](https://github.com/AndreyBegma/glass-ui);
  missing components are added there, not here (ADR-0011).
- First deployment: the owner's server, the same machine as the projects —
  control plane in Docker Compose, runner as a host process.
