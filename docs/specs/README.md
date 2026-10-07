# Specifications

One file per issue: `<issue>-<slug>.md`, written by `/code-sentinel:spec`
(`orchestrator.specDir` = `docs/specs`). A spec lands through its own docs pull
request before the issue receives `cs:ready`.

Order of work: [roadmap](../product/roadmap.md). Each roadmap row becomes one
spec; large rows split into a `## Parallel plan` there.

| Issue | Spec | Roadmap | Status |
|---|---|---|---|
| [#3](https://github.com/AndreyBegma/AgentDock/issues/3) | [3-auth-and-access](3-auth-and-access.md) | M1.1 Auth & access | queued |
| [#5](https://github.com/AndreyBegma/AgentDock/issues/5) | [5-runner-daemon-and-protocol](5-runner-daemon-and-protocol.md) | M1.3a Runner daemon & protocol | queued |
| [#6](https://github.com/AndreyBegma/AgentDock/issues/6) | [6-runner-pairing-gateway-and-admin](6-runner-pairing-gateway-and-admin.md) | M1.3b Pairing, gateway, admin | queued — after #3, #5 |
| [#8](https://github.com/AndreyBegma/AgentDock/issues/8) | [8-audit-log](8-audit-log.md) | M1.2 Audit log | queued — after #3, #6 |
| [#9](https://github.com/AndreyBegma/AgentDock/issues/9) | [9-application-shell-and-live-updates](9-application-shell-and-live-updates.md) | M1.8 Shell & live updates | queued — after #3, #6 |
| [#10](https://github.com/AndreyBegma/AgentDock/issues/10) | [10-projects](10-projects.md) | M1.4 Projects | queued — after #6, #9 |
| [#11](https://github.com/AndreyBegma/AgentDock/issues/11) | [11-fleet-observation](11-fleet-observation.md) | M1.5 Fleet observation | queued — after #10 |
| [#12](https://github.com/AndreyBegma/AgentDock/issues/12) | [12-agent-sessions](12-agent-sessions.md) | M1.6 Agent sessions | queued — after #10 |
| [#13](https://github.com/AndreyBegma/AgentDock/issues/13) | [13-tokens-and-cost](13-tokens-and-cost.md) | M1.7 Tokens & cost | queued — after #9, #10, #12 |
