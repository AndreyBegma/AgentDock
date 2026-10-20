# C-257: Survey open-source token-saving tools and record what Nautelle adopts

Issue: #650

## What to do
Survey open-source projects that cut LLM coding-agent token use, and compare each with what Nautelle already does (ADR-0039, `apps/runner/src/filter/`, `apps/runner/src/launch/token-saver.ts`). At least: rtk-ai/rtk (command output rewriting), caveman-style terse output skills, Serena (symbol-level code retrieval over MCP), zilliz claude-context (semantic code search), Microsoft LLMLingua (prompt compression), ccusage (usage measurement), plus any others found.

For each, record:
- the technique;
- the measured or claimed savings, with a source;
- its licence (rtk's engine is BUSL-1.1 — no code copying);
- whether it fits ADR-0001 (the control plane never reads a project's files) and ADR-0010 (typed commands);
- a verdict: adopt, adapt or reject.

Write it to `docs/research/token-saving-survey.md`. For each "adopt" or "adapt" verdict, add a short follow-up proposal in the same doc. Do not create issues.

## Acceptance criteria
- [ ] `docs/research/token-saving-survey.md` covers at least 8 projects, each with technique, evidence link, licence and verdict.
- [ ] Every claimed savings figure cites its source; unverified claims are marked as such.
- [ ] Each adopt/adapt verdict names where in Nautelle it would land (file or launch) and a rough size.
- [ ] No product code changes in the PR.

## Out of scope
- Implementing any of the findings.
- Adding dependencies.

## Open questions
None.
