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
