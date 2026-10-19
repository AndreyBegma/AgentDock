# C-241: Let the assistant read code and delegate code questions to the runner

Issue: #622

## What to do
The control plane never reads a project's files itself (ADR-0001), and the runner accepts only typed commands (ADR-0010) that it advertises (ADR-0023). Give the assistant both paths:
- **Fine-grained tools.** New runner commands `repo.search` and `repo.read`, exposed as the assistant tools `search_code` and `read_file`.
  - Read-only, with size-capped output, confined to the project checkout.
  - They refuse `.env*`, key files, and whatever the runner-local policy (ADR-0047) denies.
- **Delegation.** A runner command `code.ask` that runs a read-only Claude Code session in the repository, as Planner turns do (ADR-0019), and returns its answer. It is exposed as the tool `ask_code_agent`.

The model decides whether to read the code itself or delegate the question. When no runner is online, the tools return a typed error, and the assistant explains that code questions need a runner. Record a new ADR describing how this relates to ADR-0001.

## Acceptance criteria
- [ ] The runner advertises the three commands and rejects paths outside the checkout; tests cover path traversal.
- [ ] Secret and policy-denied files are never returned, and outputs are capped.
- [ ] "Where is X implemented" with an online runner gets an answer that cites real files.
- [ ] A `code.ask` session cannot write files or run write commands.
- [ ] With the runner offline, the tools return a typed error and the assistant says so instead of guessing.
- [ ] A new ADR records the design.

## Out of scope
- Writes to the repository.
- UI beyond the existing tool activity blocks.

## Open questions
- Sending code to providers other than Anthropic. Default: `search_code` and `read_file` are offered only with Anthropic models; other providers get only `ask_code_agent`.
