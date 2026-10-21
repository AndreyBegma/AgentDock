# #740 — A command result survives a reconnect, a timed-out command stops, a repeated command runs once

Issue: https://github.com/AndreyBegma/Nautelle/issues/740 · Kind: bug · Found by: runner audit, 2026-10-21

## Summary

The runner executes typed commands from the API (ADR-0010) and answers each with a `command.result`. The audit found three defects, all confirmed on `develop` at `6b03ff4f`. Together they make state-changing commands unreliable whenever the WebSocket drops or a command runs long:

1. **The result is lost on reconnect.** `apps/runner/src/connection.ts:400-401` runs `dispatch(message).then((result) => this.send(result))`. `send()` returns `false` and drops the message when the socket is not `OPEN` (`connection.ts:470-474`) [Confirmed]. The API keeps its waiters on the connection object (`apps/api/src/runners/runner-connections.ts`, `expect` / `settle`), and `close()` calls `lostAll()`, which rejects them [Confirmed]. So a `card.merge`, `pr.open` or issue creation that finishes during a reconnect did its work, but is reported to the caller as failed.
2. **A timeout does not stop the work.** `apps/runner/src/commands/dispatcher.ts` `withTimeout` races the handler against a timer, and the handler gets no `AbortSignal` [Confirmed]. The caller gets `timeout` while the handler keeps running and keeps causing side effects.
3. **A repeated command runs twice.** Nothing deduplicates by command `id` [Confirmed: no id cache in `apps/runner/src/commands/**`]. A command sent again (a retry, or a resend after a reconnect) runs its side effects a second time: two pull requests, or two issues.

## Scope

### In scope
- Delivering `command.result` at least once across reconnects.
- Keeping the API's waiter for a command alive across a reconnect of the same runner, until the command's own deadline.
- Deduplicating by command id on the runner.
- Passing an `AbortSignal` to every handler, and aborting it on timeout.

### Out of scope
- Reconciling a result that arrives after the API's waiter has already given up, beyond recording it (see Decisions D4).
- Commands from runners on protocol versions older than this change. They keep today's behaviour.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | **Results go through the spool.** `command.result` is written to the runner's existing durable spool (`apps/runner/src/spool.ts`, seq + ack). It is no longer sent directly. It is delivered at least once, in order with events, and replayed after `welcome` like every spooled message. | orchestrator, from the audit; follows the spool's existing contract |
| D2 | **The API waiter belongs to the runner, not to the socket.** Pending waiters move from the per-connection object to a per-runner registry. A socket close no longer rejects them. Each waiter is rejected only when its own deadline passes, which is the command timeout the API already applies. A runner that does not reconnect before the deadline produces the same `lost` outcome as today. | orchestrator |
| D3 | **The runner deduplicates by id.** The dispatcher keeps an LRU map from command id to the in-flight promise or the finished result: 1 000 entries, 1 h TTL. A second message with a known id does not run the handler again. It re-sends the cached result once that result exists. The API side tolerates a duplicate `command.result`: `settle` returns `false` and the message is ignored. | orchestrator |
| D4 | **A result with no waiter is recorded.** When a `command.result` arrives and no waiter exists, the API logs it at `warn` with the command name, id and `ok`, and emits no event. Reconciliation is a later issue if the logs show it is needed. | orchestrator |
| D5 | **The timeout aborts the handler.** `withTimeout` creates an `AbortController` per command and passes `signal` to the handler as a second argument. A timeout aborts it. Handlers that spawn a process kill it on abort (`Bun.spawn` / `execa` `signal` option). A handler that cannot stop safely mid-way, such as a git push already in flight, checks `signal.aborted` between steps and returns. The caller still gets `timeout`, and the result the runner would have sent is dropped from the dedup cache, so a retry runs fresh. | orchestrator |
| D6 | **Protocol version.** Results through the spool and duplicate tolerance are a protocol change. Bump the minor protocol version, so an old API that still rejects waiters on close keeps working with a new runner: it receives the result late, `settle` returns `false`, and the result is ignored. Follow ADR-0073 for the version field. | ADR-0073 |

## Acceptance criteria

- [ ] Runner unit test: a command whose handler resolves while the socket is closed delivers its `command.result` after reconnect and `welcome`. The fake socket receives it exactly once, and the spool acks it.
- [ ] API unit test: closing a runner's connection does not settle its pending waiters. A `command.result` arriving on the new connection settles the waiter from before the close. A waiter whose deadline passes settles as `lost`.
- [ ] Runner unit test: the same command id dispatched twice runs the handler once, and both dispatches yield the same result. A third dispatch after the 1 h TTL runs the handler again (fake clock).
- [ ] Runner unit test: a handler that awaits past its timeout sees `signal.aborted === true`, and a child process it spawned is killed. The caller gets `timeout`.
- [ ] API unit test: a `command.result` with no waiter is logged at `warn` and does not throw.
- [ ] `bun run check`, `bun run test` and `bun run build` are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i740 | the runner dispatcher, connection and spool path, the API runner registry, the protocol version | apps/runner/src/connection.ts, apps/runner/src/connection.spec.ts, apps/runner/src/commands/**, apps/runner/src/spool.ts, apps/runner/src/spool.spec.ts, apps/runner/src/**/handlers*.ts, apps/runner/src/**/*.ts, apps/api/src/runners/**, packages/shared/src/protocol/** | — | yes | opus |

One slot. The runner and API halves must change together under one protocol version. The handlers' `signal` plumbing touches many runner files, so the slot owns `apps/runner/src/**`.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/protocol/** | i740 | #741 does not change the protocol |
| apps/runner/src/** | i740 | #741 owns only apps/runner/src/collectors/tmux/**, apps/runner/src/steward/** and apps/runner/src/control/orchestrator.ts. i740 must not open those |

## Risks

- **Medium: a handler is aborted halfway through a non-idempotent step.** Mitigation: D5 only checks `signal` between steps, and the dedup entry is dropped so a retry starts clean.
- **Low: spool growth.** Results are small and acked like events. The 100 MB cap is unchanged.

Depends on: nothing.
