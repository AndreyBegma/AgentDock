# C-292: Upgrading the runner to 0.13 silently stops watching every project

Issue: #691

## What happens
Runner 0.13.0 adds the local policy (ADR-0047) with `allowedRoots` defaulting to `[]`. On the devbox, after `npm i -g agentdock-runner@0.13.0` and a restart, the runner connected normally but dropped every project from its watch list. The journal only showed `watch list: project refused by policy … this runner allows no project root yet`. The Board, card collect and Planner for every project stopped working. Nothing in the web app said why: the runner showed as online. Fixing it took `agentdock-runner policy allow-root /home/archi/dev` by hand.

## What to do
- **Make the refusal visible.** The runner reports the projects it refused and why (a typed event, ADR-0010). The web app shows it on the project (runner status, Board header, project settings), together with the exact command to run on the runner's machine.
- **Make the upgrade say so.** When the runner starts with a config that has no `policy` block (an upgrade from before 0.13), it prints a loud notice in the journal and on the terminal, listing the roots of the projects it used to watch (from its cached watch list) and the `allow-root` command for them. It does **not** allow them by itself: only the person changes the policy (ADR-0047).
- Add a convenience command `agentdock-runner policy allow-root --watched`, which allows the roots of the projects in the cached watch list after showing them and asking for confirmation (`--yes` skips the question).
- Add an upgrade note for 0.13 to the runner docs and the release notes.

## Acceptance criteria
- [ ] With empty `allowedRoots`, the project page in the web app says the runner refuses the project and shows the command to fix it. An API e2e spec and a web test cover this.
- [ ] Starting the runner on a pre-0.13 config logs the upgrade notice with the cached project roots. A runner spec covers this.
- [ ] `policy allow-root --watched` adds exactly the cached roots after confirmation. A runner spec covers this.
- [ ] The server still cannot change the policy.
- [ ] `bun run check` passes.
