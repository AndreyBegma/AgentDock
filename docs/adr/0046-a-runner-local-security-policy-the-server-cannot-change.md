# ADR-0046: A runner-local security policy the server cannot change

Status: accepted · Date: 2026-10-16 ·
Card: C-107 (security audit 2026-10-16, WI-05, finding F-06, decision D-01) ·
Spec: [`docs/specs/card-107-security-high-add-a-runner-local-securit.md`](../specs/card-107-security-high-add-a-runner-local-securit.md) ·
Amends [ADR-0010](0010-typed-command-allowlist-on-the-runner.md) · Scopes [ADR-0045](0045-a-person-may-message-a-running-session-the-orchestrator-is-told.md) §1

The card and the audit named this decision ADR-0044. That number was taken by
the time it landed, so the decision is ADR-0046.

## Context

ADR-0010 makes the runner accept typed commands only: a fixed allowlist, each
command with a strict args schema, no shell strings. That stops a server from
asking the runner to run `rm -rf ~`. It does not stop a server from sending a
*dangerous instance* of an allowed command:

- `card.run`, `card.resume`, `skill.run` and `orchestrator.start` take the
  prompt and the `permissionMode` from the args, so `bypassPermissions` with an
  arbitrary prompt is whatever the server sends;
- `terminal.attach` in `write` mode types raw keystrokes into a live session;
- a profile-scope `skill.install` copies any GitHub repository into the
  person's Claude profile, where every later session loads it;
- the watch list roots are a plain string from the server, and every command
  that takes a `root` trusts the watch list.

Whoever controls the API therefore runs code as the developer on every paired
machine: a compromised server, a stolen runner token used against a fake
server, or a taken-over admin account. The runner is the only party that can
say no, and today it never does.

## Decision

1. **A `policy` block in `runner.json`, written only on the machine.** The
   runner's own config holds the policy:
   - `allowedRoots` — directories a project root may live under (none by
     default; `pair --allow-root <dir>` and `policy allow-root` add them);
   - `maxPermissionMode` — the highest permission mode a launch may ask for,
     `auto` by default (`manual` < `acceptEdits` < `auto` <
     `bypassPermissions`);
   - `terminal.write` — `false`;
   - `skills.profileInstall` — `false`;
   - `commands.<name>` — an explicit list of other dangerous commands, each
     `false`: `orchestrator.message`, `slot.message` and `session.message`.

   `agentdock-runner policy show|set|allow-root|deny-root` and
   `pair --allow-root` are its only writers. The daemon reads it and never
   writes it: when it caches the watch list or `ingestSince` into the same
   file, it re-reads the file and keeps the policy on disk as it is
   (`updateConfig`). No message from the server — `welcome`, `config`, any
   command — has a field that reaches it. A running daemon re-reads the file
   within 5 s, so a change takes effect without a restart. A file it cannot
   read gives the safe defaults, never the last policy.

2. **Enforced before any handler.** The dispatcher checks the policy after the
   args parse and before the handler, so a handler never sees a refused
   command. `orchestrator.start` checks it again itself, and the terminal
   manager checks `terminal.write` on attach and on every input frame, so
   turning it off ends the typing of an attach already open.

3. **A typed refusal naming the rule.** A refusal is the new command error
   code `policy_refused`. Its message always has one shape — `refused by this
   runner's policy (<rule>): <why>. On the runner's machine: \`<command>\`` —
   so a person reading it, and the web parsing it, learn which rule and the
   exact line that lifts it. The API answers it with 403 and the code
   `policy_refused` on every surface, passing the message on.

4. **Server roots are validated.** A root in any command's args (and
   `project.inspect`'s `path`) must be absolute and its real path must be
   inside a real path of `allowedRoots`, so a symlink into an allowed root
   that points elsewhere is refused. A watch-list root must also be a git main
   checkout; a refused project is left out of the watch list, its collectors
   do not run and its commands are refused. The watched-project schema
   requires an absolute root.

5. **Reported in `hello`.** The effective policy rides in `hello`
   capabilities — values only, no path beyond `allowedRoots` — so the UI can
   explain a refusal and show the policy on the runner's page. The API reads
   it; it cannot write it back.

6. **Scopes ADR-0045 §1.** `session.message`, `orchestrator.message` and
   `slot.message` type free text into a live agent session whose permission
   mode the policy may not have set — a fleet slot inherits the orchestrator's
   mode, and a person may have started the orchestrator by hand in
   `bypassPermissions`. They stay in the protocol and keep their audit, but a
   runner serves them only after the person turns each on with
   `agentdock-runner policy set commands.<name> true`.

## Consequences

- The allowlist (ADR-0010) says which commands exist; the policy says which
  instances of them this machine accepts. A server, real or fake, can no
  longer run `bypassPermissions`, type into a terminal, install into a
  profile, or point the runner at a directory the person did not allow.
- **Upgrading needs one step on each machine.** A runner with no
  `allowedRoots` watches no project, and rounds and runs above `auto` are
  refused. The daemon logs it at start, `policy show` lists the cached
  projects that are now outside, and the runner page and every refusal name
  the command to run. Messaging a running session (#489) is off until turned
  on.
- `policy_refused` is a new enum value on the wire. An API older than it drops
  the `command.result` and the caller sees a timeout, so the API is deployed
  before the runners.
- The policy is not a sandbox. Below the cap, an agent in `auto` still runs
  what the server's prompt asks within Claude Code's own permission checks;
  the policy bounds the blast radius, it does not make a hostile server safe.
- A tighter policy does not stop a session already running in a mode it now
  refuses; the person stops that session on the machine.
