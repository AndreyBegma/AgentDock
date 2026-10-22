# ADR-0068: The token saver targets context residency, and is judged by cost per round

Status: accepted, §2 amended by [ADR-0074](0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md) · Date: 2026-10-19 ·
Issue: [#663](https://github.com/AndreyBegma/AgentDock/issues/663) ·
Spec: [`docs/specs/663-token-saver-v2.md`](../specs/663-token-saver-v2.md) ·
Amends: [ADR-0039](0039-token-saver.md), [ADR-0032](0032-a-cards-model-is-recommended-by-a-runner-side-assessment.md)

## Context

ADR-0039 built the saver around compressing command output. A 2026-10-19 audit of seven days of fleet usage (719 sessions, about 8.8B tokens) found it saved about 0.002 % of tokens.

Where the cost actually is:
- **Cache reads** are 98–99 % of tokens and 70–87 % of cost.
- **Long sessions.** They run to 300–845k of context because a percentage compaction override on a 1M window compacts at about 600k.
- **The fixed prefix** is about 48–50k and is re-read on every turn.
- **Whole-file reads go through `cat`/`sed` in Bash,** where neither the read guard nor Claude Code's own Read dedup sees them.
- **Prose is only 5–6 % of output tokens.**

Independent paired tests of rtk-style filters and caveman-style output found small output cuts and no lower total cost, sometimes a higher one.

## Decision

1. **Context residency is the first target.**
   - Every runner launch compacts at an absolute 150k window, never at a percentage.
   - The fixed prefix of a runner launch is 25k tokens or less.
   - Card and CI-fix rounds use the one-hour cache TTL and a prefix without dynamic sections.
2. **The metric is cost per round,** by session kind, before and after a change. It comes with the cache-read share, peak context and turns. ADR-0039 §6's saved-bytes estimate stays as a secondary figure. A filter rule family that does not lower cost per round is switched off.
3. **One terse register (amends ADR-0039 §4).**
   - The text lives in `packages/shared` and is printed by `agentdock-runner register`.
   - Every launch uses it, and so does the plugin whenever the runner is installed.
   - Terminal prose is caveman-terse.
   - Pull requests, specs, ADRs, docs, commits, code comments, questions to the person and `finish_card` summaries stay in full prose.
4. **Whole-file reads go through `Read`.** The Bash hook refuses plain `cat`/`head`/`tail`/`sed -n` on a single file and points to `Read`. Processing pipelines pass.
5. **Effort is recommended with the model (amends ADR-0032).**
   - The assessment recommends an effort next to the model. CI-fix and mechanical rounds default to `sonnet` at `low`.
   - The `Explore` subagent runs on `haiku`.
6. **The assistant chat** caches its stable part and sends a bounded history plus a stored summary. Replies are not terse.

## Consequences

- The biggest expected saving comes from compaction and the prefix, about 30–35 % of card and worker cost. The register is worth about 1 %. These are estimates until the metric reports.
- `CLAUDE.md` shrinks to the never-traded rules, and its details move to `docs/` and skills.
- Low effort on CI-fix rounds can raise CI-fix attempts. The metric shows that, and the default is reverted if it does.
- Wrongly named Claude Code flags do nothing silently. Tests therefore measure the effect (the prefix size and the compaction env), not the flags.
