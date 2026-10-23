# ADR-0063: The assistant reads code only through the project's runner

Status: accepted, §1 amended by [ADR-0075](0075-agent-instruction-files-may-be-stored-as-prefix-overlays.md) · Date: 2026-10-17 ·
Card: C-241 (stack S-3, stage 3) ·
Issue: [#622](https://github.com/AndreyBegma/AgentDock/issues/622) ·
Spec: [`docs/specs/622-let-the-assistant-read-code-and-delegate.md`](../specs/622-let-the-assistant-read-code-and-delegate.md) ·
Keeps: [ADR-0001](0001-control-plane-and-per-machine-runner.md), [ADR-0010](0010-typed-command-allowlist-on-the-runner.md), [ADR-0019](0019-planner-instructions-live-in-agentdock.md), [ADR-0023](0023-runners-advertise-their-commands.md) ·
Amends: [ADR-0047](0047-a-runner-local-security-policy-the-server-cannot-change.md) (a new rule, `code.deny`) ·
Builds on: [ADR-0059](0059-the-api-calls-llm-providers-directly-for-assistant-features.md), [ADR-0060](0060-assistant-conversations-are-personal-and-bilingual-from-one-model-call.md)

## Context

The assistant of ADR-0060 answers from what the API stores: the Board, the
fleet, the queue, budgets and sessions. People also ask it about the code —
"where is X implemented", "what calls Y". The code lives only on the machines
whose runners watch the project: ADR-0001 keeps the control plane away from
a project's filesystem, ADR-0010 lets the runner run typed commands only, and
ADR-0023 has it advertise the commands it serves.

Two ways to answer are wanted, and the model chooses between them:

- **reading the code itself** — a search, then the lines around a match — which
  is cheap and precise, but puts source code in the provider's context;
- **delegating the question** to a Claude Code session next to the code, as
  Planner turns read the code (ADR-0019), which suits a broad question and
  sends the provider only the answer.

## Decision

1. **The API still never reads a project's files.** It sends the project's
   runner one of three new typed commands, and only what the runner answers
   reaches the model. The control plane does not cache, index or store code:
   a tool result lives in the turn and in the stored reply's tool steps,
   bounded as every tool result is (ADR-0060 §6). ADR-0001 is kept: the API
   asks; the runner reads its own checkout, as it already does for
   `project.inspect`, `worktree.status` and Planner turns.

2. **Three commands, all read-only, all minimum role viewer.**
   - `repo.search` — `git grep` over the files git knows in the watched main
     checkout: tracked files, and untracked files git does not ignore. Binary
     files are skipped. It returns at most 100 matches of 300 characters each,
     and at most 20 per file.
   - `repo.read` — the lines of one file git knows: at most 400 lines and
     24,000 characters, and a file of at most 2 MiB that is not binary.
   - `code.ask` — one headless Claude Code session in the checkout, with the
     question on stdin. It returns the final answer, cut at 12,000 characters.

   The runner serves all three in every build, so it advertises them in
   `hello` (ADR-0023). The API checks the advert, and the connection, before
   it sends one.

3. **Confinement is the runner's check, not the schema's.** The args schema
   only bounds a path's length and characters, so a `..` reaches the runner
   and is refused there. On the runner:
   - `projectId` and `root` must be one watch-list entry, and `root` must be
     inside `allowedRoots` (ADR-0047 §4, checked before any handler);
   - a path must be relative, and must stay inside after normalization;
   - its real path must be inside the checkout's real path, so a symlink out
     is refused;
   - `repo.read` reads a regular file only (`O_NOFOLLOW`), and only one that
     git lists, so a file the checkout ignores, such as a local config, a
     build output or `.env`, is never read.

   A refusal is `path_not_allowed`.

4. **Secrets are refused always; the policy can refuse more.**
   - Every runner refuses these names, in any letter case and at any depth,
     whatever the policy says: `.env*`, private keys and key stores (`*.pem`,
     `*.key`, `*.p12`, `id_rsa*` and the like), credential files (`.npmrc`,
     `.netrc`, `credentials.json`…), and the directories `.git`, `.ssh`,
     `.gnupg` and `.aws`.
   - The checks run on the name as given and on the real path. A symlink to
     `.env` is refused too.
   - ADR-0047 gains one rule, `code.deny`: a list of globs over checkout
     paths. A pattern without `/` matches a name at any depth; one with `/`
     matches from the checkout's top. It is empty by default.
   - `agentdock-runner policy deny-path` and `allow-path` are its only
     writers. It is reported in `hello` as `policy.code.deny`, and the
     runner's page shows it.
   - `repo.read` of a denied path is `policy_refused` with the rule
     `code.deny`. `repo.search` withholds matches in secret or denied files
     and returns only how many it withheld.

5. **`code.ask` cannot write or run anything.** The session is the
   Planner's headless launch (ADR-0019), made stricter:
   - `--permission-mode plan`;
   - `--tools Read,Grep,Glob` — the only tools it has, and none of them
     writes;
   - `--disallowedTools` with `Bash`, `Edit`, `Write`, `NotebookEdit`,
     `WebFetch`, `WebSearch` and `Task`, in case the profile's settings bring
     one back;
   - `Read(…)` deny rules for every secret name and every `code.deny`
     pattern, and for the person's key directories in their home. Claude
     Code applies Read rules to Grep and Glob as well.
   - `Read(…)` deny rules for every entry beside the checkout, at each level
     from `/` down to the checkout's parent. Claude Code's read tools read any
     path the user can, plan mode or not. A check on a real runner read
     `/etc/hostname` before these rules were added.
   - `--strict-mcp-config`, so no MCP server is loaded.
   - `--setting-sources user`, so the checkout's own `.claude/settings.json`
     cannot add a hook, a tool or an MCP server.
   - `AGENTDOCK_HOOKS=off`.

   The question is wrapped in tags and marked as data in the prompt. The
   session runs on the project's Claude runtime profile (#272 D1), with the
   model `sonnet`. A codex profile is refused.

6. **Spend.** A `code.ask` is a run of the new kind `code_ask`, opened by the
   API and closed when the command ends. The session's telemetry carries the
   run, so its spend counts against the project's budget. The budget gate is
   checked before the run is opened, as for every start that spends. `repo.search` and
   `repo.read` spend nothing on the runner. The model calls around them are
   the assistant's own `llm_calls` (ADR-0059).

7. **Which provider gets which tool.**
   - `search_code` (`repo.search`) and `read_file` (`repo.read`) put source
     code in the model's context. They are offered only with Anthropic models.
   - `ask_code_agent` (`code.ask`) sends the provider only the answer of a
     Claude Code session that ran on the person's machine. It is offered with
     every provider.
   - A tool that is not offered with the turn's provider is neither listed
     nor run when the model names it.
   - The system prompt tells the model which of the two ways it has: read the
     code itself for a focused question, delegate a broad one, cite only paths
     a tool returned, and never guess.

8. **Typed errors.** A code tool fails as a tool error `{ error, code }`, never
   as data. The codes are:
   - `runner_offline` — no connection;
   - `runner_unsupported` — the runner does not advertise the command, or its
     config disables it;
   - `runner_no_answer` — the command timed out or the connection was lost;
   - `policy_refused`, `path_not_allowed`, `path_not_found` — the runner's
     own codes, passed on with its message;
   - `no_claude_profile`, `budget_exceeded` — `ask_code_agent` only;
   - `runner_error` — anything else.

   The system prompt tells the model that a code question needs the project's
   runner online and up to date, and that it must say so instead of
   answering from memory.

## Consequences

- With a runner online, the assistant answers code questions with real file
  references. With every runner offline it says it cannot, and the rest of
  the assistant keeps working (ADR-0059).
- Source code reaches Anthropic when an Anthropic model reads it with
  `search_code` or `read_file`. Other providers see only `ask_code_agent`'s
  answer, which may quote code too. Sending code to other providers directly
  needs a new decision.
- The runner reads more on the server's behalf. The reads are bounded,
  read-only, inside a watched checkout under `allowedRoots`, and never of a
  secret or a denied path. A person who wants a part of a repository kept
  from the assistant adds a `deny-path` on the machine; the server cannot
  lift it.
- The deny rules of `code.ask` rest on Claude Code's permission rules. The
  rules beside the checkout are listed at launch, so a directory created at
  `/` during a session is not covered. `repo.search` and `repo.read` do not
  depend on Claude Code: the runner checks every path itself.
- `code_ask` is a new value of the `RunKind` enum (a migration), and it shows
  in History.
- Rejected:
  - **An API-side clone or index of the repository.** It breaks ADR-0001 and
    would keep a second copy of every customer's code on the instance.
  - **A shell command for search** (`rg` with arguments from the model). It
    breaks ADR-0010, and `git grep` already respects `.gitignore` and skips
    binaries.
  - **Offering the read tools with every provider.** It was left open in the
    card, and the default is kept until a person decides otherwise.
