# Specifications

One file per issue: `<issue>-<slug>.md`, written by `/code-sentinel:spec`
(`orchestrator.specDir` = `docs/specs`). A spec lands through its own docs pull
request before the issue receives `cs:ready`.

Order of work: [roadmap](../product/roadmap.md). Each roadmap row becomes one
spec; large rows split into a `## Parallel plan` there.

## Status

A spec is in one of three states:

- **queued** — the spec is on `develop`, the issue is open and no pull request
  for it has merged.
- **in progress** — at least one pull request for the issue has merged, or is
  open, and the issue is still open.
- **shipped** — the issue is closed and its code is on `develop`. The row links
  every merged pull request that delivered it.

**Updating a status is part of the work.** The pull request that closes a spec
issue (the last slot, when the spec is split) changes the row in this table in
the same diff: set the status and link the merged pull requests. A pull request
that only delivers a part of a spec moves the row to *in progress*. If the
status is not changed in that pull request, the index drifts — a reviewer should
ask for it.

## Index

| Issue | Spec | Roadmap | Depends on | Status |
|---|---|---|---|---|
| [#3](https://github.com/AndreyBegma/AgentDock/issues/3) | [3-auth-and-access](3-auth-and-access.md) | M1.1 Auth & access | — | shipped — [#30](https://github.com/AndreyBegma/AgentDock/pull/30), [#33](https://github.com/AndreyBegma/AgentDock/pull/33) |
| [#5](https://github.com/AndreyBegma/AgentDock/issues/5) | [5-runner-daemon-and-protocol](5-runner-daemon-and-protocol.md) | M1.3a Runner daemon & protocol | — | shipped — [#15](https://github.com/AndreyBegma/AgentDock/pull/15), [#32](https://github.com/AndreyBegma/AgentDock/pull/32) |
| [#6](https://github.com/AndreyBegma/AgentDock/issues/6) | [6-runner-pairing-gateway-and-admin](6-runner-pairing-gateway-and-admin.md) | M1.3b Pairing, gateway, admin | #3, #5 | shipped — [#34](https://github.com/AndreyBegma/AgentDock/pull/34), [#36](https://github.com/AndreyBegma/AgentDock/pull/36) |
| [#8](https://github.com/AndreyBegma/AgentDock/issues/8) | [8-audit-log](8-audit-log.md) | M1.2 Audit log | #3, #6 | shipped — [#39](https://github.com/AndreyBegma/AgentDock/pull/39), [#41](https://github.com/AndreyBegma/AgentDock/pull/41) |
| [#9](https://github.com/AndreyBegma/AgentDock/issues/9) | [9-application-shell-and-live-updates](9-application-shell-and-live-updates.md) | M1.8 Shell & live updates | #3, #6 | shipped — [#38](https://github.com/AndreyBegma/AgentDock/pull/38), [#40](https://github.com/AndreyBegma/AgentDock/pull/40) |
| [#10](https://github.com/AndreyBegma/AgentDock/issues/10) | [10-projects](10-projects.md) | M1.4 Projects | #6, #9 | shipped — [#42](https://github.com/AndreyBegma/AgentDock/pull/42), [#43](https://github.com/AndreyBegma/AgentDock/pull/43), [#44](https://github.com/AndreyBegma/AgentDock/pull/44) |
| [#11](https://github.com/AndreyBegma/AgentDock/issues/11) | [11-fleet-observation](11-fleet-observation.md) | M1.5 Fleet observation | #10 | shipped — [#46](https://github.com/AndreyBegma/AgentDock/pull/46), [#48](https://github.com/AndreyBegma/AgentDock/pull/48), [#49](https://github.com/AndreyBegma/AgentDock/pull/49) |
| [#12](https://github.com/AndreyBegma/AgentDock/issues/12) | [12-agent-sessions](12-agent-sessions.md) | M1.6 Agent sessions | #10 | shipped — [#45](https://github.com/AndreyBegma/AgentDock/pull/45), [#47](https://github.com/AndreyBegma/AgentDock/pull/47), [#50](https://github.com/AndreyBegma/AgentDock/pull/50) |
| [#13](https://github.com/AndreyBegma/AgentDock/issues/13) | [13-tokens-and-cost](13-tokens-and-cost.md) | M1.7 Tokens & cost | #9, #10, #12 | shipped — [#56](https://github.com/AndreyBegma/AgentDock/pull/56), [#57](https://github.com/AndreyBegma/AgentDock/pull/57), [#63](https://github.com/AndreyBegma/AgentDock/pull/63) |
| [#16](https://github.com/AndreyBegma/AgentDock/issues/16) | [16-consume-code-sentinel-events](16-consume-code-sentinel-events.md) | M2.1 Consume code-sentinel events | #11 (plugin#5) | shipped — [#54](https://github.com/AndreyBegma/AgentDock/pull/54), [#58](https://github.com/AndreyBegma/AgentDock/pull/58), [#61](https://github.com/AndreyBegma/AgentDock/pull/61) |
| [#17](https://github.com/AndreyBegma/AgentDock/issues/17) | [17-orchestrator-and-slot-control](17-orchestrator-and-slot-control.md) | M2.2 Orchestrator & slot control | #8, #10, #11 | shipped — [#51](https://github.com/AndreyBegma/AgentDock/pull/51), [#55](https://github.com/AndreyBegma/AgentDock/pull/55), [#59](https://github.com/AndreyBegma/AgentDock/pull/59), [#65](https://github.com/AndreyBegma/AgentDock/pull/65) |
| [#18](https://github.com/AndreyBegma/AgentDock/issues/18) | [18-live-worker-pane](18-live-worker-pane.md) | M2.3 Live worker pane | #9, #11 | shipped — [#52](https://github.com/AndreyBegma/AgentDock/pull/52), [#60](https://github.com/AndreyBegma/AgentDock/pull/60), [#62](https://github.com/AndreyBegma/AgentDock/pull/62), [#73](https://github.com/AndreyBegma/AgentDock/pull/73) |
| [#19](https://github.com/AndreyBegma/AgentDock/issues/19) | [19-task-queue](19-task-queue.md) | M2.4 Task queue | #10, #11 | shipped — [#53](https://github.com/AndreyBegma/AgentDock/pull/53), [#64](https://github.com/AndreyBegma/AgentDock/pull/64), [#69](https://github.com/AndreyBegma/AgentDock/pull/69) |
| [#20](https://github.com/AndreyBegma/AgentDock/issues/20) | [20-merge-approval-queue](20-merge-approval-queue.md) | M2.5 Merge approval queue | #11, #17 (plugin#8) | shipped — [#75](https://github.com/AndreyBegma/AgentDock/pull/75), [#86](https://github.com/AndreyBegma/AgentDock/pull/86), [#87](https://github.com/AndreyBegma/AgentDock/pull/87) |
| [#21](https://github.com/AndreyBegma/AgentDock/issues/21) | [21-activity-feed-and-history](21-activity-feed-and-history.md) | M2.6 Activity & history | #8, #11, #12 | shipped — [#70](https://github.com/AndreyBegma/AgentDock/pull/70), [#74](https://github.com/AndreyBegma/AgentDock/pull/74) |
| [#22](https://github.com/AndreyBegma/AgentDock/issues/22) | [22-notifications-and-telegram](22-notifications-and-telegram.md) | M2.7 Notifications & Telegram | #8, #9, #10, #11 | shipped — [#71](https://github.com/AndreyBegma/AgentDock/pull/71), [#79](https://github.com/AndreyBegma/AgentDock/pull/79), [#80](https://github.com/AndreyBegma/AgentDock/pull/80) |
| [#24](https://github.com/AndreyBegma/AgentDock/issues/24) | [24-skills](24-skills.md) | M3.1 Skills | #17, #21 | shipped — [#78](https://github.com/AndreyBegma/AgentDock/pull/78), [#88](https://github.com/AndreyBegma/AgentDock/pull/88), [#90](https://github.com/AndreyBegma/AgentDock/pull/90), [#95](https://github.com/AndreyBegma/AgentDock/pull/95) |
| [#25](https://github.com/AndreyBegma/AgentDock/issues/25) | [25-cron-schedules](25-cron-schedules.md) | M3.2 Cron schedules | #17, #24 | shipped — [#98](https://github.com/AndreyBegma/AgentDock/pull/98), [#104](https://github.com/AndreyBegma/AgentDock/pull/104) |
| [#26](https://github.com/AndreyBegma/AgentDock/issues/26) | [26-webhooks](26-webhooks.md) | M3.3 Webhooks | #8, #17, #21, #22, #24 | shipped — [#100](https://github.com/AndreyBegma/AgentDock/pull/100), [#108](https://github.com/AndreyBegma/AgentDock/pull/108), [#109](https://github.com/AndreyBegma/AgentDock/pull/109), [#111](https://github.com/AndreyBegma/AgentDock/pull/111) |
| [#27](https://github.com/AndreyBegma/AgentDock/issues/27) | [27-github-app](27-github-app.md) | M3.4 GitHub App | #11, #19, #26 | shipped — [#112](https://github.com/AndreyBegma/AgentDock/pull/112), [#113](https://github.com/AndreyBegma/AgentDock/pull/113), [#114](https://github.com/AndreyBegma/AgentDock/pull/114) |
| [#28](https://github.com/AndreyBegma/AgentDock/issues/28) | [28-budgets](28-budgets.md) | M3.5 Budgets | #13, #17, #22, #24 | shipped — [#105](https://github.com/AndreyBegma/AgentDock/pull/105), [#110](https://github.com/AndreyBegma/AgentDock/pull/110) |
| [#29](https://github.com/AndreyBegma/AgentDock/issues/29) | [29-terminal-attach](29-terminal-attach.md) | M3.6 Terminal attach | #8, #18 | shipped — [#76](https://github.com/AndreyBegma/AgentDock/pull/76), [#84](https://github.com/AndreyBegma/AgentDock/pull/84), [#89](https://github.com/AndreyBegma/AgentDock/pull/89), [#94](https://github.com/AndreyBegma/AgentDock/pull/94) |
| [#123](https://github.com/AndreyBegma/AgentDock/issues/123) | [123-schedules-on-bullmq](123-schedules-on-bullmq.md) | M3.2 rework: schedules on BullMQ (ADR-0015) | #99 | shipped — [#128](https://github.com/AndreyBegma/AgentDock/pull/128), [#129](https://github.com/AndreyBegma/AgentDock/pull/129) |
| [#160](https://github.com/AndreyBegma/AgentDock/issues/160) | [160-agent-workspace](160-agent-workspace.md) (data contract; the issue is the spec) | Agent workspace | #159, #163 | shipped — [#188](https://github.com/AndreyBegma/AgentDock/pull/188), [#191](https://github.com/AndreyBegma/AgentDock/pull/191), [#192](https://github.com/AndreyBegma/AgentDock/pull/192) |
| [#172](https://github.com/AndreyBegma/AgentDock/issues/172) | [172-planner](172-planner.md) | M3.7 Planner | #19, #21, #24, #28, #163 | shipped — [#175](https://github.com/AndreyBegma/AgentDock/pull/175), [#179](https://github.com/AndreyBegma/AgentDock/pull/179), [#180](https://github.com/AndreyBegma/AgentDock/pull/180), [#178](https://github.com/AndreyBegma/AgentDock/pull/178), [#177](https://github.com/AndreyBegma/AgentDock/pull/177) |
| [#223](https://github.com/AndreyBegma/AgentDock/issues/223) | [223-design-stage](223-design-stage.md) | M3.9 Design stage | #172, #24 | queued |
| [#282](https://github.com/AndreyBegma/AgentDock/issues/282) | [282-terminal-and-fleet-work-on-the-board](282-terminal-and-fleet-work-on-the-board.md) | Terminal work and fleet work on the Board (ADR-0030) | #281 | shipped — [#311](https://github.com/AndreyBegma/AgentDock/pull/311), [#312](https://github.com/AndreyBegma/AgentDock/pull/312), [#315](https://github.com/AndreyBegma/AgentDock/pull/315), [#317](https://github.com/AndreyBegma/AgentDock/pull/317), [#313](https://github.com/AndreyBegma/AgentDock/pull/313), [#318](https://github.com/AndreyBegma/AgentDock/pull/318) |
| [#309](https://github.com/AndreyBegma/AgentDock/issues/309) | [309-task-attachments](309-task-attachments.md) | Attachments on board cards | #282 (file contention) | shipped — [#314](https://github.com/AndreyBegma/AgentDock/pull/314), [#316](https://github.com/AndreyBegma/AgentDock/pull/316), [#320](https://github.com/AndreyBegma/AgentDock/pull/320), [#319](https://github.com/AndreyBegma/AgentDock/pull/319) |
| [#322](https://github.com/AndreyBegma/AgentDock/issues/322) | [322-card-profile-and-model-recommendation](322-card-profile-and-model-recommendation.md) | Profile and model at launch, recommended model (ADR-0032) | #282, #309 | shipped — [#343](https://github.com/AndreyBegma/AgentDock/pull/343), [#345](https://github.com/AndreyBegma/AgentDock/pull/345), [#357](https://github.com/AndreyBegma/AgentDock/pull/357), [#346](https://github.com/AndreyBegma/AgentDock/pull/346) |
| [#324](https://github.com/AndreyBegma/AgentDock/issues/324) | [324-deepl-translation-at-save](324-deepl-translation-at-save.md) | English at save time with DeepL (ADR-0033) | #271 | shipped — [#328](https://github.com/AndreyBegma/AgentDock/pull/328) |
| [#329](https://github.com/AndreyBegma/AgentDock/issues/329) | [329-card-pr-and-cleanup](329-card-pr-and-cleanup.md) | A card always reaches a PR; Accept cleans up its branch | #273, #282 | shipped — [#331](https://github.com/AndreyBegma/AgentDock/pull/331), [#333](https://github.com/AndreyBegma/AgentDock/pull/333), [#332](https://github.com/AndreyBegma/AgentDock/pull/332), [#339](https://github.com/AndreyBegma/AgentDock/pull/339) |
| [#335](https://github.com/AndreyBegma/AgentDock/issues/335) | [335-design-viewer-zoom](335-design-viewer-zoom.md) | Zoom in the design viewer (Fit, presets, Ctrl+wheel) | #223 | shipped — [#338](https://github.com/AndreyBegma/AgentDock/pull/338) |
| [#337](https://github.com/AndreyBegma/AgentDock/issues/337) | [337-planner-on-the-board](337-planner-on-the-board.md) | Planner on the Board: New Card interviews, New Plan makes cards (ADR-0034) | #172, #273, #309, #322 | queued |
| [#348](https://github.com/AndreyBegma/AgentDock/issues/348) | [348-card-hooks-hint-knows-the-plugin](348-card-hooks-hint-knows-the-plugin.md) | The card hooks hint knows whether the plugin is set up | #281 | queued |
| [#353](https://github.com/AndreyBegma/AgentDock/issues/353) | [353-survive-api-restart](353-survive-api-restart.md) | Web survives an API restart: banner, read retry, terminal reconnect | — | shipped — [#358](https://github.com/AndreyBegma/AgentDock/pull/358) |
| [#359](https://github.com/AndreyBegma/AgentDock/issues/359) | [359-card-ships-itself](359-card-ships-itself.md) | A card ships itself: draft PR, CI fix rounds, auto-merge (ADR-0035) | #329, #337 | queued |
| [#367](https://github.com/AndreyBegma/AgentDock/issues/367) | [367-card-sessions-always-wired](367-card-sessions-always-wired.md) | Card sessions carry hooks + finish_card without profile setup | #281 | queued |
| [#368](https://github.com/AndreyBegma/AgentDock/issues/368) | [368-staging-deploy-no-drops](368-staging-deploy-no-drops.md) | Staging deploy does not drop requests (Caddy retries) | — | queued |
