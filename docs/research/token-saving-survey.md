# Survey: open-source token-saving tools and what AgentDock adopts

Issue: [#650](https://github.com/AndreyBegma/AgentDock/issues/650) ·
Spec: [`docs/specs/650-survey-open-source-token-saving-tools-an.md`](../specs/650-survey-open-source-token-saving-tools-an.md) ·
Date: 2026-10-19

## Scope and method

This survey compares nine open-source projects that cut the tokens a coding
agent reads or writes with what AgentDock already does:

- [ADR-0039](../adr/0039-token-saver.md) — the decision;
- `apps/runner/src/filter/` — the command-output filter (families `js`, `lang`,
  `ops`), the read guard (`read-guard.ts`) and the eco switch (`eco.ts`);
- `apps/runner/src/launch/token-saver.ts` — the launch wiring: filter hook,
  haiku `scout` subagent, earlier compaction (`COMPACT_AT_TOKENS`),
  `--strict-mcp-config` with a per-project allowlist.

Each project was read on its public README (and, where noted, its docs page) on
2026-10-19. Nothing was installed or run, and no benchmark was reproduced.

**How to read the savings figures.** Every figure below is quoted from the
linked source and is a *vendor claim* unless the row says otherwise. None of
them was reproduced for this survey. A figure the source itself attributes to a
third party is marked *(cited by the README, not opened)*. Figures differ in
what they measure (command output, response tokens, retrieved context, cost),
so they cannot be compared across rows.

**Fit tests.**

- *ADR-0001*: the control plane (`apps/api`, `apps/web`) never reads a
  project's files; reading is the runner's job. A tool that runs *inside the
  agent's session on the runner machine* does not touch this; a tool that
  needs the control plane to read, index or store project content does.
- *ADR-0010*: the runner accepts typed commands only. A tool fits if it is
  either agent-side (an MCP server or hook the launch wires, not a runner
  command) or reachable as a new typed command with a schema in
  `packages/shared`. A generic "run this shell" path never fits.

## Summary

| # | Project | Technique | Licence | ADR-0001 / ADR-0010 | Verdict |
|---|---|---|---|---|---|
| 1 | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) | Bash output rewriting | Apache-2.0; engine BUSL-1.1 | Idea fits; code cannot be used | **Adapt** (idea only) |
| 2 | [caveman](https://github.com/JuliusBrussee/caveman) | Terse output style | Apache-2.0 | Fits (prompt only) | **Adapt** |
| 3 | [Serena](https://github.com/oraios/serena) | Symbol-level retrieval over MCP (LSP) | GPL-3.0-or-later (app) | Fits as agent-side MCP; licence blocks bundling | **Reject** (bundling) |
| 4 | [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | Semantic search over MCP | MIT | Code leaves the machine | **Reject** (default) |
| 5 | [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) | Prompt compression by a small LM | MIT | Fits only as a heavy sidecar | **Reject** |
| 6 | [ccusage](https://github.com/ryoppippi/ccusage) | Usage and cost from local logs | MIT | Fits; already covered | **Reject** (covered) |
| 7 | [Aider repo map](https://aider.chat/docs/repomap.html) | Ranked symbol map under a token budget | Apache-2.0 | Fits as a runner-side step | **Adapt** |
| 8 | [Repomix](https://github.com/yamadashy/repomix) | Repo packing; tree-sitter `--compress` | MIT | Fits; packing works against us | **Reject** (folded into 7) |
| 9 | [context-mode](https://github.com/mksglu/context-mode) | Sandboxed execution; raw output kept out of context | ELv2 (badge, LICENSE not read) | Fits; licence blocks copying | **Adapt** (idea only) |

No project earns a plain **adopt**: AgentDock ships its own binary
(ADR-0017), the licences of the strongest candidates (BUSL-1.1, GPL-3.0, ELv2)
rule out copying or bundling, and the rest either overlap what ADR-0039
already does or send code off the machine.

## 1. rtk (rtk-ai/rtk)

- **Technique.** A single Rust binary. A PreToolUse hook rewrites a Bash
  command to its `rtk` equivalent (`git status` → `rtk git status`); the output
  is filtered, grouped (files by directory), truncated and deduplicated with
  counts. 100+ commands. The hook fires only on Bash, not on Read, Grep or
  Glob. Optional `rtk claude` runs a proxy daemon over provider-API traffic.
- **Claimed savings.** "60–90 %" on common dev commands (repository
  description) and "up to 90 % smaller" bash output (README header). The README
  itself says this covers only the bash output the agent reads, that tokens are
  estimated as bytes ÷ 4 (no tokenizer), and that the share of the whole bill
  is smaller. Source: <https://github.com/rtk-ai/rtk>. The per-command detail
  is in the project's "How RTK Savings Work" document, which was not read.
  *Unverified here.*
- **Licence.** The README splits it: the `rtk` CLI is Apache-2.0; the
  `rtk-engine` (in `engine/`) is Apache-2.0 + BUSL-1.1, with an Additional Use
  Grant that allows production use only as part of the `rtk` binary — not alone
  or inside another product; `rtk-proxy` is BUSL-1.1. **No code is copied.**
  (ADR-0039 and the card record the engine as BUSL-1.1; the README's wording is
  more nuanced but the conclusion is the same. Re-read the licence files before
  any reuse question comes up.)
- **Fit.** The technique is already implemented clean-room in AgentDock
  (`filter/families/*`, ADR-0039 decision 1). ADR-0001: runner-side, fits.
  ADR-0010: the hook is a launch setting, not a runner command, fits.
- **What AgentDock does that rtk does not (per its README).** Read guard and
  read dedup (`read-guard.ts`), a raw-output file per run, `AGENTDOCK_RAW=1`
  bypass, a regression corpus asserting error lines survive, permission-mode
  aware rewriting (ADR-0039 decision 7).
- **Verdict: adapt (idea only).** Use rtk's published command list as a
  *coverage checklist* against `filter/families/`, not as a source of code or
  filter logic. See proposal P1.

## 2. caveman-style terse output (JuliusBrussee/caveman)

- **Technique.** A prompt/skill that makes the agent answer first, one idea per
  sentence, drop articles, keep code, errors, numbers and negations verbatim,
  and use full sentences for security warnings and irreversible actions. User
  prompts are left untouched.
- **Claimed savings.** All from <https://github.com/JuliusBrussee/caveman>:
  - repository description: "cuts 65 % of tokens" — no benchmark linked there;
  - ten developer questions on claude-opus-5-5, output tokens: 6,983 with no
    instruction, 4,334 with "Answer concisely.", 4,119 with `/caveman`, 2,693
    with `/ultracave` — author-run, measured on older rules and not re-run, so
    against a plain "be concise" baseline `/caveman` gains about 3 % and
    `/ultracave` about 35 % (the README's own caveat);
  - 8.5 % fewer output tokens, 86 coding tasks, no measurable quality loss,
    p = 0.82 — attributed to JetBrains *(cited by the README, not opened)*;
  - 63.6 % fewer response tokens — Elastic Labs, with a remade mode *(cited by
    the README, not opened)*;
  - the README also warns the rules cost about 1,160 input tokens, so on
    per-request pricing savings can be zero.
  The honest range for a coding agent is therefore single digits to about 40 %
  of *output* tokens, which are a minority of input+output volume.
- **Licence.** Apache-2.0 (the sidebar also lists MIT; see the repo's
  `LICENSING.md`). Trademarks on the name and logo.
- **Fit.** Prompt only. ADR-0001 and ADR-0010 not engaged.
- **Already in AgentDock.** The two-register rule of ADR-0039 decision 4: terse
  work, full prose for anything a person reads, enforced on `finish_card`.
  This is the same idea with the same safety carve-out.
- **Verdict: adapt.** Do not import the skill; AgentDock's register is
  stricter about what stays full-length. Take the one thing it has that we do
  not: *measurement of the register's effect*. See proposal P2.

## 3. Serena (oraios/serena)

- **Technique.** An MCP toolkit giving symbol-level find / find-references /
  rename / replace-body over language servers (40+ languages) or a paid
  JetBrains plugin. In Claude Code its basic file and shell tools are disabled
  by default.
- **Claimed savings.** None quantified. The README says only that symbolic
  editing is "much more token-efficient"; a user quote gives a step count
  (8–12 steps collapsing to one call), not tokens. It points to an evaluation
  of about 20 tasks in its docs, whose results were not read. Source:
  <https://github.com/oraios/serena>. *Unverified.*
- **Licence.** Application GPL-3.0-or-later; SolidLSP (`src/solidlsp`) MIT; a
  combination is GPL as a whole; contributions need a CLA. Bundling or linking
  it into the runner binary is out. Running it as a separate process the user
  installs is not a licence problem for AgentDock.
- **Fit.** An agent-side MCP server on the runner machine: ADR-0001 not
  violated, ADR-0010 not engaged. Needs a language server per language per
  project — a setup cost AgentDock should not own.
- **Verdict: reject** as something AgentDock ships or wires by default. A
  project that wants it already can: the per-project MCP allowlist of ADR-0039
  decision 3 admits any server in the profile. Worth one line in the Token saver
  guide (P5), nothing more.

## 4. claude-context (zilliztech/claude-context)

- **Technique.** Semantic code search as an MCP server: AST-based chunking,
  hybrid BM25 + dense retrieval, incremental re-indexing with Merkle trees,
  stored in a vector database.
- **Claimed savings.** "~40 % token reduction under the condition of equivalent
  retrieval quality", from the author's own evaluation (method in the repo's
  `evaluation` directory, chart in `assets/`); raw figures not on the README.
  Source: <https://github.com/zilliztech/claude-context>. *Vendor claim,
  unverified.*
- **Licence.** MIT.
- **Fit.** It needs Milvus or Zilliz Cloud (`MILVUS_ADDRESS`, `MILVUS_TOKEN`)
  and an embedding provider (OpenAI, VoyageAI, Gemini or local Ollama), Node
  20+. With a hosted vector DB and hosted embeddings, project source leaves the
  machine; AgentDock is self-hosted software that promises the opposite
  (ADR-0001's reason for the runner). With Milvus and Ollama both local it fits
  technically, but then AgentDock would own a database and an embedding model.
- **Verdict: reject** as a default. As an opt-in it goes through the same MCP
  allowlist as Serena. Not worth wiring.

## 5. LLMLingua (microsoft/LLMLingua)

- **Technique.** A small language model scores tokens and drops the
  uninformative ones (LLMLingua, EMNLP 2023); LongLLMLingua targets
  lost-in-the-middle RAG contexts; LLMLingua-2 is a distilled BERT-level
  token classifier, 3–6× faster.
- **Claimed savings.** "Up to 20× compression with minimal performance loss";
  LongLLMLingua "up to 21.4 % better RAG performance using 1/4 of the tokens";
  the quick-start prints 2,365 → 211 tokens (11.2×), one sample, not a
  benchmark. Papers: <https://aclanthology.org/2023.emnlp-main.825>,
  <https://aclanthology.org/2024.acl-long.91>,
  <https://aclanthology.org/2024.findings-acl.57>; README
  <https://github.com/microsoft/LLMLingua>. The benchmarks are on prose and RAG
  tasks; **no figure for coding-agent transcripts was found.** *Unverified for
  our case.*
- **Licence.** MIT.
- **Fit.** Python plus a model (the README names GPT-2-small, LLaMA-7B,
  phi-2; a quantized 7B needs under 8 GB of GPU memory). The runner is one
  binary (ADR-0017) and installs nothing like that. More important, it would
  rewrite the prompt, which breaks Claude's prompt cache and corrupts exact
  tokens — paths, identifiers, error text — that the filter's regression
  corpus exists to protect (ADR-0039 decision 2).
- **Verdict: reject.**

## 6. ccusage (ryoppippi/ccusage)

- **Technique.** Reads the local usage logs of coding-agent CLIs (Claude Code,
  Codex and about a dozen more), tracks cache creation and cache read
  separately, prices with a LiteLLM price file, supports `--offline`.
- **Claimed savings.** None; it measures. (The only savings figure on its page
  — "40 % lower token usage" — is a sponsor's claim about the sponsor's own
  product.) Source: <https://github.com/ryoppippi/ccusage>.
- **Licence.** MIT.
- **Fit.** Fits, but AgentDock already does this and more:
  [`cost-model.md`](../architecture/cost-model.md) records six token buckets
  per request from OTel and transcripts, with a versioned price table seeded
  from Langfuse's MIT price file. ADR-0039 decision 6 shows the filter's
  estimate next to the measured cost per round.
- **Verdict: reject** (covered). Nothing to import. A one-off use is as a
  cross-check of our totals on a session both can read, which needs no change.

## 7. Aider repo map (Aider-AI/aider)

- **Technique.** Sends the model a concise map of the repository — files with
  their key classes and functions and signatures — ranked by a graph algorithm
  over file dependencies so the most relevant parts fit a budget. Source:
  <https://aider.chat/docs/repomap.html>. (The page does not name tree-sitter;
  that Aider builds the map from tree-sitter parses is **not confirmed by what
  was read** and must be checked before design.)
- **Claimed savings.** None quantified. The only number is the default budget,
  `--map-tokens` = 1k tokens. *No savings claim to verify.*
- **Licence.** Apache-2.0 (<https://github.com/Aider-AI/aider>). Ideas and
  algorithm shape are reusable; code is reusable with attribution, but it is
  Python, so there is nothing to copy into a TypeScript binary.
- **Fit.** The map is built by reading project files, so it must be done by
  the runner (ADR-0001), as a new typed command with a schema in
  `packages/shared` (ADR-0010), never by the control plane. It would replace
  the exploratory Glob/Grep/Read round trips that the `scout` subagent
  currently absorbs at haiku prices.
- **Verdict: adapt.** The only candidate that attacks the largest share of an
  agent's input — exploratory reads — without leaving the machine. It needs a
  parser dependency, which this card may not add; hence a follow-up. See P3.

## 8. Repomix (yamadashy/repomix)

- **Technique.** Packs a whole repository into one AI-friendly file (XML by
  default). `--compress` (marked experimental) uses Tree-sitter to keep
  signatures and replace bodies with `⋮----`.
- **Claimed savings.** "~70 % token reduction" for compression, with no
  benchmark or method given; the MCP docs call the `compress` parameter
  "generally not needed" in favour of incremental `grep_repomix_output`. Source:
  <https://github.com/yamadashy/repomix>. *Unverified.* (The last 7 kB of the
  page were not read.)
- **Licence.** MIT.
- **Fit.** Packing a whole repo is a context-*adding* operation, the opposite
  of reading less; ADR-0001 and ADR-0010 would be satisfied only as a runner
  command, and nothing in the product asks for one.
- **Verdict: reject.** Its one useful idea — signature-only views — is the same
  idea as the repo map and is covered by P3.

## 9. context-mode (mksglu/context-mode)

- **Technique.** An MCP server plus Claude Code plugin hooks: commands run in a
  sandboxed subprocess and only their stdout enters context; session events go
  to SQLite (FTS5, BM25) so state survives compaction; the "Think in Code"
  pattern has the model write a script that prints the answer instead of
  reading many files.
- **Claimed savings.** "315 KB becomes 5.4 KB, 98 % reduction"; 47 `Read()`
  calls at 700 KB versus one `ctx_execute()` at 3.6 KB; per-tool figures such
  as 986 KB → 62 KB. All from the project's own README, which was read in part
  (first 100 kB); its `BENCHMARK.md` was not. Source:
  <https://github.com/mksglu/context-mode>. These are best-case single
  scenarios, byte sizes rather than tokens. *Vendor claim, unverified.*
- **Licence.** The README shows an **Elastic License 2.0** badge; the LICENSE
  file itself was not read. ELv2 is source-available, not OSI open source, and
  forbids offering the software as a managed service. **No code is copied, and
  it should not be bundled.**
- **Fit.** The raw-output-out-of-context part is already ADR-0039 decision 2
  (raw file with a pointer). The session-continuity part overlaps the
  `agentdock` MCP `resume_context` tool. The part we do not have is the
  *behavioural* one: telling the worker to compute instead of read.
- **Verdict: adapt (idea only).** See P4.

## Follow-up proposals

Proposals only; no issue is created and nothing here is implemented by this
card. Sizes are rough (S ≈ under a day, M ≈ a few days, L ≈ a week or more) for
one engineer familiar with the runner.

### P1 — Filter coverage diff against rtk's command list (from 1)

- **Where.** `apps/runner/src/filter/families/{js,lang,ops}/` and their
  `corpus/` fixtures; the list of what is missing goes in a spec, not code
  copied from rtk.
- **What.** Compare the commands rtk documents against the families the
  filter classifies (`classify.ts`); for each gap that real card runs hit
  (the Token saver dashboard's pass-through rate, ADR-0039 decision 6, shows
  which), write a clean-room filter with a corpus case that proves error lines
  survive.
- **Size.** S for the diff, then S per family added.
- **Guard.** Independent filter logic only; nobody who has read rtk's engine
  source writes the filter for that command.

### P2 — Measure the terse register's effect (from 2)

- **Where.** The worker-prompt text built in
  `apps/runner/src/launch/token-saver.ts` (the `CS_ECO` register) and the
  Usage/Token saver views that already compare cost before and after.
- **What.** Record output tokens per round with the register on versus off for
  matched card kinds, and report it next to the filter estimate. Only if the
  measured gain is real, consider a tighter register for text nobody reads
  (tool-call narration); keep the full-prose rule for questions, PR
  descriptions, `finish_card`, specs. Count the register's own input cost
  (caveman reports about 1,160 tokens for its rules) against the saving.
- **Size.** S–M (mostly data plumbing, little code).

### P3 — Runner-side repo map as a typed command (from 7, 8)

- **Where.** A new typed command in `packages/shared` (schema both sides,
  ADR-0010), implemented in `apps/runner/src/` beside the filter, exposed to
  the agent as an MCP tool or as a hook-injected preamble through the launch
  wiring in `launch/token-saver.ts`. The control plane never sees file
  contents (ADR-0001). Needs a new ADR (parser choice, budget, opt-in
  setting) and a parser dependency, which is why it is not done here.
- **What.** Ranked signature map within a token budget (Aider's default is
  1k), cached per commit.
- **Size.** L. Open questions: which languages, which parser, whether it beats
  the `scout` subagent on measured cost per card. Start with a spike that
  measures that on 10 past cards before building.

### P4 — "Compute, don't read" guidance for workers (from 9)

- **Where.** The worker register text in `launch/token-saver.ts`, and the
  scout prompt in `SCOUT_AGENTS`.
- **What.** One paragraph: for questions over many files or large outputs,
  write a short script that prints only the answer, and keep large raw output
  in the file the filter already points to. No new tool.
- **Size.** S. Judge it with the P2 measurement before keeping it.

### P5 — Document the opt-in route for heavy retrieval MCPs (from 3, 4)

- **Where.** The Token saver guide under `docs/guides/`.
- **What.** State that Serena, claude-context and similar servers can be
  allowed per project through the MCP allowlist, with the licence (GPL-3.0)
  and data-egress (hosted vector DB and embeddings) caveats above; AgentDock
  neither ships nor configures them.
- **Size.** S (docs only).

## Open points

- ccusage and Serena/claude-context were not run; the survey is a README read,
  and every savings number is the vendor's.
- rtk's licence wording in its README is finer than ADR-0039's one line.
  ADR-0039 is not edited here (an accepted ADR is superseded, not rewritten);
  the conclusion — no rtk code — is unchanged.
